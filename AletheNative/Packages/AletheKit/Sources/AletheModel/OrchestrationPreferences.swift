import Foundation

/// The web `preferences.orchestration` shape. Optional profile fields need no schema migration.
public struct OrchestrationPreferences: Codable, Hashable, Sendable {
    public var roles: [OrchestrationRole] = []
    public var maxConcurrent = 4
    public var defaultTimeoutSeconds = 900
    public var workerDisabledPlugins: [String] = []
    public var routing = OrchestrationRouting()
    public var skill = OrchestrationSkill()
    public init() {}

    public static let maximumTimeout = 604_800
    public static func isName(_ value: String) -> Bool {
        !value.isEmpty && !value.hasPrefix("-") && !value.unicodeScalars.contains {
            CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
        }
    }

    public var normalized: Self {
        var next = self
        next.maxConcurrent = min(16, max(1, maxConcurrent))
        if !(0...Self.maximumTimeout).contains(defaultTimeoutSeconds) { next.defaultTimeoutSeconds = 900 }
        var seen = Set<String>()
        next.roles = roles.filter { $0.isValid && seen.insert(($0.orchestrator ?? "") + " " + $0.name).inserted }
        next.roles = next.roles.map { role in
            var role = role
            if let fallback = role.fallback, !next.canFallBack(role, to: fallback) { role.fallback = nil }
            return role
        }
        seen = []
        next.workerDisabledPlugins = workerDisabledPlugins.filter { Self.isName($0) && seen.insert($0).inserted }
        next.routing = routing.normalized
        next.skill = skill.normalized
        return next
    }

    public func canFallBack(_ role: OrchestrationRole, to name: String) -> Bool {
        guard role.name != name else { return false }
        let named = roles.filter { $0.name == name }
        let reached: [OrchestrationRole]
        if let planner = role.orchestrator {
            reached = (named.first { $0.orchestrator == planner } ?? named.first { $0.orchestrator == nil }).map { [$0] } ?? []
        } else { reached = named }
        return reached.contains { !role.readOnly || $0.readOnly }
    }

    enum CodingKeys: String, CodingKey { case roles, maxConcurrent, defaultTimeoutSeconds, workerDisabledPlugins, routing, skill }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if var rows = try? c.nestedUnkeyedContainer(forKey: .roles) {
            while !rows.isAtEnd {
                let decoder = try rows.superDecoder()
                if let role = try? OrchestrationRole(from: decoder) { roles.append(role) }
            }
        }
        if let value = try? c.decode(Double.self, forKey: .maxConcurrent), value.isFinite {
            maxConcurrent = Int(min(16, max(1, value.rounded())))
        }
        defaultTimeoutSeconds = (try? c.decode(Int.self, forKey: .defaultTimeoutSeconds)) ?? 900
        workerDisabledPlugins = (try? c.decode([String].self, forKey: .workerDisabledPlugins)) ?? []
        routing = (try? c.decode(OrchestrationRouting.self, forKey: .routing)) ?? .init()
        skill = (try? c.decode(OrchestrationSkill.self, forKey: .skill)) ?? .init()
        self = normalized
    }
}

public struct OrchestrationRole: Codable, Hashable, Sendable {
    public var name: String
    public var agent: String
    public var model: String?
    public var effort: String?
    public var readOnly: Bool
    public var timeoutSeconds: Int?
    public var fallback: String?
    public var orchestrator: String?
    public init(name: String, agent: String = "codex", model: String? = nil, effort: String? = nil,
                readOnly: Bool = false, timeoutSeconds: Int? = nil, fallback: String? = nil, orchestrator: String? = nil) {
        self.name = name; self.agent = agent; self.model = model; self.effort = effort
        self.readOnly = readOnly; self.timeoutSeconds = timeoutSeconds; self.fallback = fallback; self.orchestrator = orchestrator
    }
    public var isValid: Bool {
        OrchestrationPreferences.isName(name) && ["codex", "claude"].contains(agent)
            && (model.map(OrchestrationPreferences.isName) ?? true)
            && (effort.map(OrchestrationPreferences.isName) ?? true)
            && (timeoutSeconds.map { (0...OrchestrationPreferences.maximumTimeout).contains($0) } ?? true)
            && (orchestrator.map { ["codex", "claude"].contains($0) } ?? true)
            && (agent == "codex" || !readOnly)
    }
    enum CodingKeys: String, CodingKey { case name, agent, model, effort, readOnly, timeoutSeconds, fallback, orchestrator }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name); try c.encode(agent, forKey: .agent)
        try c.encode(model, forKey: .model); try c.encode(effort, forKey: .effort)
        try c.encode(readOnly, forKey: .readOnly); try c.encode(timeoutSeconds, forKey: .timeoutSeconds)
        try c.encodeIfPresent(fallback, forKey: .fallback); try c.encodeIfPresent(orchestrator, forKey: .orchestrator)
    }
}

public struct OrchestrationSkill: Codable, Hashable, Sendable {
    public var backend = "auto"
    public var defaultStrategy = "auto"
    public var providerSwitch = "ask"
    public var conserveProvider: String?
    public var preferredProvider: String?
    public init() {}
    public var normalized: Self {
        var next = self
        if !["auto", "skill", "mcp"].contains(backend) { next.backend = "auto" }
        if !["auto", "economy", "balanced", "quality", "research", "parallel", "rescue"].contains(defaultStrategy) { next.defaultStrategy = "auto" }
        if !["ask", "automatic", "never"].contains(providerSwitch) { next.providerSwitch = "ask" }
        if let conserveProvider, !Self.providers.contains(conserveProvider) { next.conserveProvider = nil }
        if let preferredProvider, !Self.providers.contains(preferredProvider) { next.preferredProvider = nil }
        return next
    }
    public static let providers = ["codex", "claude", "agy", "kimi"]
    enum CodingKeys: String, CodingKey { case backend, defaultStrategy, providerSwitch, conserveProvider, preferredProvider }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        backend = (try? c.decode(String.self, forKey: .backend)) ?? "auto"
        defaultStrategy = (try? c.decode(String.self, forKey: .defaultStrategy)) ?? "auto"
        providerSwitch = (try? c.decode(String.self, forKey: .providerSwitch)) ?? "ask"
        conserveProvider = try? c.decode(String.self, forKey: .conserveProvider)
        preferredProvider = try? c.decode(String.self, forKey: .preferredProvider)
        self = normalized
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(backend, forKey: .backend); try c.encode(defaultStrategy, forKey: .defaultStrategy)
        try c.encode(providerSwitch, forKey: .providerSwitch)
        try c.encode(conserveProvider, forKey: .conserveProvider); try c.encode(preferredProvider, forKey: .preferredProvider)
    }
}

public struct OrchestrationRouting: Codable, Hashable, Sendable {
    public var preset = "balanced"
    public var rules: [OrchestrationRoutingRule] = []
    public var criticalThreshold = 80
    public var allowOpusOnDeep = true
    public var onBothCritical = "ask"
    public init() {}
    enum CodingKeys: String, CodingKey { case preset, rules, criticalThreshold, allowOpusOnDeep, onBothCritical }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = (try? c.decode(String.self, forKey: .preset)) ?? "balanced"
        criticalThreshold = (try? c.decode(Int.self, forKey: .criticalThreshold)) ?? 80
        allowOpusOnDeep = (try? c.decode(Bool.self, forKey: .allowOpusOnDeep)) ?? true
        onBothCritical = (try? c.decode(String.self, forKey: .onBothCritical)) ?? "ask"
        if var rows = try? c.nestedUnkeyedContainer(forKey: .rules) {
            while !rows.isAtEnd {
                let decoder = try rows.superDecoder()
                if let rule = try? OrchestrationRoutingRule(from: decoder) { rules.append(rule) }
            }
        }
        self = normalized
    }
    public var normalized: Self {
        var next = self
        if !["economy", "balanced", "performance", "custom"].contains(preset) { next.preset = "balanced" }
        if !(10...99).contains(criticalThreshold) { next.criticalThreshold = 80 }
        if !["ask", "run-cheapest", "block"].contains(onBothCritical) { next.onBothCritical = "ask" }
        var seen = Set<String>()
        next.rules = rules.filter { $0.isValid && seen.insert($0.id).inserted }
        return next
    }
}

public struct OrchestrationRoutingRule: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var enabled = true
    public var kinds: [String] = []
    public var efforts: [String] = []
    public var gates: [OrchestrationQuotaGate] = []
    public var role: String
    public static let kinds = ["research", "code", "review", "command", "scrap", "docs"]
    public static let efforts = ["light", "standard", "deep"]
    public init(id: String = UUID().uuidString, role: String) { self.id = id; self.role = role }
    public var isValid: Bool {
        !id.isEmpty && OrchestrationPreferences.isName(role)
            && kinds.allSatisfy(Self.kinds.contains) && efforts.allSatisfy(Self.efforts.contains)
            && gates.allSatisfy(\.isValid)
    }
}

public struct OrchestrationQuotaGate: Codable, Hashable, Sendable {
    public var agent = "claude"
    public var window = "short"
    public var below = 80
    public init() {}
    public var isValid: Bool { ["claude", "codex"].contains(agent) && ["short", "week", "opus"].contains(window) && (1...99).contains(below) }
}
