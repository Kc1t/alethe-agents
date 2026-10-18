import Darwin
import Foundation
import AletheFoundation
import AletheGit
import AletheModel
import AletheIntegrations

/// The delegation core (upstream `Core`): jobs, the FIFO queue drained as slots free, worker
/// processes and their protocols, deliveries for `alethe_check`, the watchdog, parking and
/// persistence. Free of the app, so the app service and the stdio helper host the same code.
///
/// Worker I/O never happens inside this actor's isolation: lines go out through each worker's own
/// `WorkerLineWriter` queue, spawning and teardown run in detached tasks, git runs off the actor.
/// A stuck worker therefore never holds up another one, nor the core.
public actor OrchestratorCore {
    public struct Configuration: Sendable {
        public var launchers: WorkerLaunchers
        public var concurrencyLimit: Int
        /// Where the job history is kept; nil keeps it in memory only.
        public var store: OrchestratorJobStore?
        /// Where live workers are recorded so a crash never leaves one running.
        public var registry: WorkerRegistry?
        /// The whole environment a worker starts with. Never logged.
        public var environment: @Sendable (Launcher) -> [String: String]
        /// A Claude worker's diff after a turn (upstream `git diff HEAD` in its folder).
        public var uncommittedDiff: @Sendable (_ cwd: String) async -> String?
        public var terminationGrace: Duration
        /// Makes and removes `isolate` worktrees (P6-7).
        public var worktrees: GitWorktrees

        public init(
            launchers: WorkerLaunchers = WorkerLaunchers(),
            concurrencyLimit: Int = OrchestratorLimits.defaultConcurrency,
            store: OrchestratorJobStore? = nil,
            registry: WorkerRegistry? = nil,
            environment: @escaping @Sendable (Launcher) -> [String: String] = OrchestratorCore.defaultEnvironment,
            uncommittedDiff: @escaping @Sendable (String) async -> String? = { await ClaudeWorkerProtocol.uncommittedDiff(in: $0) },
            terminationGrace: Duration = WorkerProcess.terminationGrace,
            worktrees: GitWorktrees = GitWorktrees()
        ) {
            self.launchers = launchers
            self.concurrencyLimit = concurrencyLimit
            self.store = store
            self.registry = registry
            self.environment = environment
            self.uncommittedDiff = uncommittedDiff
            self.terminationGrace = terminationGrace
            self.worktrees = worktrees
        }
    }

    /// The current `PATH` as the worker's search path, on top of the clean environment.
    public static let defaultEnvironment: @Sendable (Launcher) -> [String: String] = { launcher in
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        return WorkerEnvironment.make(for: launcher, searchDirectories: path.split(separator: ":").map(String.init))
    }

    /// A live worker process and the protocol state that goes with it.
    struct WorkerHandle {
        let process: WorkerProcess
        let generation: UInt64
        /// Codex only; Claude's protocol state lives on the job.
        var codex: CodexWorkerSession?
        var pump: Task<Void, Never>?
        var watchdog: Task<Void, Never>?
    }

    // State is internal so the P6-7/P6-8 extensions in their own files can build on it.
    var workerRuleSets: [WorkerRuleSet] = []
    var orchestrationSettings = OrchestrationPreferences()
    var configuration: Configuration
    var launchers: WorkerLaunchers
    var jobs: [String: Job] = [:]
    /// Creation order: snapshots, persistence and parking follow it.
    var order: [String] = []
    var queue: [String] = []
    /// Jobs holding a concurrency slot (running or blocked).
    var slots: Set<String> = []
    var deliveries: [Delivery] = []
    var deliverySequence: UInt64 = 0
    var concurrencyLimit: Int
    var jobCounter: UInt64 = 0
    var runCounter: UInt64 = 0
    var planners: [Planner] = []
    var workers: [String: WorkerHandle] = [:]
    /// Jobs whose process is being spawned, with the generation the spawn belongs to.
    var spawning: [String: UInt64] = [:]
    var spawnTasks: [UInt64: Task<Void, Never>] = [:]
    var generationCounter: UInt64 = 0
    var terminations: [UInt64: Task<Void, Never>] = [:]
    var terminationCounter: UInt64 = 0
    var isShutDown = false
    /// Per-agent usage fitness (P6-8, `OrchestratorCore+Fitness`).
    var fitnessReadings: [String: AgentFitness] = [:]
    var deferredPrompts: PromptQueue?

    private var observers: [UInt64: AsyncStream<OrchestratorSnapshot>.Continuation] = [:]
    private var observerCounter: UInt64 = 0
    private var changeWaiters: [UInt64: CheckedContinuation<Void, Never>] = [:]
    private var waiterCounter: UInt64 = 0

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        self.launchers = configuration.launchers
        self.concurrencyLimit = Self.clampedLimit(configuration.concurrencyLimit)
    }

    static func clampedLimit(_ limit: Int) -> Int {
        min(max(limit, OrchestratorLimits.concurrencyRange.lowerBound), OrchestratorLimits.concurrencyRange.upperBound)
    }

    static func nowMs() -> UInt64 { CodexWorkerSession.currentMilliseconds() }

    // MARK: Setup

    /// Adopts the previous session's history from the store (upstream `restore`): in-flight work
    /// comes back interrupted and new ids count on past every restored one. Nil without a store.
    @discardableResult
    public func restore() -> OrchestratorRestore.Outcome? {
        guard let store = configuration.store else { return nil }
        let restored = store.restore()
        for job in restored.jobs where jobs[job.id] == nil {
            jobs[job.id] = job
            order.append(job.id)
        }
        for planner in restored.planners { upsert(planner) }
        jobCounter = max(jobCounter, restored.jobCounter)
        runCounter = max(runCounter, restored.runCounter)
        let prompts = promptQueue()
        Task { await prompts.tick() }
        notify()
        return restored.outcome
    }

    /// One per agent terminal, so a run can name the session that asked for it.
    public func registerPlanner(_ planner: Planner) {
        upsert(planner)
        notify()
        persist()
    }

    public func setLauncher(_ launcher: Launcher) {
        launchers.set(launcher)
    }

    public func setLaunchers(_ launchers: WorkerLaunchers) {
        self.launchers = launchers
    }

    /// Clamped to 1…16; a raised limit starts queued work at once.
    public func setConcurrencyLimit(_ limit: Int) {
        concurrencyLimit = Self.clampedLimit(limit)
        notify()
        drainQueue()
    }

    private func upsert(_ planner: Planner) {
        if let index = planners.firstIndex(where: { $0.id == planner.id }) {
            planners[index] = planner
        } else {
            planners.append(planner)
        }
    }

    // MARK: Reading

    public func snapshot() -> OrchestratorSnapshot {
        let now = Self.nowMs()
        return OrchestratorSnapshot(
            jobs: order.compactMap { jobs[$0]?.snapshot(nowMs: now) },
            planners: planners,
            running: slots.count,
            queued: queue.count,
            concurrencyLimit: concurrencyLimit
        )
    }

    /// Running and queued counts.
    public func counts() -> (running: Int, queued: Int) {
        (slots.count, queue.count)
    }

    public func job(_ id: String) -> Job? { jobs[id] }

    /// Every state change as a snapshot, starting with the current one. Yielding never waits on the
    /// consumer (upstream's observer channel); a slow one only loses the oldest buffered snapshots.
    public func snapshots(
        bufferingPolicy: AsyncStream<OrchestratorSnapshot>.Continuation.BufferingPolicy = .bufferingNewest(64)
    ) -> AsyncStream<OrchestratorSnapshot> {
        let (stream, continuation) = AsyncStream.makeStream(of: OrchestratorSnapshot.self, bufferingPolicy: bufferingPolicy)
        observerCounter += 1
        let id = observerCounter
        observers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        continuation.yield(snapshot())
        return stream
    }

    private func removeObserver(_ id: UInt64) {
        observers[id] = nil
    }

    func notify() {
        if let deferredPrompts { Task { await deferredPrompts.tick() } }
        guard !observers.isEmpty else { return }
        let current = snapshot()
        for continuation in observers.values { continuation.yield(current) }
    }

    /// Written on transitions, never on streamed tokens; the store coalesces and writes off-actor.
    func persist() {
        configuration.store?.persist(jobs: order.compactMap { jobs[$0] }, planners: planners)
    }

    func pushDelivery(kind: String, jobID: String, outcome: String?, text: String) {
        deliverySequence += 1
        deliveries.append(Delivery(sequence: deliverySequence, kind: kind, jobID: jobID, outcome: outcome, text: text))
    }

    /// Wakes every `alethe_check` waiting for a change (upstream `signal.notify_all`).
    func signal() {
        let waiting = changeWaiters
        changeWaiters.removeAll()
        for continuation in waiting.values { continuation.resume() }
    }

    /// Suspends until the next `signal()`, `deadline` or cancellation, whichever comes first.
    func waitForChange(until deadline: ContinuousClock.Instant) async {
        waiterCounter += 1
        let id = waiterCounter
        let timer = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            await self?.resumeWaiter(id)
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled {
                    continuation.resume()
                } else {
                    changeWaiters[id] = continuation
                }
            }
        } onCancel: {
            Task { await self.resumeWaiter(id) }
        }
        timer.cancel()
    }

    private func resumeWaiter(_ id: UInt64) {
        changeWaiters.removeValue(forKey: id)?.resume()
    }

    // MARK: Queue and workers

    /// Starts queued jobs while slots are free (upstream `drain_queue`).
    func drainQueue() {
        while !isShutDown, slots.count < concurrencyLimit, !queue.isEmpty {
            let jobID = queue.removeFirst()
            guard jobs[jobID]?.status == .queued else { continue }
            spawnWorker(jobID)
        }
    }

    /// Takes a slot for `jobID` and starts its worker (upstream `spawn_worker`). The process is
    /// spawned off the actor; `attach` picks it up. An unknown agent fails the job through the
    /// normal delivery path.
    func spawnWorker(_ jobID: String) {
        guard var job = jobs[jobID] else { return }
        job.status = .running
        job.startedAt = Self.nowMs()
        job.endedAt = nil
        // Work that arrived while the worker was down leads; otherwise this is its first turn.
        let rules = (try? workerRulesBlock(named: job.rulesName)) ?? ((try? workerRulesBlock(named: nil)) ?? "")
        let firstTurn = rules + (job.inbox.isEmpty ? job.spec : job.inbox.removeFirst())
        jobs[jobID] = job
        slots.insert(jobID)

        let launcher: Launcher
        do {
            launcher = try launchers.launcher(for: job.agent)
        } catch {
            finishTurn(jobID, status: .failed, outcome: "failed", text: error.description, terminal: true)
            return
        }

        generationCounter += 1
        let generation = generationCounter
        spawning[jobID] = generation
        var arguments = launcher.arguments(resuming: job.agent == WorkerAgent.claude ? job.threadID : nil)
        if job.agent == WorkerAgent.claude {
            if let model = job.model { arguments += ["--model", model] }
            if let effort = job.effort { arguments += ["--effort", effort] }
        }
        let environment = configuration.environment(launcher)
        let directory = URL(filePath: job.cwd, directoryHint: .isDirectory)
        let registry = configuration.registry
        let grace = configuration.terminationGrace
        spawnTasks[generation] = Task.detached { [weak self] in
            let result: Result<WorkerProcess, WorkerProcessError>
            do throws(WorkerProcessError) {
                result = .success(try WorkerProcess.spawn(
                    launcher, in: directory, arguments: arguments, environment: environment,
                    jobID: jobID, registry: registry, grace: grace))
            } catch {
                result = .failure(error)
            }
            if let self {
                await self.attach(jobID, generation: generation, firstTurn: firstTurn, result: result)
            } else if case .success(let process) = result {
                await process.terminate()
            }
        }
        notify()
    }

    /// A spawned process joins its job, unless the job moved on meanwhile (cancelled, released,
    /// shut down): then the process is ended at once.
    private func attach(_ jobID: String, generation: UInt64, firstTurn: String,
                        result: Result<WorkerProcess, WorkerProcessError>) {
        spawnTasks[generation] = nil
        let current = spawning[jobID] == generation
        if current { spawning[jobID] = nil }
        let process: WorkerProcess
        switch result {
        case .failure(let error):
            if current {
                finishTurn(jobID, status: .failed, outcome: "failed", text: error.description, terminal: true)
            }
            return
        case .success(let spawned):
            process = spawned
        }
        guard current, var job = jobs[jobID], !job.settled else {
            terminate(process)
            return
        }

        var handle = WorkerHandle(process: process, generation: generation)
        if job.agent == WorkerAgent.claude {
            // No handshake: the first line written is the first turn.
            process.writer.send(ClaudeWorkerProtocol.userTurn(firstTurn))
        } else {
            let session = CodexWorkerSession(job: job, firstTurn: firstTurn, disabledPlugins: orchestrationSettings.workerDisabledPlugins)
            for message in session.handshake() { process.writer.send(message) }
            handle.codex = session
        }
        if let timeoutMs = job.timeoutMs {
            handle.watchdog = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(timeoutMs))
                guard !Task.isCancelled else { return }
                await self?.watchdogFired(jobID, generation: generation, timeoutMs: timeoutMs)
            }
        }
        handle.pump = Task.detached { [weak self] in
            for await message in process.lines {
                guard let self else { return }
                await self.receive(message, jobID: jobID, generation: generation)
            }
            await self?.workerExited(jobID, generation: generation)
        }
        workers[jobID] = handle
        job.nextRequestID = handle.codex?.nextRequestID ?? job.nextRequestID
        jobs[jobID] = job
        notify()
    }

    /// One line of a worker's stdout, in order (the pump awaits each before the next).
    private func receive(_ message: OrderedJSON, jobID: String, generation: UInt64) async {
        guard let handle = workers[jobID], handle.generation == generation, jobs[jobID] != nil else { return }
        if let limit = QueueLimit.workerMessage(message) {
            finishTurn(jobID, status: .failed, outcome: "failed", text: limit, terminal: true)
            return
        }
        if handle.codex != nil {
            receiveCodex(message, jobID: jobID, handle: handle)
        } else {
            await receiveClaude(message, jobID: jobID, generation: generation)
        }
    }

    private func receiveCodex(_ message: OrderedJSON, jobID: String, handle: WorkerHandle) {
        guard var session = handle.codex, var job = jobs[jobID] else { return }
        let step = session.receive(message)
        var changed = false
        var asked = false
        var ended: (succeeded: Bool, summary: String)?
        for event in step.events {
            job.apply(event)
            switch event {
            case .replyDelta, .requestFailed:
                // Deltas stream; upstream publishes no snapshot for them. A failed request of ours
                // is ignored, as upstream does.
                break
            case .approvalRequested:
                asked = true
                changed = true
            case .turnEnded(let succeeded, let summary):
                ended = (succeeded, summary)
            default:
                changed = true
            }
        }
        job.nextRequestID = session.nextRequestID
        jobs[jobID] = job
        workers[jobID]?.codex = session
        for outgoing in step.outgoing { handle.process.writer.send(outgoing) }

        if let ended {
            finishTurn(jobID, status: ended.succeeded ? .done : .failed,
                       outcome: ended.succeeded ? "succeeded" : "failed", text: ended.summary, terminal: false)
        } else if changed {
            notify()
        }
        if asked { signal() }
    }

    private func receiveClaude(_ message: OrderedJSON, jobID: String, generation: UInt64) async {
        guard var job = jobs[jobID] else { return }
        let event = ClaudeWorkerProtocol.handle(message, job: &job)
        jobs[jobID] = job
        switch event {
        case .ignored:
            return
        case .updated:
            notify()
        case .turnEnded(let end):
            // Git runs off the actor; the pump waits, so no later line overtakes this turn's end.
            let diff = await configuration.uncommittedDiff(job.cwd)
            guard workers[jobID]?.generation == generation else { return }
            if let diff { jobs[jobID]?.diff = diff }
            finishTurn(jobID, status: end.status, outcome: end.outcome, text: end.text,
                       terminal: false, announce: end.announce)
        }
    }

    /// The worker closed its stdout: its process is gone. A job still working fails like upstream
    /// ("worker connection closed"); a parked one simply stops being parked.
    private func workerExited(_ jobID: String, generation: UInt64) {
        guard workers[jobID]?.generation == generation else { return }
        if let job = jobs[jobID], !job.settled {
            finishTurn(jobID, status: .failed, outcome: "failed", text: "worker connection closed", terminal: true)
        } else {
            teardownWorker(jobID)
            notify()
        }
    }

    /// A worker that never finishes its turn would hold a slot forever (upstream `arm_watchdog`).
    private func watchdogFired(_ jobID: String, generation: UInt64, timeoutMs: UInt64) {
        guard workers[jobID]?.generation == generation, let job = jobs[jobID], !job.settled else { return }
        if let interrupt = workers[jobID]?.codex?.interrupt() {
            writeToWorker(jobID, interrupt)
            syncRequestID(jobID)
        }
        finishTurn(jobID, status: .failed, outcome: "timeout",
                   text: "worker passed its \(timeoutMs / 1000)s budget and was stopped", terminal: true)
    }

    /// Queues one line for a live worker; a no-op when it has none.
    func writeToWorker(_ jobID: String, _ message: OrderedJSON) {
        workers[jobID]?.process.writer.send(message)
    }

    /// Keeps the job's request counter in step with its Codex session.
    func syncRequestID(_ jobID: String) {
        if let next = workers[jobID]?.codex?.nextRequestID { jobs[jobID]?.nextRequestID = next }
    }

    var parkedJobIDs: [String] {
        order.filter { id in workers[id] != nil && jobs[id]?.settled == true }
    }

    /// Ends a job's worker (if any), off the actor, and forgets it.
    func teardownWorker(_ jobID: String) {
        spawning[jobID] = nil
        guard let handle = workers.removeValue(forKey: jobID) else { return }
        handle.watchdog?.cancel()
        handle.pump?.cancel()
        terminate(handle.process)
    }

    /// Terminates and reaps `process` in the background; `shutdown()` waits for every one.
    func terminate(_ process: WorkerProcess) {
        terminationCounter += 1
        let id = terminationCounter
        terminations[id] = Task.detached { [weak self] in
            await process.terminate()
            await self?.terminationFinished(id)
        }
    }

    private func terminationFinished(_ id: UInt64) {
        terminations[id] = nil
    }

    /// Finished workers stay alive for follow-ups, but each one is a process: past the limit the
    /// earliest created is let go (upstream `release_oldest_parked`). Its record stays.
    private func releaseOldestParked() {
        var parked = parkedJobIDs
        while parked.count > OrchestratorLimits.parkedLimit {
            let oldest = parked.removeFirst()
            teardownWorker(oldest)
            jobs[oldest]?.status = .released
        }
    }

    /// Settles a turn (upstream `finish` / `finish_turn`). `terminal` ends the worker process; a
    /// completed turn keeps it parked for follow-ups. `announce` is false for the turn that only
    /// acknowledges an interrupt this side asked for. Anything sent while the worker was busy goes
    /// out now as its next turn, on the slot it just gave back.
    func finishTurn(
        _ jobID: String,
        status: JobStatus,
        outcome: String?,
        text: String,
        terminal: Bool,
        announce: Bool = true
    ) {
        guard var job = jobs[jobID], !job.settled else { return }
        job.status = status
        if status == .failed, QueueLimit.detected(in: text + "\n" + job.reply) {
            var fitness = fitnessReadings[job.agent] ?? AgentFitness(worst: "limit", used: 100)
            fitness.rateLimited = true
            fitness.resetsAt = QueueLimit.reset(in: text + "\n" + job.reply) ?? fitness.resetsAt.flatMap { $0 > Date() ? $0 : nil }
            fitnessReadings[job.agent] = fitness
        }
        job.pending = nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { job.report = trimmed }
        job.outcome = outcome
        job.endedAt = Self.nowMs()
        job.activeTurnID = nil
        jobs[jobID] = job
        queue.removeAll { $0 == jobID }
        slots.remove(jobID)
        if terminal { teardownWorker(jobID) }
        if announce { pushDelivery(kind: "worker_done", jobID: jobID, outcome: outcome, text: text) }

        if !terminal, !isShutDown, let next = nextTurnFromInbox(jobID) {
            jobs[jobID]?.status = .running
            jobs[jobID]?.outcome = nil
            jobs[jobID]?.endedAt = nil
            jobs[jobID]?.reply = ""
            jobs[jobID]?.report = ""
            slots.insert(jobID)
            writeToWorker(jobID, next)
        } else {
            releaseOldestParked()
        }
        notify()
        persist()
        signal()
        drainQueue()
    }

    /// The next queued message as a fresh turn on the worker's own thread (upstream
    /// `next_from_inbox`); nil without a live worker, a thread or a message.
    func nextTurnFromInbox(_ jobID: String) -> OrderedJSON? {
        guard var job = jobs[jobID], workers[jobID] != nil, job.threadID != nil, !job.inbox.isEmpty else { return nil }
        if job.agent == WorkerAgent.claude {
            let turn = ClaudeWorkerProtocol.nextTurn(&job)
            jobs[jobID] = job
            return turn
        }
        guard var session = workers[jobID]?.codex else { return nil }
        let text = job.inbox.removeFirst()
        guard let turn = try? session.startTurn(text) else { return nil }
        job.nextRequestID = session.nextRequestID
        jobs[jobID] = job
        workers[jobID]?.codex = session
        return turn
    }

    // MARK: Shutdown

    /// Ends every worker and waits until each is reaped, then writes the history to disk. Work
    /// still in flight is marked interrupted (its thread survives on disk and can be resumed); no
    /// new work starts afterwards.
    public func shutdown() async {
        isShutDown = true
        await deferredPrompts?.shutdown()
        for jobID in queue { jobs[jobID]?.status = .interrupted }
        queue.removeAll()
        let live = Set(workers.keys).union(spawning.keys).union(slots)
        for jobID in live {
            teardownWorker(jobID)
            if let job = jobs[jobID], !job.settled {
                jobs[jobID]?.status = .interrupted
                jobs[jobID]?.pending = nil
                jobs[jobID]?.activeTurnID = nil
            }
        }
        slots.removeAll()
        notify()
        persist()
        signal()
        // Spawns in flight attach (and are ended) first, then every teardown is awaited.
        while let (key, spawn) = spawnTasks.first {
            await spawn.value
            spawnTasks[key] = nil
        }
        while let (key, termination) = terminations.first {
            await termination.value
            terminations[key] = nil
        }
        await configuration.store?.flush()
    }

    /// Pids of the live worker processes (tests, diagnostics).
    public var workerPIDs: [pid_t] { workers.values.map(\.process.pid) }
}
