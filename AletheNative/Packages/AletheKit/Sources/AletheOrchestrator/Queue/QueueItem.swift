import Foundation
import AletheIntegrations

/// A deferred prompt, separate from jobs already accepted into the concurrency queue.
public struct QueueItem: Codable, Hashable, Sendable, Identifiable {
    public enum Release: Codable, Hashable, Sendable {
        case whenAgentHasRoom
        case at(Date)
        case afterJob(String)
    }

    public enum State: Codable, Hashable, Sendable {
        case queued
        case waitingLimit(Date?)
        case running(String)
        case done
        case failed
        case cancelled

        public var pending: Bool {
            switch self {
            case .queued, .waitingLimit: true
            default: false
            }
        }

        public var name: String {
            switch self {
            case .queued: "queued"
            case .waitingLimit: "waitingLimit"
            case .running: "running"
            case .done: "done"
            case .failed: "failed"
            case .cancelled: "cancelled"
            }
        }
    }

    public let id: String
    public var prompt: String
    public var agent: String
    public var cwd: String
    public var isolate: Bool
    public var label: String?
    public var priority: Int
    public let createdAt: Date
    public var release: Release
    public var state: State
    public var planner: String?
    public var askForApproval: Bool
    public var webSearch: Bool
    public var timeoutMs: UInt64?

    public init(prompt: String, agent: String = WorkerAgent.codex, cwd: String,
                isolate: Bool = false, label: String? = nil, priority: Int = 0,
                release: Release = .whenAgentHasRoom, planner: String? = nil,
                askForApproval: Bool = false, webSearch: Bool = false,
                timeoutMs: UInt64? = OrchestratorLimits.defaultJobTimeoutMs,
                createdAt: Date = Date()) {
        id = "queue-" + UUID().uuidString.lowercased()
        self.prompt = prompt
        self.agent = agent
        self.cwd = cwd
        self.isolate = isolate
        self.label = label
        self.priority = priority
        self.createdAt = createdAt
        self.release = release
        state = .queued
        self.planner = planner
        self.askForApproval = askForApproval
        self.webSearch = webSearch
        self.timeoutMs = timeoutMs
    }

    public var request: DelegateRequest {
        DelegateRequest(tasks: [prompt], agent: agent, cwd: cwd, label: label,
                        timeoutMs: timeoutMs, askForApproval: askForApproval,
                        webSearch: webSearch, isolate: isolate)
    }

    public var resetsAt: Date? {
        if case .waitingLimit(let date) = state { return date }
        if case .at(let date) = release, state.pending { return date }
        return nil
    }

    public var json: OrderedJSON {
        var object: OrderedJSONObject = [
            "id": .string(id), "prompt": .string(prompt), "agent": .string(agent),
            "cwd": .string(cwd), "isolate": .bool(isolate), "label": .optional(label),
            "priority": .integer(priority), "createdAt": .string(createdAt.ISO8601Format()),
            "state": .string(state.name),
            "resetsAt": .optional(resetsAt?.ISO8601Format()),
        ]
        switch release {
        case .whenAgentHasRoom: object["release"] = "whenAgentHasRoom"
        case .at(let date): object["at"] = .string(date.ISO8601Format())
        case .afterJob(let id): object["afterJob"] = .string(id)
        }
        if case .running(let id) = state { object["jobId"] = .string(id) }
        return .object(object)
    }

    /// A dated release still respects agent headroom. Run now explicitly overrides both.
    public func isEligible(now: Date, fitness: AgentFitness?, settledJobs: Set<String>) -> Bool {
        guard state.pending else { return false }
        if case .waitingLimit(let date) = state {
            if let date {
                guard date <= now || fitness.map({ !$0.isStrained }) == true else { return false }
            } else {
                guard let fitness, !fitness.isStrained else { return false }
            }
        }
        if let fitness, fitness.isStrained,
           fitness.resetsAt.map({ $0 > now }) ?? true { return false }
        switch release {
        case .whenAgentHasRoom: return true
        case .at(let date): return date <= now
        case .afterJob(let id): return settledJobs.contains(id)
        }
    }
}
