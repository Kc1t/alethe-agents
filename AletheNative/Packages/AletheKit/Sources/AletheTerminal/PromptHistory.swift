import Foundation

/// Prompt history built from what the user types in a terminal (port of upstream
/// `applyPromptHistoryInput` + `navigateHistory` in `XTermView`): submitted lines of 2+ characters,
/// no consecutive duplicates, the last 50 kept, large pastes never retained.
public struct PromptHistory: Equatable, Sendable {
    public static let maxTrackedPromptLength = 4 * 1024
    public static let maxEntries = 50

    public private(set) var entries: [String]
    var currentLine = ""
    var overflow = false
    /// Position while recalling (`entries.count` = past the newest); nil when not recalling.
    var cursor: Int?
    /// Inside an escape sequence (arrow keys, bracketed-paste markers), which is not prompt text.
    var escape: Escape = .none

    enum Escape: Equatable, Sendable {
        case none
        /// After ESC.
        case started
        /// After ESC [ or ESC O, until the final byte.
        case sequence
    }

    public init(entries: [String] = []) {
        var clean: [String] = []
        for entry in entries {
            let line = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (2...Self.maxTrackedPromptLength).contains(line.utf16.count),
                  !line.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }),
                  clean.last != line else { continue }
            clean.append(line)
            if clean.count > Self.maxEntries { clean.removeFirst() }
        }
        self.entries = clean
    }

    /// Feeds keyboard input; true when `entries` changed.
    @discardableResult
    public mutating func record(_ data: String) -> Bool {
        if data.utf16.count > Self.maxTrackedPromptLength {
            currentLine = ""
            overflow = !data.hasSuffix("\r") && !data.hasSuffix("\n")
            return false
        }
        var changed = false
        for character in data {
            if skipEscape(character) { continue }
            switch character {
            // "\r\n" is one Character in Swift.
            case "\r", "\n", "\r\n":
                let line = overflow ? "" : currentLine.trimmingCharacters(in: .whitespaces)
                currentLine = ""
                overflow = false
                cursor = nil
                guard line.utf16.count >= 2, entries.last != line else { continue }
                entries.append(line)
                if entries.count > Self.maxEntries { entries.removeFirst() }
                changed = true
            case "\u{8}", "\u{7f}":
                if !overflow, !currentLine.isEmpty { currentLine.removeLast() }
            case "\u{3}", "\u{15}":
                currentLine = ""
                overflow = false
                cursor = nil
            default:
                guard !overflow, let scalar = character.unicodeScalars.first, scalar.value >= 0x20 else { continue }
                if currentLine.utf16.count + String(character).utf16.count <= Self.maxTrackedPromptLength {
                    currentLine.append(character)
                } else {
                    currentLine = ""
                    overflow = true
                }
            }
        }
        return changed
    }

    /// Consumes `character` when it belongs to an escape sequence (not in upstream, whose xterm
    /// input kept arrows as "[A" in the line).
    private mutating func skipEscape(_ character: Character) -> Bool {
        let value = character.unicodeScalars.first?.value ?? 0
        switch escape {
        case .none:
            guard value == 0x1b else { return false }
            escape = .started
        case .started:
            escape = character == "[" || character == "O" ? .sequence : .none
        case .sequence:
            // Parameters and intermediates run 0x20–0x3F; a final byte 0x40–0x7E ends the sequence.
            if (0x40...0x7e).contains(value) { escape = .none }
        }
        return true
    }

    public enum Direction: Sendable { case older, newer }

    /// The entry to show next, or nil with no history. Past the newest entry comes an empty line.
    public mutating func recall(_ direction: Direction) -> String? {
        guard !entries.isEmpty else { return nil }
        var position: Int
        if let cursor {
            position = direction == .older ? cursor - 1 : cursor + 1
        } else {
            position = direction == .older ? entries.count - 1 : entries.count
        }
        position = max(0, min(entries.count, position))
        cursor = position
        let entry = position < entries.count ? entries[position] : ""
        currentLine = entry
        overflow = false
        return entry
    }

    /// Repeated reverse search continues before the previous hit (Ctrl+R). Matching is literal,
    /// so shell syntax and regex metacharacters remain ordinary prompt text.
    public mutating func reverseSearch(_ query: String) -> String? {
        let end = min(cursor ?? entries.count, entries.count)
        guard end > 0, let index = entries[..<end].lastIndex(where: { $0.contains(query) }) else { return nil }
        cursor = index
        currentLine = entries[index]
        overflow = false
        return currentLine
    }

    /// What recalling writes to the terminal: ⌃U clears the line, then the entry is typed.
    public static func recallInput(_ entry: String) -> String { "\u{15}" + entry }
}
