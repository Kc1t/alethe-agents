import Foundation
import Observation

/// Find-bar state of one terminal. Ghostty does the matching (case-insensitive, all matches
/// highlighted) and reports progress; `TerminalPaneView` keeps this in sync.
@Observable
@MainActor
public final class TerminalSearch {
    public internal(set) var isPresented = false
    /// What the find bar shows; set through `TerminalPaneView.updateSearch`.
    public internal(set) var needle = ""
    /// Matches in the whole scrollback; nil while nothing is searched (or still counting).
    public internal(set) var total: Int?
    /// 0-based index of the current match.
    public internal(set) var selected: Int?
    /// Bumped whenever the find field should take the keyboard (⌘F while already open included).
    public internal(set) var focusRequest = 0

    /// "3 of 12", "No results" or nothing, for the find bar.
    public enum Status: Equatable, Sendable {
        case none
        case noResults
        case match(position: Int, total: Int)
        case count(Int)
    }

    public var status: Status {
        guard !needle.isEmpty, let total else { return .none }
        if total == 0 { return .noResults }
        if let selected, selected < total { return .match(position: selected + 1, total: total) }
        return .count(total)
    }

    /// A changed web query starts counting again; never show the previous query's result count.
    /// Native callers retain their existing progress behavior until Ghostty reports an update.
    func setNeedle(_ text: String, resetProgress: Bool) -> String {
        let next = Self.bindingNeedle(text)
        if next.isEmpty || (resetProgress && next != needle) {
            total = nil
            selected = nil
        }
        needle = next
        return next
    }

    /// Ghostty's `search:` binding argument: one line, no control characters.
    nonisolated static func bindingNeedle(_ text: String) -> String {
        String(text.prefix { !$0.isNewline }.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
    }
}
