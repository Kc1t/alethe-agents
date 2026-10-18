import Foundation
import AletheIntegrations

/// What one `alethe_delegate` call asks for.
public struct DelegateRequest: Hashable, Sendable {
    public var tasks: [String]
    /// Not validated here: an unconfigured agent fails its job later, through the normal delivery path.
    public var agent: String
    public var cwd: String
    public var label: String?
    /// nil runs without a budget.
    public var timeoutMs: UInt64?
    /// Codex workers stop and ask before reaching outside their workspace (P6-7).
    public var askForApproval: Bool
    public var webSearch: Bool
    /// One git worktree per job, made before the batch is accepted (P6-7).
    public var isolate: Bool
    public var rulesName: String?
    public var model: String?
    public var effort: String?
    public var readOnly: Bool

    public init(
        tasks: [String],
        agent: String = WorkerAgent.codex,
        cwd: String,
        label: String? = nil,
        timeoutMs: UInt64? = OrchestratorLimits.defaultJobTimeoutMs,
        askForApproval: Bool = false,
        webSearch: Bool = false,
        isolate: Bool = false,
        model: String? = nil, effort: String? = nil, readOnly: Bool = false, rulesName: String? = nil
    ) {
        self.tasks = tasks
        self.agent = agent
        self.cwd = cwd
        self.label = label
        self.timeoutMs = timeoutMs
        self.askForApproval = askForApproval
        self.webSearch = webSearch
        self.isolate = isolate
        self.rulesName = rulesName
        self.model = model; self.effort = effort; self.readOnly = readOnly
    }

    /// The tool's arguments, as upstream reads them: `cwd` falls back to the process's folder,
    /// `timeoutSeconds` 0 means no budget, the label is trimmed and dropped when empty.
    public init(arguments: OrderedJSONObject) throws(OrchestratorToolError) {
        let tasks = arguments["tasks"]?.arrayValue?.compactMap(\.stringValue) ?? []
        guard !tasks.isEmpty else { throw OrchestratorToolError("tasks must contain at least one instruction") }
        let cwd = arguments["cwd"]?.stringValue ?? FileManager.default.currentDirectoryPath
        let agent = arguments["agent"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? WorkerAgent.codex
        let label = arguments["label"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let timeoutMs: UInt64? = switch arguments["timeoutSeconds"]?.uint64Value {
        case 0: nil
        case let seconds?: seconds.multipliedReportingOverflow(by: 1000).overflow ? .max : seconds * 1000
        case nil: OrchestratorLimits.defaultJobTimeoutMs
        }
        self.init(
            tasks: tasks, agent: agent, cwd: cwd, label: label?.isEmpty == false ? label : nil, timeoutMs: timeoutMs,
            askForApproval: arguments["askForApproval"]?.boolValue ?? false,
            webSearch: arguments["webSearch"]?.boolValue ?? false,
            isolate: arguments["isolate"]?.boolValue ?? false,
            model: arguments["model"]?.stringValue, effort: arguments["effort"]?.stringValue,
            readOnly: arguments["readOnly"]?.boolValue ?? false, rulesName: arguments["rules"]?.stringValue
        )
    }
}

extension OrchestratorCore: OrchestratorToolHandler {
    public func callTool(name: String, arguments: OrderedJSONObject, planner: String?) async throws -> OrderedJSON {
        try await withFitness(dispatchTool(name: name, arguments: arguments, planner: planner), tool: name, arguments: arguments)
    }

    /// The tools this core answers (upstream `dispatch_tool`).
    func dispatchTool(name: String, arguments: OrderedJSONObject, planner: String?) async throws(OrchestratorToolError) -> OrderedJSON {
        switch name {
        case "alethe_delegate":
            let configured = try configuredArguments(arguments, planner: planner)
            let request = try DelegateRequest(arguments: configured)
            if arguments["queue"]?.boolValue == true, fitnessReadings[request.agent]?.isStrained == true {
                return try await enqueueDelegate(request, planner: planner)
            }
            return try await delegate(request, planner: planner)
        case "alethe_queue_add", "alethe_queue_list", "alethe_queue_cancel", "alethe_queue_run_now", "alethe_queue_reorder":
            return try await queueTool(name: name, arguments: arguments, planner: planner)
        case "alethe_check":
            return await check(
                wait: arguments["wait"]?.boolValue ?? false,
                untilAllSettled: arguments["untilAllSettled"]?.boolValue ?? true,
                timeoutMs: arguments["timeoutMs"]?.uint64Value ?? OrchestratorLimits.defaultCheckWaitMs
            )
        case "alethe_status":
            return snapshot().json
        case "alethe_cancel":
            return ["cancelled": .array(cancel(Self.jobIDs(arguments)).map(OrderedJSON.string))]
        case "alethe_release":
            return ["released": .array(release(Self.jobIDs(arguments)).map(OrderedJSON.string))]
        case "alethe_steer", "alethe_send", "alethe_answer", "alethe_diff":
            return try followUpTool(name: name, arguments: arguments)
        default:
            throw OrchestratorToolError("unknown tool \(name)")
        }
    }

    static func jobIDs(_ arguments: OrderedJSONObject) -> [String] {
        arguments["jobIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    // MARK: alethe_delegate

    /// Queues one job per task as one run and starts as many as the limit allows. Returns the
    /// tool's answer; the workers run on in the background. Ids are reserved first; worktrees
    /// (`isolate`) are made outside the actor's isolation, and the batch is accepted whole or not
    /// at all.
    public func delegate(_ request: DelegateRequest, planner: String?) async throws(OrchestratorToolError) -> OrderedJSON {
        guard !isShutDown else { throw OrchestratorToolError("the orchestrator is shutting down") }
        guard !request.tasks.isEmpty else { throw OrchestratorToolError("tasks must contain at least one instruction") }
        runCounter += 1
        let runID = OrchestratorID.run(runCounter)
        let ids = request.tasks.map { _ in
            jobCounter += 1
            return OrchestratorID.job(jobCounter)
        }
        let workspaces = try await workspaces(for: ids, request: request)
        guard !isShutDown else {
            await Self.removeWorktrees(workspaces, repo: request.cwd, worktrees: configuration.worktrees)
            throw OrchestratorToolError("the orchestrator is shutting down")
        }
        let policy = CodexApprovalPolicy.policy(askForApproval: request.askForApproval)
        var created: [OrderedJSON] = []
        for (index, spec) in request.tasks.enumerated() {
            let id = ids[index]
            let workspace = workspaces[index]
            jobs[id] = Job(
                id: id,
                plannerID: planner,
                agent: request.agent,
                runID: runID,
                runLabel: request.label,
                spec: spec,
                cwd: workspace.cwd,
                worktree: workspace.worktree,
                timeoutMs: request.timeoutMs,
                approvalPolicy: policy.approvalPolicy,
                sandbox: request.readOnly ? "read-only" : policy.sandbox,
                webSearch: request.webSearch
            )
            jobs[id]?.rulesName = request.rulesName
            jobs[id]?.model = request.model
            jobs[id]?.effort = request.effort
            order.append(id)
            queue.append(id)
            created.append(["id": .string(id), "spec": .string(spec), "worktree": .optional(workspace.worktree)])
        }
        notify()
        persist()
        drainQueue()
        return [
            "accepted": .integer(created.count),
            "runId": .string(runID),
            "runningInParallel": true,
            "concurrencyLimit": .integer(concurrencyLimit),
            "isolated": .bool(request.isolate),
            "timeoutSeconds": .optional(request.timeoutMs.map { $0 / 1000 }),
            "jobs": .array(created),
            "next": "call alethe_check with wait true",
        ]
    }

    // MARK: alethe_check

    /// Collects the deliveries. With `wait`, first waits until every worker settled (or, without
    /// `untilAllSettled`, until the first delivery), at most `timeoutMs` (capped at 600 s).
    public func check(wait: Bool, untilAllSettled: Bool = true, timeoutMs: UInt64 = OrchestratorLimits.defaultCheckWaitMs) async -> OrderedJSON {
        if wait {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .milliseconds(min(timeoutMs, OrchestratorLimits.maxWaitMs)))
            while isBusy, untilAllSettled || deliveries.isEmpty, clock.now < deadline, !Task.isCancelled {
                await waitForChange(until: deadline)
            }
        }
        let collected = deliveries
        deliveries.removeAll()
        let pending = slots.count + queue.count
        return [
            "deliveries": .array(collected.map(\.json)),
            "workersStillBusy": .integer(pending),
            "note": pending > 0
                ? "timed out with workers still running: call alethe_check again"
                : "every worker settled",
        ]
    }

    var isBusy: Bool { !slots.isEmpty || !queue.isEmpty }

    // MARK: alethe_cancel / alethe_release

    /// Stops each job that has not settled: the running turn is interrupted, the worker ended and
    /// the job settled as cancelled (announced like any other outcome). Returns the ids cancelled.
    @discardableResult
    public func cancel(_ jobIDs: [String]) -> [String] {
        var cancelled: [String] = []
        for jobID in jobIDs {
            guard var job = jobs[jobID], !job.settled else { continue }
            if workers[jobID] != nil {
                if job.agent == WorkerAgent.claude {
                    // `cancel_queued` also clears the CLI's own queue, so nothing it holds starts a
                    // turn between the abort and the teardown.
                    let interrupt = ClaudeWorkerProtocol.cancel(&job)
                    jobs[jobID] = job
                    writeToWorker(jobID, interrupt)
                } else if let interrupt = workers[jobID]?.codex?.interrupt() {
                    writeToWorker(jobID, interrupt)
                    syncRequestID(jobID)
                }
            }
            finishTurn(jobID, status: .cancelled, outcome: "cancelled", text: "cancelled by the lead", terminal: true)
            cancelled.append(jobID)
        }
        return cancelled
    }

    /// Lets go of each job that is not running a turn: its worker process ends, its record stays.
    /// Returns the ids released.
    @discardableResult
    public func release(_ jobIDs: [String]) -> [String] {
        var released: [String] = []
        for jobID in jobIDs {
            guard var job = jobs[jobID], job.status != .running else { continue }
            teardownWorker(jobID)
            queue.removeAll { $0 == jobID }
            slots.remove(jobID)
            job.status = .released
            job.pending = nil
            job.activeTurnID = nil
            if job.endedAt == nil { job.endedAt = Self.nowMs() }
            jobs[jobID] = job
            released.append(jobID)
        }
        notify()
        if !released.isEmpty {
            persist()
            signal()
            drainQueue()
        }
        return released
    }
}
