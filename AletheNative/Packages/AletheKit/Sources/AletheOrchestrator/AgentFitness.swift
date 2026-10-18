import Foundation
import AletheAgents
import AletheIntegrations

/// How close one agent is to its usage ceiling (upstream `lib/agentFitness.ts`): every window a
/// vendor meters collapsed to the worst one, so `used` compares across vendors that do not report
/// the same set of windows.
public struct AgentFitness: Hashable, Sendable {
    /// The window closest to its ceiling: `5h`, `week`, `opus`, or the reader's own label.
    public var windows: [String: Int] = [:]
    public var worst: String
    /// Share of that window used, 0…100, rounded.
    public var used: Int
    public var resetsAt: Date?
    public var plan: String?
    public var rateLimited: Bool

    public init(worst: String, used: Int, resetsAt: Date? = nil, plan: String? = nil, rateLimited: Bool = false) {
        self.worst = worst
        self.used = used
        self.resetsAt = resetsAt
        self.plan = plan
        self.rateLimited = rateLimited
    }

    /// The fitness of a P3-13 usage reading; nil when the reading has no windows (not signed in,
    /// no CLI, unavailable). Upstream reports Claude as never rate-limited — a spent Claude window
    /// already reads 100 % — and only Codex carries a plan.
    public init?(_ usage: ProviderUsage) {
        guard usage.status == .ready, var worst = usage.windows.first else { return nil }
        // Strictly greater, so the earlier window keeps a tie (upstream `worstOf`).
        for window in usage.windows.dropFirst() where window.usedPercent > worst.usedPercent { worst = window }
        let isCodex = usage.agent == .codex
        self.init(
            worst: Self.windowName(worst.label),
            used: Int(worst.usedPercent.rounded(.toNearestOrAwayFromZero)),
            resetsAt: worst.resetsAt,
            plan: isCodex ? usage.plan.flatMap { $0.isEmpty ? nil : $0 } : nil,
            rateLimited: isCodex && usage.rateLimited
        )
        windows = Dictionary(usage.windows.map { (Self.windowName($0.label), Int($0.usedPercent.rounded())) }, uniquingKeysWith: max)
    }

    /// The reader's window labels in upstream's words, which is what the planner reads.
    static func windowName(_ label: String) -> String {
        switch label {
        case "7d": "week"
        case "7d Opus": "opus"
        default: label
        }
    }

    /// How close this agent is to its ceiling. Being rate-limited outranks any percentage: the
    /// window is not almost gone, it is gone (upstream `strain_of`).
    public var strain: Double { rateLimited ? .greatestFiniteMagnitude : Double(used) }

    /// At or past `AgentFitness.headroomThreshold`, or rate-limited.
    public var isStrained: Bool { strain >= Self.headroomThreshold }

    /// The share of a window that counts as running out; the planner's hint and the person's warning
    /// chip use the same one so they never disagree (upstream `HEADROOM_THRESHOLD`).
    public static let headroomThreshold: Double = 80

    /// The snapshot as upstream's frontend sends it (`plan` only when known).
    public var json: OrderedJSON {
        var object: OrderedJSONObject = [
            "worst": .string(worst),
            "used": .integer(used),
            "resetsAt": resetsAt.map { .string(Self.isoFormat.format($0)) } ?? .null,
        ]
        if let plan { object["plan"] = .string(plan) }
        object["rateLimited"] = .bool(rateLimited)
        return .object(object)
    }

    /// JavaScript's `toISOString`.
    private static let isoFormat = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}

/// Routing advice from the current fitness readings (upstream `fitness_block`, `strained_agent`,
/// `routing_note`, `headroom_hint`). Agents are read sorted by name, so a tie resolves the same way
/// on every call.
public struct FitnessRouting: Sendable {
    public let entries: [(agent: String, fitness: AgentFitness)]

    public init(_ readings: [String: AgentFitness]) {
        entries = readings.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    public func fitness(of agent: String) -> AgentFitness? {
        entries.first { $0.agent == agent }?.fitness
    }

    /// The least strained agent; the first by name on a tie. Nil without readings.
    public var headroom: String? {
        var best: (agent: String, strain: Double)?
        for entry in entries where best.map({ entry.fitness.strain < $0.strain }) ?? true {
            best = (entry.agent, entry.fitness.strain)
        }
        return best?.agent
    }

    /// The **most** strained agent past the threshold, not merely the first one found: when both
    /// sides are running out the board names the same one on every call. The last by name wins a
    /// tie, as upstream's `max_by` does.
    public var mostStrained: (agent: String, fitness: AgentFitness)? {
        var worst: (agent: String, fitness: AgentFitness)?
        for entry in entries where entry.fitness.isStrained {
            if worst.map({ entry.fitness.strain >= $0.fitness.strain }) ?? true { worst = entry }
        }
        return worst
    }

    /// Every reading keyed by agent, plus `headroom`: what every tool response carries. Nil without
    /// readings.
    public var block: OrderedJSON? {
        guard !entries.isEmpty else { return nil }
        var object = OrderedJSONObject()
        for entry in entries { object[entry.agent] = entry.fitness.json }
        if let headroom { object["headroom"] = .string(headroom) }
        return .object(object)
    }

    /// Why a worker ran where it ran, recorded only when a side was actually running out.
    /// `ignored` is the case worth seeing: the planner had this same reading in every earlier
    /// response and delegated into the strained side anyway.
    public func routingNote(requested: String) -> OrderedJSON? {
        guard let strained = mostStrained else { return nil }
        return [
            "verdict": requested == strained.agent ? "ignored" : "chosen",
            "agent": .string(strained.agent),
            "window": .string(strained.fitness.worst),
            "used": .double(Double(strained.fitness.used)),
        ]
    }

    /// Names the roomier side when the requested one is at the threshold or rate-limited.
    public func headroomHint(requested: String) -> OrderedJSON? {
        guard let here = fitness(of: requested), here.isStrained,
              let other = headroom, other != requested,
              let there = fitness(of: other)
        else { return nil }
        let situation = here.rateLimited
            ? "\(requested) is rate-limited right now"
            : "\(requested) is at \(here.used)% of its \(here.worst) window"
        // Naming the roomier side without saying it is also nearly gone would read as "this one is
        // fine", and it is not.
        let bothStrained = there.isStrained
        let reason = bothStrained
            ? "\(situation), and \(other) is at \(there.used)% — both are running out; \(other) has the most room left"
            : "\(situation); \(other) is at \(there.used)%"
        return [
            "agent": .string(other),
            "bothStrained": .bool(bothStrained),
            "reason": .string(reason),
        ]
    }
}
