/// An agent type as stored in the workspace (`SubTab.agent`) and preferences. Unknown raw values
/// survive a round trip so a document written by a newer build keeps its tabs.
public struct AgentKind: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let claude = AgentKind(rawValue: "claude")
    public static let codex = AgentKind(rawValue: "codex")
    public static let opencode = AgentKind(rawValue: "opencode")
    public static let cursor = AgentKind(rawValue: "cursor")
    public static let copilot = AgentKind(rawValue: "copilot")
    public static let antigravity = AgentKind(rawValue: "antigravity")
    public static let mimo = AgentKind(rawValue: "mimo")
    public static let freebuff = AgentKind(rawValue: "freebuff")
    public static let kiro = AgentKind(rawValue: "kiro")
    public static let shell = AgentKind(rawValue: "shell")

    public var description: String { rawValue }
}

/// How an agent's CLI is run. Upstream: `types.ts` (`AGENT_TYPE_LABELS`, `UNRESTRICTED_FLAG`,
/// `BUILTIN_CLI_COMMANDS`).
public struct AgentDescriptor: Hashable, Sendable, Identifiable {
    public let kind: AgentKind
    /// Product name; provider names are not translated.
    public let displayName: String
    /// Binary the launcher runs; nil for a plain shell.
    public let cliCommand: String?
    /// Flag that skips permission prompts, or nil when the CLI has none.
    public let unrestrictedFlag: String?

    public let defaultArguments: [String]

    public var id: AgentKind { kind }
    public var isShell: Bool { cliCommand == nil }

    public init(kind: AgentKind, displayName: String, cliCommand: String?, unrestrictedFlag: String?, defaultArguments: [String] = []) {
        self.defaultArguments = defaultArguments
        self.kind = kind
        self.displayName = displayName
        self.cliCommand = cliCommand
        self.unrestrictedFlag = unrestrictedFlag
    }
}

/// The single source of which agents exist and how they launch (plan lesson 16: the spawn
/// allow-list and the agent map must never disagree).
public struct AgentRegistry: Sendable {
    public let descriptors: [AgentDescriptor]

    public init(descriptors: [AgentDescriptor]) {
        self.descriptors = descriptors
    }

    /// Upstream's agents in its order (`ALL_AGENT_TYPES`); `wsl` is Windows-only and not ported.
    public static let builtin = AgentRegistry(descriptors: [
        AgentDescriptor(kind: .claude, displayName: "Claude Code", cliCommand: "claude",
                        unrestrictedFlag: "--dangerously-skip-permissions"),
        AgentDescriptor(kind: .codex, displayName: "Codex", cliCommand: "codex",
                        unrestrictedFlag: "--dangerously-bypass-approvals-and-sandbox"),
        AgentDescriptor(kind: .copilot, displayName: "GitHub Copilot", cliCommand: "copilot", unrestrictedFlag: "--allow-all"),
        // `cursor-agent`, not the bare `agent` alias, which collides with other vendors' CLIs.
        AgentDescriptor(kind: .cursor, displayName: "Cursor", cliCommand: "cursor-agent", unrestrictedFlag: "--force"),
        AgentDescriptor(kind: .antigravity, displayName: "Antigravity", cliCommand: "agy",
                        unrestrictedFlag: "--dangerously-skip-permissions"),
        AgentDescriptor(kind: .opencode, displayName: "OpenCode", cliCommand: "opencode",
                        unrestrictedFlag: "--dangerously-skip-permissions"),
        AgentDescriptor(kind: .mimo, displayName: "Mimo", cliCommand: "mimo", unrestrictedFlag: nil),
        AgentDescriptor(kind: .freebuff, displayName: "Freebuff", cliCommand: "freebuff", unrestrictedFlag: nil),
        AgentDescriptor(kind: .kiro, displayName: "Kiro CLI", cliCommand: "kiro-cli", unrestrictedFlag: "--trust-all-tools"),
        AgentDescriptor(kind: .shell, displayName: "Shell", cliCommand: nil, unrestrictedFlag: nil),
    ])

    public var kinds: [AgentKind] { descriptors.map(\.kind) }

    public func descriptor(for kind: AgentKind) -> AgentDescriptor? {
        descriptors.first { $0.kind == kind }
    }

    /// A free-form agent name (from a document or a backend) as a known kind; case-insensitive.
    public func parse(_ raw: String?) -> AgentKind? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let exact = AgentKind(rawValue: trimmed)
        if descriptor(for: exact) != nil { return exact }
        let lowered = AgentKind(rawValue: trimmed.lowercased())
        return descriptor(for: lowered) != nil ? lowered : nil
    }

    /// Agents offered for new terminals: `enabled` from preferences (nil = all), in registry order.
    /// The shell is always offered.
    public func enabledKinds(_ enabled: [String]?) -> [AgentKind] {
        guard let enabled else { return kinds }
        let allowed = Set(enabled.compactMap(parse))
        return kinds.filter { $0 == .shell || allowed.contains($0) }
    }

    /// `enabled` after turning one agent on or off. Everything on is stored as nil ("all"), so agents
    /// added in later versions start enabled; the shell cannot be turned off.
    public func enabled(_ enabled: [String]?, setting kind: AgentKind, on: Bool) -> [String]? {
        guard kind != .shell else { return enabled }
        var kinds = Set(enabledKinds(enabled))
        if on { kinds.insert(kind) } else { kinds.remove(kind) }
        return kinds == Set(self.kinds) ? nil : self.kinds.filter { kinds.contains($0) && $0 != .shell }.map(\.rawValue)
    }
}
