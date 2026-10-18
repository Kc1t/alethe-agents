import AppKit
import Observation

/// On-device command recognition uses the same command registry as Find/Jump. No generated shell
/// text is executed, and every match must be confirmed against the current workspace.
@Observable @MainActor
final class JevController {
    enum Status: String { case deciding, ran, waiting, blocked, failed }
    struct Entry: Identifiable {
        let id = UUID()
        let at = Date()
        var spoken: String
        var summary: String
        var status: Status
        var actions: [String] = []
    }
    struct Candidate: Sendable {
        let id: String
        let title: String
        let available: Bool
        let perform: @MainActor @Sendable () -> Void
    }
    var open = false
    var listening = false
    var heard = ""
    var message = ""
    private(set) var entries: [Entry] = []
    private(set) var pendingID: UUID?
    @ObservationIgnored private var pending: Candidate?
    @ObservationIgnored private weak var environment: AppEnvironment?

    func start(environment: AppEnvironment) { self.environment = environment }

    private func candidates() -> [Candidate] {
        guard let environment, let workspace = environment.workspace else { return [] }
        let builtins = JumpCommand.allCases.map { command in
            Candidate(id: command.rawValue, title: String(localized: command.title),
                      available: command.isAvailable(workspace.document)) {
                command.run(environment: environment, undoManager: nil)
            }
        }
        let plugins = (environment.plugins?.contributions.commands ?? [])
            .filter { $0.placement.contains(.findJump) }
            .map { command in
                Candidate(id: "plugin:" + command.id, title: command.title, available: true) { command.perform() }
            }
        return builtins + plugins
    }

    func recognize(_ spoken: String) {
        let text = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        heard = text
        listening = false
        guard !text.isEmpty else { message = String(localized: "jev.noSpeech"); return }
        if let pendingID { settle(pendingID, status: .blocked) }
        pending = nil
        pendingID = nil
        let options = candidates()
        let matches = options.filter { Self.normalized($0.title) == Self.normalized(text) }
        let candidate = matches.count == 1 ? matches[0] : nil
        let entry = Entry(spoken: text, summary: candidate?.title ?? String(localized: "jev.noMatch"),
                          status: candidate?.available == true ? .waiting : .blocked)
        entries.insert(entry, at: 0)
        entries = Array(entries.prefix(50))
        pending = candidate?.available == true ? candidate : nil
        pendingID = pending == nil ? nil : entry.id
        message = pending == nil ? String(localized: "jev.noMatch") : entry.summary
    }

    /// Speech punctuation and case do not affect a command title; ambiguous matches stay blocked.
    static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    func confirm() {
        guard let pending, let id = pendingID else { return }
        guard let current = candidates().first(where: { $0.id == pending.id }), current.available else {
            settle(id, status: .blocked)
            self.pending = nil
            pendingID = nil
            message = String(localized: "jev.noMatch")
            return
        }
        settle(id, status: .ran, actions: [current.title])
        self.pending = nil
        pendingID = nil
        open = false
        // Dismiss the voice surface before opening an editor or Settings.
        DispatchQueue.main.async { current.perform() }
    }

    func failed(_ message: String) {
        listening = false
        self.message = message
        entries.insert(Entry(spoken: heard, summary: message, status: .failed), at: 0)
        entries = Array(entries.prefix(50))
    }

    func close() {
        if let pendingID { settle(pendingID, status: .blocked) }
        pendingID = nil
        pending = nil
        open = false
        listening = false
        heard = ""
        message = ""
    }

    func clear() { entries.removeAll(); pending = nil; pendingID = nil }

    private func settle(_ id: UUID, status: Status, actions: [String] = []) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index].status = status
        entries[index].actions = actions
    }
}
