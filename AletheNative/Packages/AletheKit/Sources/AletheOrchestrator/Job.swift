import Foundation
import AletheIntegrations

/// One unit of delegated work (upstream `Job`), without its process: the core keeps live worker
/// handles apart, so a job is plain data that can be snapshotted, stored and restored.
public struct Job: Hashable, Sendable, Identifiable {
    public var id: String
    /// The terminal whose agent asked for the work; nil for calls from outside a terminal.
    public var plannerID: String?
    /// Which CLI runs the worker.
    public var agent: String
    /// One delegate call is one run.
    public var runID: String
    public var runLabel: String?
    /// The task text. User data: never logged.
    public var rulesName: String?
    public var model: String?
    public var effort: String?
    public var spec: String
    public var cwd: String
    public var status: JobStatus
    public var threadID: String?
    public var activeTurnID: String?
    /// The live stream of the current turn.
    public var reply: String = ""
    /// The worker's last finished message: the live reply opens with narration, this is the conclusion.
    public var report: String = ""
    public var plan: [String] = []
    /// Live only, never stored.
    public var diff: String?
    public var tokens: OrderedJSON?
    public var costUSD: Double?
    /// Live only, never stored.
    public var quota: OrderedJSON?
    public var outcome: String?
    /// Milliseconds since 1970.
    public var startedAt: UInt64?
    public var endedAt: UInt64?
    public var worktree: String?
    /// nil runs without a budget.
    public var timeoutMs: UInt64?
    /// The approval policy as JSON text (`"never"` or the granular object), as upstream stores it.
    public var approvalPolicy: String
    public var sandbox: String
    public var webSearch: Bool
    /// The request the worker is stopped on, with the rpc id it must be answered on.
    public var pending: OrderedJSON?
    /// Messages waiting to become the worker's next turns.
    public var inbox: [String] = []
    /// Why the worker ran on this agent, recorded only when one side was running out.
    public var routing: OrderedJSON?
    /// An interrupt this side asked for is in flight, so the turn it aborts is not announced.
    public var awaitingSteer = false
    public var nextRequestID = OrchestratorLimits.firstRequestID

    public static let defaultApprovalPolicy = "never"
    public static let defaultSandbox = "workspace-write"

    public init(
        id: String,
        plannerID: String?,
        agent: String,
        runID: String,
        runLabel: String?,
        spec: String,
        cwd: String,
        status: JobStatus = .queued,
        worktree: String? = nil,
        timeoutMs: UInt64? = OrchestratorLimits.defaultJobTimeoutMs,
        approvalPolicy: String = Job.defaultApprovalPolicy,
        sandbox: String = Job.defaultSandbox,
        webSearch: Bool = false
    ) {
        self.id = id
        self.plannerID = plannerID
        self.agent = agent
        self.runID = runID
        self.runLabel = runLabel
        self.spec = spec
        self.cwd = cwd
        self.status = status
        self.worktree = worktree
        self.timeoutMs = timeoutMs
        self.approvalPolicy = approvalPolicy
        self.sandbox = sandbox
        self.webSearch = webSearch
    }

    public var settled: Bool { status.settled }

    /// The approval policy as the value `thread/start` takes; unreadable text falls back to `never`.
    public var approvalPolicyValue: OrderedJSON {
        (try? OrderedJSON.parse(approvalPolicy)) ?? .string(Job.defaultApprovalPolicy)
    }

    /// Seconds since the job started, up to its end or `nowMs` while it runs.
    public func elapsedSeconds(nowMs: UInt64) -> Double? {
        guard let startedAt else { return nil }
        let end = endedAt ?? nowMs
        return Double(end >= startedAt ? end - startedAt : 0) / 1000
    }

    /// What the board and `alethe_status` see (upstream `Job::snapshot`).
    public func snapshot(nowMs: UInt64) -> JobSnapshot {
        JobSnapshot(
            id: id,
            plannerID: plannerID,
            agent: agent,
            runID: runID,
            runLabel: runLabel,
            spec: spec,
            cwd: cwd,
            status: status,
            threadID: threadID,
            outcome: outcome,
            seconds: elapsedSeconds(nowMs: nowMs),
            plan: plan,
            tokens: tokens,
            costUSD: costUSD,
            quota: quota,
            routing: routing,
            worktree: worktree,
            pendingApproval: pending,
            hasDiff: diff != nil,
            summary: orchestratorTail(report.isEmpty ? reply : report, limit: OrchestratorLimits.summaryLimit)
        )
    }

    /// What outlives the process (upstream `Job::record`), in `orchestrator-jobs.json`'s shape.
    public var record: OrderedJSON {
        var object: OrderedJSONObject = [
            "id": .string(id),
            "plannerId": .optional(plannerID),
            "agent": .string(agent),
            "runId": .string(runID),
            "runLabel": .optional(runLabel),
            "spec": .string(spec),
            "cwd": .string(cwd),
            "status": .string(status.rawValue),
            "threadId": .optional(threadID),
            "outcome": .optional(outcome),
            "plan": .array(plan.map(OrderedJSON.string)),
            "tokens": .optional(tokens),
            "costUsd": .optional(costUSD),
            "worktree": .optional(worktree),
            "approvalPolicy": .string(approvalPolicy),
            "sandbox": .string(sandbox),
            "webSearch": .bool(webSearch),
            "summary": .string(report),
            "startedAt": .optional(startedAt),
            "endedAt": .optional(endedAt),
        ]
        if let rulesName { object["rules"] = .string(rulesName) }
        if let model { object["model"] = .string(model) }
        if let effort { object["effort"] = .string(effort) }
        return .object(object)
    }

    /// A stored record brought back (upstream `Job::from_record`). Work that was in flight is
    /// restored as interrupted: its process is gone, showing it as running would be a lie.
    /// Nil without an id.
    public init?(record: OrderedJSON) {
        guard let object = record.objectValue, let id = object["id"]?.stringValue else { return nil }
        func text(_ key: String) -> String? { object[key]?.stringValue }
        // An unknown status reads as done, like a missing one: the record is history either way.
        var status = text("status").flatMap(JobStatus.init(rawValue:)) ?? .done
        if status == .running || status == .queued { status = .interrupted }
        self.init(
            id: id,
            plannerID: text("plannerId"),
            agent: text("agent") ?? WorkerAgent.codex,
            runID: text("runId") ?? "run-00",
            runLabel: text("runLabel"),
            spec: text("spec") ?? "",
            cwd: text("cwd") ?? "",
            status: status,
            worktree: text("worktree"),
            timeoutMs: OrchestratorLimits.defaultJobTimeoutMs,
            approvalPolicy: text("approvalPolicy") ?? Job.defaultApprovalPolicy,
            sandbox: text("sandbox") ?? Job.defaultSandbox,
            webSearch: object["webSearch"]?.boolValue ?? false
        )
        rulesName = text("rules")
        model = text("model")
        effort = text("effort")
        threadID = text("threadId")
        report = text("summary") ?? ""
        plan = object["plan"]?.arrayValue?.compactMap(\.stringValue) ?? []
        tokens = object["tokens"]?.nonNull
        costUSD = object["costUsd"]?.doubleValue
        outcome = text("outcome")
        startedAt = object["startedAt"]?.uint64Value
        endedAt = object["endedAt"]?.uint64Value
    }
}

/// A job as the board and the tools see it (upstream `Job::snapshot`, TS `OrchestratorJob`).
public struct JobSnapshot: Hashable, Sendable, Identifiable {
    public var id: String
    public var plannerID: String?
    public var agent: String
    public var runID: String
    public var runLabel: String?
    public var spec: String
    public var cwd: String
    public var status: JobStatus
    public var threadID: String?
    public var outcome: String?
    public var seconds: Double?
    public var plan: [String]
    /// `{ total, last, modelContextWindow }` for Codex, a token count for Claude.
    public var tokens: OrderedJSON?
    public var costUSD: Double?
    public var quota: OrderedJSON?
    public var routing: OrderedJSON?
    public var worktree: String?
    public var pendingApproval: OrderedJSON?
    public var hasDiff: Bool
    public var summary: String
    /// A planner's own subagent shown as a job (P6-11): it has no worker to steer or message.
    public var native: Bool

    public init(
        id: String,
        plannerID: String?,
        agent: String,
        runID: String,
        runLabel: String?,
        spec: String,
        cwd: String,
        status: JobStatus,
        threadID: String? = nil,
        outcome: String? = nil,
        seconds: Double? = nil,
        plan: [String] = [],
        tokens: OrderedJSON? = nil,
        costUSD: Double? = nil,
        quota: OrderedJSON? = nil,
        routing: OrderedJSON? = nil,
        worktree: String? = nil,
        pendingApproval: OrderedJSON? = nil,
        hasDiff: Bool = false,
        summary: String = "",
        native: Bool = false
    ) {
        self.id = id
        self.plannerID = plannerID
        self.agent = agent
        self.runID = runID
        self.runLabel = runLabel
        self.spec = spec
        self.cwd = cwd
        self.status = status
        self.threadID = threadID
        self.outcome = outcome
        self.seconds = seconds
        self.plan = plan
        self.tokens = tokens
        self.costUSD = costUSD
        self.quota = quota
        self.routing = routing
        self.worktree = worktree
        self.pendingApproval = pendingApproval
        self.hasDiff = hasDiff
        self.summary = summary
        self.native = native
    }

    /// Upstream's JSON, key for key and in its order; `native` only when set, as the frontend adds it.
    public var json: OrderedJSON {
        var object: OrderedJSONObject = [
            "id": .string(id),
            "plannerId": .optional(plannerID),
            "agent": .string(agent),
            "runId": .string(runID),
            "runLabel": .optional(runLabel),
            "spec": .string(spec),
            "cwd": .string(cwd),
            "status": .string(status.rawValue),
            "threadId": .optional(threadID),
            "outcome": .optional(outcome),
            "seconds": .optional(seconds),
            "plan": .array(plan.map(OrderedJSON.string)),
            "tokens": .optional(tokens),
            "costUsd": .optional(costUSD),
            "quota": .optional(quota),
            "routing": .optional(routing),
            "worktree": .optional(worktree),
            "pendingApproval": .optional(pendingApproval),
            "hasDiff": .bool(hasDiff),
            "summary": .string(summary),
        ]
        if native { object["native"] = .bool(true) }
        return .object(object)
    }
}

/// Everything the core holds at one moment (upstream `Inner::snapshot`).
public struct OrchestratorSnapshot: Hashable, Sendable {
    public var jobs: [JobSnapshot]
    public var planners: [Planner]
    public var running: Int
    public var queued: Int
    public var concurrencyLimit: Int

    public init(
        jobs: [JobSnapshot] = [],
        planners: [Planner] = [],
        running: Int = 0,
        queued: Int = 0,
        concurrencyLimit: Int = OrchestratorLimits.defaultConcurrency
    ) {
        self.jobs = jobs
        self.planners = planners
        self.running = running
        self.queued = queued
        self.concurrencyLimit = concurrencyLimit
    }

    public var json: OrderedJSON {
        [
            "jobs": .array(jobs.map(\.json)),
            "planners": .array(planners.map(\.json)),
            "running": .integer(running),
            "queued": .integer(queued),
            "concurrencyLimit": .integer(concurrencyLimit),
        ]
    }
}
