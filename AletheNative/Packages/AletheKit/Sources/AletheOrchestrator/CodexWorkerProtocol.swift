import Foundation
import AletheIntegrations

/// What a Codex `app-server` worker told the core (upstream `on_worker_message` / `on_worker_request`).
public enum CodexWorkerEvent: Hashable, Sendable {
    /// `thread/start` or `thread/resume` answered: the thread the worker's turns run on.
    case threadReady(threadID: String)
    case turnStarted(turnID: String?)
    /// A piece of the live reply (`item/agentMessage/delta`).
    case replyDelta(String)
    /// A finished agent message (`item/completed`): the latest one is the worker's report.
    case report(String)
    case planUpdated([String])
    case diffUpdated(String?)
    case tokensUpdated(OrderedJSON?)
    /// The worker stopped on a question; it waits until `answer(_:)` is sent.
    case approvalRequested(CodexApprovalRequest)
    /// `turn/completed` or `turn/failed`, with the report (or the reply's end when there is none).
    case turnEnded(succeeded: Bool, summary: String)
    /// A request of ours came back with an error. Upstream ignores these; the core may too.
    case requestFailed(id: OrderedJSON, message: String)
}

/// A question the worker is stopped on, kept with the rpc id it must be answered on.
public struct CodexApprovalRequest: Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        case command
        case fileChange
    }

    public var rpcID: OrderedJSON
    public var kind: Kind
    /// Task-derived data: never logged.
    public var command: String?
    public var cwd: String?
    public var reason: String?
    public var askedAtMs: UInt64

    public init(rpcID: OrderedJSON, kind: Kind, command: String?, cwd: String?, reason: String?, askedAtMs: UInt64) {
        self.rpcID = rpcID
        self.kind = kind
        self.command = command
        self.cwd = cwd
        self.reason = reason
        self.askedAtMs = askedAtMs
    }

    /// Upstream's `pending` value (`Job.pending`, the snapshot's `pendingApproval`).
    public var json: OrderedJSON {
        [
            "rpcId": rpcID,
            "kind": .string(kind.rawValue),
            "command": .optional(command),
            "cwd": .optional(cwd),
            "reason": .optional(reason),
            "askedAtMs": .unsigned(askedAtMs),
        ]
    }
}

/// The answers a worker's approval request accepts.
public enum CodexApprovalDecision: String, Hashable, Sendable, CaseIterable {
    case accept
    case acceptForSession
    case decline
    case abort
}

/// What `alethe_delegate`'s `askForApproval` turns into (upstream `dispatch_tool`).
public enum CodexApprovalPolicy {
    /// The policy as `Job.approvalPolicy` stores it (JSON text) and the sandbox, which stays
    /// `workspace-write` either way: a read-only worker gives up instead of asking.
    public static func policy(askForApproval: Bool) -> (approvalPolicy: String, sandbox: String) {
        guard askForApproval else {
            return (OrderedJSON.string(Job.defaultApprovalPolicy).compactRendered(), Job.defaultSandbox)
        }
        // The granular form names the callbacks this client answers, so the worker routes its
        // question here instead of giving up on it.
        let granular: OrderedJSON = [
            "granular": [
                "sandbox_approval": true,
                "request_permissions": true,
                "rules": true,
                "skill_approval": true,
                "mcp_elicitations": true,
            ],
        ]
        return (granular.compactRendered(), Job.defaultSandbox)
    }
}

/// What handling one worker line produced: messages to write back (in order) and events for the core.
public struct CodexWorkerStep: Hashable, Sendable {
    public var outgoing: [OrderedJSON]
    public var events: [CodexWorkerEvent]

    public init(outgoing: [OrderedJSON] = [], events: [CodexWorkerEvent] = []) {
        self.outgoing = outgoing
        self.events = events
    }
}

/// The Codex `app-server` JSON-RPC protocol for one worker, as a pure state machine: lines in,
/// events and outgoing messages out. It never touches a process or a pipe — the core owns the value
/// inside its isolation and writes the returned messages through the worker's writer outside it
/// (upstream `stage_rpc` then `send_rpc`), so a full pipe stalls only its own worker.
public struct CodexWorkerSession: Hashable, Sendable {
    public static let initializeID: OrderedJSON = 1
    public static let openThreadID: OrderedJSON = 2
    public static let firstTurnID: OrderedJSON = 3

    public let jobID: String
    public let cwd: String
    /// The first turn's text: work queued while the worker was down, or the task itself.
    public let firstTurn: String
    /// Set for an interrupted job: its thread survives on disk and is resumed instead of started.
    public let resumeThreadID: String?
    public let approvalPolicy: OrderedJSON
    public let sandbox: String
    public let webSearch: Bool
    public var model: String?
    public var effort: String?
    public var disabledPlugins: [String] = []

    public private(set) var threadID: String?
    public private(set) var activeTurnID: String?
    public private(set) var pending: CodexApprovalRequest?
    /// Request ids of this worker's later requests count up from here (upstream `next_request_id`).
    public private(set) var nextRequestID: Int
    public private(set) var reply = ""
    public private(set) var report = ""

    public init(
        jobID: String,
        cwd: String,
        firstTurn: String,
        resumeThreadID: String? = nil,
        approvalPolicy: OrderedJSON = .string(Job.defaultApprovalPolicy),
        sandbox: String = Job.defaultSandbox,
        webSearch: Bool = false,
        nextRequestID: Int = OrchestratorLimits.firstRequestID
    ) {
        self.jobID = jobID
        self.cwd = cwd
        self.firstTurn = firstTurn
        self.resumeThreadID = resumeThreadID
        self.approvalPolicy = approvalPolicy
        self.sandbox = sandbox
        self.webSearch = webSearch
        self.nextRequestID = nextRequestID
    }

    /// A session for `job`, resuming its thread when it has one (an interrupted job).
    public init(job: Job, firstTurn: String, disabledPlugins: [String] = []) {
        self.init(
            jobID: job.id,
            cwd: job.cwd,
            firstTurn: firstTurn,
            resumeThreadID: job.threadID,
            approvalPolicy: job.approvalPolicyValue,
            sandbox: job.sandbox,
            webSearch: job.webSearch,
            nextRequestID: job.nextRequestID
        )
        model = job.model; effort = job.effort; self.disabledPlugins = disabledPlugins
    }

    // MARK: Outgoing

    /// The opening messages, written as soon as the process is up: `initialize`, `initialized`,
    /// then `thread/resume` or `thread/start`. The first turn follows once the thread is known.
    public func handshake() -> [OrderedJSON] {
        let initialize: OrderedJSON = [
            "id": Self.initializeID,
            "method": "initialize",
            "params": [
                "clientInfo": ["name": "alethe-orchestrator", "title": "Alethe", "version": "1"],
                // Granular approvals are gated behind this: without it a worker cannot route its
                // question here and gives up on the write instead of asking.
                "capabilities": ["experimentalApi": true],
            ],
        ]
        var opening: OrderedJSON
        if let resumeThreadID {
            opening = [
                "id": Self.openThreadID,
                "method": "thread/resume",
                "params": ["threadId": .string(resumeThreadID), "cwd": .string(cwd)],
            ]
        } else {
            opening = [
                "id": Self.openThreadID,
                "method": "thread/start",
                "params": [
                    "cwd": .string(cwd),
                    "approvalPolicy": approvalPolicy,
                    "approvalsReviewer": "user",
                    "sandbox": .string(sandbox),
                    "config": ["tools": ["web_search": ["mode": webSearch ? "live" : "disabled"]]],
                ],
            ]
        }
        if model != nil || effort != nil || !disabledPlugins.isEmpty || sandbox == "read-only",
           var object = opening.objectValue, var params = object["params"]?.objectValue {
            if let model { params["model"] = .string(model) }
            params["approvalPolicy"] = approvalPolicy
            params["sandbox"] = .string(sandbox)
            var config = params["config"]?.objectValue ?? [:]
            if let effort { config["model_reasoning_effort"] = .string(effort) }
            if !disabledPlugins.isEmpty {
                var plugins: OrderedJSONObject = [:]
                for plugin in disabledPlugins { plugins[plugin] = ["enabled": false] }
                config["plugins"] = .object(plugins)
            }
            if !config.isEmpty { params["config"] = .object(config) }
            object["params"] = .object(params); opening = .object(object)
        }
        return [initialize, ["method": "initialized"], opening]
    }

    /// A new turn on the worker's own thread (a follow-up, or the inbox's next message), so it keeps
    /// everything it already read. The live reply and report start over.
    public mutating func startTurn(_ text: String) throws(OrchestratorToolError) -> OrderedJSON {
        guard let threadID else { throw OrchestratorToolError("job \(jobID) has no thread") }
        reply = ""
        report = ""
        return request("turn/start", [
            "threadId": .string(threadID),
            "input": [["type": "text", "text": .string(text)]],
            "approvalPolicy": "never",
        ])
    }

    /// A correction for the running turn, delivered into it (`turn/steer`).
    public mutating func steer(_ text: String) throws(OrchestratorToolError) -> OrderedJSON {
        guard let threadID else { throw OrchestratorToolError("job \(jobID) has no thread yet") }
        guard let activeTurnID else { throw OrchestratorToolError("job \(jobID) has no running turn to steer") }
        return request("turn/steer", [
            "threadId": .string(threadID),
            "input": [["type": "text", "text": .string(text)]],
            "expectedTurnId": .string(activeTurnID),
        ])
    }

    /// Stops the running turn (cancel, budget). Nil when no turn is known to be running.
    public mutating func interrupt() -> OrderedJSON? {
        guard let threadID, let activeTurnID else { return nil }
        return request("turn/interrupt", ["threadId": .string(threadID), "turnId": .string(activeTurnID)])
    }

    /// The answer to the question the worker is stopped on, on the id it is waiting for.
    public mutating func answer(_ decision: String) throws(OrchestratorToolError) -> OrderedJSON {
        guard let decision = CodexApprovalDecision(rawValue: decision) else {
            let names = CodexApprovalDecision.allCases.map(\.rawValue).joined(separator: ", ")
            throw OrchestratorToolError("decision must be one of \(names)")
        }
        return try answer(decision)
    }

    public mutating func answer(_ decision: CodexApprovalDecision) throws(OrchestratorToolError) -> OrderedJSON {
        guard let pending else { throw OrchestratorToolError("job \(jobID) is not waiting on anything") }
        self.pending = nil
        return ["id": pending.rpcID, "result": ["decision": .string(decision.rawValue)]]
    }

    private mutating func request(_ method: String, _ params: OrderedJSON) -> OrderedJSON {
        nextRequestID += 1
        return ["id": .integer(nextRequestID), "method": .string(method), "params": params]
    }

    // MARK: Incoming

    /// One line of the worker's stdout. Blank and invalid lines produce nothing, like upstream.
    public mutating func receive(line: String, nowMs: UInt64 = CodexWorkerSession.currentMilliseconds()) -> CodexWorkerStep {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let message = try? OrderedJSON.parse(trimmed) else { return CodexWorkerStep() }
        return receive(message, nowMs: nowMs)
    }

    public mutating func receive(_ message: OrderedJSON, nowMs: UInt64 = CodexWorkerSession.currentMilliseconds()) -> CodexWorkerStep {
        guard let object = message.objectValue else { return CodexWorkerStep() }
        let method = object["method"]?.stringValue ?? ""
        let params = object["params"]?.objectValue ?? [:]

        // Both an id and a method: the worker is asking, and it stops until answered.
        if let rpcID = object["id"], !method.isEmpty {
            return request(rpcID: rpcID, method: method, params: params, nowMs: nowMs)
        }
        if let id = object["id"] {
            return response(id: id, object: object)
        }

        switch method {
        case "turn/started":
            activeTurnID = params["turn"]?.objectValue?["id"]?.stringValue
            return CodexWorkerStep(events: [.turnStarted(turnID: activeTurnID)])
        case "item/completed":
            let item = params["item"]?.objectValue
            guard item?["type"]?.stringValue == "agentMessage" else { return CodexWorkerStep() }
            let text = (item?["text"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return CodexWorkerStep() }
            report = text
            return CodexWorkerStep(events: [.report(text)])
        case "item/agentMessage/delta":
            guard let delta = params["delta"]?.stringValue else { return CodexWorkerStep() }
            reply = Self.appendingReply(reply, delta)
            return CodexWorkerStep(events: [.replyDelta(delta)])
        case "turn/plan/updated":
            let steps = params["plan"]?.arrayValue?.compactMap { $0.objectValue?["step"]?.stringValue } ?? []
            return CodexWorkerStep(events: [.planUpdated(steps)])
        case "turn/diff/updated":
            return CodexWorkerStep(events: [.diffUpdated(params["diff"]?.stringValue)])
        case "thread/tokenUsage/updated":
            return CodexWorkerStep(events: [.tokensUpdated(params["tokenUsage"])])
        case "turn/completed", "turn/failed":
            let summary = report.isEmpty
                ? orchestratorTail(reply, limit: OrchestratorLimits.replyLimit)
                : report
            activeTurnID = nil
            pending = nil
            return CodexWorkerStep(events: [.turnEnded(succeeded: method == "turn/completed", summary: summary)])
        default:
            return CodexWorkerStep()
        }
    }

    /// Approval requests become a pending ask; anything else is refused at once, because an
    /// unanswered request hangs that worker for good.
    private mutating func request(rpcID: OrderedJSON, method: String, params: OrderedJSONObject, nowMs: UInt64) -> CodexWorkerStep {
        let kind: CodexApprovalRequest.Kind
        switch method {
        case "item/commandExecution/requestApproval": kind = .command
        case "item/fileChange/requestApproval": kind = .fileChange
        default:
            return CodexWorkerStep(outgoing: [[
                "id": rpcID,
                "error": ["code": -32601, "message": .string("unsupported request \(method)")],
            ]])
        }
        let ask = CodexApprovalRequest(
            rpcID: rpcID,
            kind: kind,
            command: params["command"]?.stringValue,
            cwd: params["cwd"]?.stringValue,
            reason: params["reason"]?.stringValue,
            askedAtMs: nowMs
        )
        pending = ask
        return CodexWorkerStep(events: [.approvalRequested(ask)])
    }

    private mutating func response(id: OrderedJSON, object: OrderedJSONObject) -> CodexWorkerStep {
        if let error = object["error"] {
            let message = error.objectValue?["message"]?.stringValue ?? error.compactRendered()
            return CodexWorkerStep(events: [.requestFailed(id: id, message: message)])
        }
        // The thread is known: the first turn goes out on it.
        guard id.intValue == Self.openThreadID.intValue,
              let threadID = object["result"]?.objectValue?["thread"]?.objectValue?["id"]?.stringValue
        else { return CodexWorkerStep() }
        self.threadID = threadID
        let turn: OrderedJSON = [
            "id": Self.firstTurnID,
            "method": "turn/start",
            "params": [
                "threadId": .string(threadID),
                "input": [["type": "text", "text": .string(firstTurn)]],
                "approvalPolicy": "never",
            ],
        ]
        return CodexWorkerStep(outgoing: [turn], events: [.threadReady(threadID: threadID)])
    }

    /// Appends a delta and keeps the reply within `replyLimit`, dropping its oldest part.
    static func appendingReply(_ reply: String, _ delta: String) -> String {
        let joined = reply + delta
        let scalars = joined.unicodeScalars
        guard scalars.count > OrchestratorLimits.replyLimit else { return joined }
        var kept = String.UnicodeScalarView()
        kept.append(contentsOf: scalars.suffix(OrchestratorLimits.replyLimit))
        return String(kept)
    }

    public static func currentMilliseconds() -> UInt64 {
        UInt64(max(0, Date().timeIntervalSince1970 * 1000))
    }
}

extension Job {
    /// Folds a Codex worker event into the job's data, as upstream's handlers do. Settling on
    /// `turnEnded` (status, outcome, delivery, parking) stays with the core.
    public mutating func apply(_ event: CodexWorkerEvent) {
        switch event {
        case .threadReady(let threadID): self.threadID = threadID
        case .turnStarted(let turnID): activeTurnID = turnID
        case .replyDelta(let delta): reply = CodexWorkerSession.appendingReply(reply, delta)
        case .report(let text): report = text
        case .planUpdated(let steps): plan = steps
        case .diffUpdated(let diff): self.diff = diff
        case .tokensUpdated(let tokens): self.tokens = tokens
        case .approvalRequested(let ask):
            pending = ask.json
            status = .blocked
        case .turnEnded: activeTurnID = nil
        case .requestFailed: break
        }
    }
}

extension CodexWorkerSession {
    /// Drives one worker: each stdout line is handed to `handle` (the core applying it to the job's
    /// session inside its isolation), and whatever that returns is written through `write` outside
    /// it, in order. `write` gets one compact JSON message per call, without a trailing newline —
    /// the process host's line writer frames it. Returns when the stream ends (the worker closed
    /// its stdout); the core then settles the job as upstream does ("worker connection closed").
    public static func pump<Lines: AsyncSequence>(
        lines: Lines,
        handle: (String) async -> [OrderedJSON],
        write: (String) async throws -> Void
    ) async throws where Lines.Element == String {
        for try await line in lines {
            for message in await handle(line) {
                try await write(message.compactRendered())
            }
        }
    }
}
