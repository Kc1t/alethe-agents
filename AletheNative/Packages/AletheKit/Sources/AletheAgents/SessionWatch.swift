import Foundation

/// File-change reconciliation for a running pane. Unlike initial discovery, this continues after
/// an id has been assigned and notices writes to an older conversation after an in-CLI resume.
public struct SessionWatch: Sendable {
    private var previous: [String: Date]?
    private var currentID: String?

    public init() {}

    /// An ambiguous directory update cannot identify a pane. Hooks remain authoritative, and a
    /// conversation held by another pane is never adopted based on modification time alone.
    public mutating func reconcile(sessions: [SessionSnapshot], currentID: String?,
                                   startedAt: Date, claimedByOthers: Set<String>) -> String? {
        let snapshot = Dictionary(sessions.map { ($0.id, $0.modifiedAt) }, uniquingKeysWith: max)
        defer { previous = snapshot; self.currentID = currentID }
        if previous != nil, self.currentID != currentID { return nil }
        let changed = sessions.filter { session in
            guard session.id != currentID, !claimedByOthers.contains(session.id),
                  session.modifiedAt >= startedAt else { return false }
            guard let previous else { return true }
            return previous[session.id].map { session.modifiedAt > $0 } ?? true
        }
        guard changed.count == 1 else { return nil }
        return changed.first?.id
    }

    /// Includes Claude for continuous tracking; initial discovery used a preassigned launch UUID.
    public static func snapshot(_ kind: AgentKind, cwd: String, executable: String? = nil,
                                homeDirectory: String = NSHomeDirectory()) async -> [SessionSnapshot] {
        switch kind {
        case .claude: return ClaudeSessions.snapshot(cwd: cwd, homeDirectory: homeDirectory)
        case .codex: return CodexSessions.snapshot(cwd: cwd, homeDirectory: homeDirectory)
        case .antigravity: return AntigravitySessions.snapshot(cwd: cwd, homeDirectory: homeDirectory)
        case .opencode:
            guard let executable else { return [] }
            return await OpenCodeSessions.snapshot(cwd: cwd, executable: executable)
        default: return []
        }
    }
}
