import Foundation

/// Dispatches deferred prompts through the same delegate path as immediate work.
public actor PromptQueue {
    public struct Context: Sendable {
        public var fitness: [String: AgentFitness]
        public var jobs: [Job]
        public var availableSlots: Int
        public init(fitness: [String: AgentFitness] = [:], jobs: [Job] = [], availableSlots: Int = 1) {
            self.fitness = fitness
            self.jobs = jobs
            self.availableSlots = availableSlots
        }
    }
    public typealias Read = @Sendable () async -> Context
    public typealias Delegate = @Sendable (QueueItem) async throws -> String
    public typealias Cancel = @Sendable (String) async -> Void

    private let store: PromptQueueStore?
    private let read: Read
    private let delegate: Delegate
    private let cancelJob: Cancel
    private var items: [QueueItem]
    private var lastSaved: [QueueItem]?
    private var timer: Task<Void, Never>?
    private var dispatching = false
    private var needsTick = false
    private var stopped = false
    private var forced: Set<String> = []
    private var starting: String?
    private var observers: [UUID: AsyncStream<[QueueItem]>.Continuation] = [:]
    public private(set) var persistenceError: String?
    private let unreadableStore: Bool

    public init(store: PromptQueueStore? = nil, read: @escaping Read,
                delegate: @escaping Delegate, cancel: @escaping Cancel = { _ in }) {
        self.store = store
        self.read = read
        self.delegate = delegate
        self.cancelJob = cancel
        do {
            items = try store?.load() ?? []
            lastSaved = items
            unreadableStore = false
        } catch {
            items = []
            unreadableStore = true
            persistenceError = String(describing: error)
        }
    }

    public func list() -> [QueueItem] {
        // Array position is the explicit drag/reorder order, and breaks equal-priority ties.
        items.enumerated().sorted {
            $0.element.priority == $1.element.priority ? $0.offset < $1.offset : $0.element.priority > $1.element.priority
        }.map(\.element)
    }

    public func snapshots() -> AsyncStream<[QueueItem]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: [QueueItem].self, bufferingPolicy: .bufferingNewest(1))
        if stopped {
            continuation.yield(list())
            continuation.finish()
            return stream
        }
        observers[id] = continuation
        continuation.yield(list())
        continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
        return stream
    }

    private func removeObserver(_ id: UUID) { observers[id] = nil }

    @discardableResult
    public func add(_ additions: [QueueItem]) async throws -> [QueueItem] {
        guard !stopped else { throw OrchestratorToolError("the queue is stopped") }
        guard additions.allSatisfy({ !$0.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            [WorkerAgent.codex, WorkerAgent.claude].contains($0.agent) && !$0.cwd.isEmpty })
        else { throw OrchestratorToolError("queue prompts, agents and working directories must be valid") }
        let incoming = Set(additions.map(\.id))
        guard incoming.count == additions.count, incoming.isDisjoint(with: Set(items.map(\.id))) else {
            throw OrchestratorToolError("queue IDs must be unique")
        }
        let previous = items
        items.append(contentsOf: additions)
        guard save() else {
            items = previous
            throw OrchestratorToolError("could not persist the prompt queue")
        }
        publish()
        await tick()
        return additions.compactMap { added in items.first { $0.id == added.id } }
    }

    public func cancel(_ ids: [String]) async {
        let selected = Set(ids)
        var jobs: [String] = []
        for index in items.indices where selected.contains(items[index].id) {
            if case .running(let job) = items[index].state { jobs.append(job) }
            let cancellable: Bool
            if case .running = items[index].state { cancellable = true }
            else { cancellable = items[index].state.pending }
            guard cancellable else { continue }
            items[index].state = .cancelled
            forced.remove(items[index].id)
        }
        _ = save()
        publish()
        for job in jobs { await cancelJob(job) }
        await tick()
    }

    public func runNow(_ ids: [String]) async {
        forced.formUnion(items.filter { ids.contains($0.id) && $0.state.pending }.map(\.id))
        await tick()
    }

    /// Explicit order overrides earlier priorities; unspecified items retain their relative order.
    public func reorder(_ ids: [String]) {
        let positions = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($0.element.id, $0.offset) })
        var seen: Set<String> = []
        let indices = ids.filter { seen.insert($0).inserted }.compactMap { positions[$0] }
        let selected = Set(indices)
        let reordered = indices.map { items[$0] } + items.enumerated().filter { !selected.contains($0.offset) }.map(\.element)
        items = reordered
        for index in items.indices { items[index].priority = 0 }
        _ = save()
        publish()
    }

    /// Fitness updates, job transitions and the nearest release/reset timer all arrive here.
    public func tick(now: Date = Date()) async {
        guard !stopped else { return }
        guard !dispatching else { needsTick = true; return }
        dispatching = true
        repeat {
            needsTick = false
            let context = await read()
            guard !stopped else { break }
            reconcile(context, now: now)
            let settled = Set(context.jobs.filter(\.settled).map(\.id))
            for candidate in list() where context.availableSlots > 0 {
                guard !stopped else { break }
                guard let index = items.firstIndex(where: { $0.id == candidate.id }), items[index].state.pending else { continue }
                let forcedRun = forced.contains(candidate.id)
                guard forcedRun || candidate.isEligible(now: now, fitness: context.fitness[candidate.agent], settledJobs: settled) else { continue }
                // Persist before invoking a side effect. Unknown in-flight launches after a crash
                // fail closed rather than automatically duplicating a prompt's writes.
                items[index].state = .running("")
                guard save() else { items[index].state = candidate.state; break }
                starting = candidate.id
                do {
                    let jobID = try await delegate(candidate)
                    if let current = items.firstIndex(where: { $0.id == candidate.id }) {
                        if items[current].state == .cancelled || stopped {
                            await cancelJob(jobID)
                        } else {
                            items[current].state = .running(jobID)
                        }
                    }
                } catch {
                    if let current = items.firstIndex(where: { $0.id == candidate.id }), items[current].state != .cancelled {
                        items[current].state = .failed
                    }
                }
                starting = nil
                forced.remove(candidate.id)
                _ = save()
                publish()
                needsTick = true
                break
            }
            _ = save()
            publish()
            schedule(now: now)
        } while needsTick && !stopped
        dispatching = false
    }

    private func reconcile(_ context: Context, now: Date) {
        let jobs = Dictionary(context.jobs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for index in items.indices {
            switch items[index].state {
            case .running(let id) where starting != items[index].id:
                guard let job = jobs[id] else { items[index].state = .failed; continue }
                guard job.settled else { continue }
                let text = job.report + "\n" + job.reply
                if job.status == .failed, QueueLimit.detected(in: text) {
                    let reset = QueueLimit.reset(in: text, now: now) ?? context.fitness[job.agent]?.resetsAt.flatMap { $0 > now ? $0 : nil }
                    items[index].state = .waitingLimit(reset)
                } else {
                    items[index].state = job.status == .cancelled ? .cancelled :
                        (job.status == .done || job.status == .released ? .done : .failed)
                }
            case .waitingLimit(let previous):
                if let fitness = context.fitness[items[index].agent], fitness.isStrained,
                   let reset = fitness.resetsAt, reset > now {
                    items[index].state = .waitingLimit(max(previous ?? reset, reset))
                }
            case .queued:
                if let fitness = context.fitness[items[index].agent], fitness.isStrained,
                   fitness.resetsAt.map({ $0 > now }) ?? true {
                    items[index].state = .waitingLimit(fitness.resetsAt)
                }
            default: break
            }
        }
    }

    /// The earliest future date, shared by the dispatcher and deterministic timer tests.
    public func nextWake(now: Date = Date()) -> Date? {
        items.filter { $0.state.pending }.flatMap { item -> [Date] in
            var dates: [Date] = []
            if case .waitingLimit(let date) = item.state, let date, date > now { dates.append(date) }
            if case .at(let date) = item.release, date > now { dates.append(date) }
            return dates
        }.min()
    }

    private func schedule(now: Date) {
        timer?.cancel()
        guard let date = nextWake(now: now), !stopped else { timer = nil; return }
        timer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, date.timeIntervalSinceNow))) }
            catch { return }
            await self?.tick()
        }
    }

    @discardableResult private func save() -> Bool {
        guard !unreadableStore else { return false }
        if lastSaved == items, persistenceError == nil { return true }
        do {
            try store?.save(items)
            lastSaved = items
            persistenceError = nil
            return true
        } catch {
            persistenceError = String(describing: error)
            return false
        }
    }

    private func publish() { for observer in observers.values { observer.yield(list()) } }

    public func shutdown() {
        stopped = true
        timer?.cancel()
        timer = nil
        _ = save()
        for observer in observers.values { observer.finish() }
        observers.removeAll()
    }
}
