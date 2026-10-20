import Foundation

/// A web terminalLinks.ts match; offsets are UTF-16, as in xterm.
public struct DetectedTerminalLink: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case url, path }
    public enum FileKind: Equatable, Sendable { case markdown, image, video, text }
    public let text: String
    public let target: String
    public let index: Int
    public let displayLength: Int
    public let kind: Kind
    public let fileKind: FileKind?
}

/// The web detector and path rules, independent of filesystem existence.
public enum TerminalLinks {
    private static let start = #"https?:\/\/|(?<![@\w.-])(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?|(?:[A-Za-z]:\\|\\\\)|(?<![\w])(?:~[\\/]|\/)(?=[A-Za-z0-9_.~])|(?<![@\w.-])(?:\.\.?[\\/])?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:md|markdown|mdx|png|jpe?g|gif|webp|bmp|avif|ico|svg|txt|tsx?|jsx?|json|ya?ml|toml|csv|pdf|mp4|m4v|mov|avi|mkv|webm|mp3|wav|flac|m4a|zip|7z|rar|tar|gz|exe|msi|dll)(?=$|[\s),.;:\]}`])"#
    private static let bareURL = #"^(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?"#
    private static let extensionBoundary = #"\.(?:md|markdown|mdx|png|jpe?g|gif|webp|bmp|avif|ico|svg|txt|tsx?|jsx?|json|ya?ml|toml|csv|pdf|mp4|m4v|mov|avi|mkv|webm|mp3|wav|flac|m4a|zip|7z|rar|tar|gz|exe|msi|dll)(?=$|[\s),.;:])"#

    private static let startExpression = try? NSRegularExpression(pattern: start, options: .caseInsensitive)

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    public struct Row: Sendable {
        public let text: String
        public let isWrapped: Bool
        public init(_ text: String, isWrapped: Bool = false) {
            self.text = text
            self.isWrapped = isWrapped
        }
    }

    public struct LogicalLine: Equatable, Sendable {
        public let text: String
        public let startLine: Int
    }

    /// One-based rows and columns, matching xterm's buffer/range API.
    public static func logicalLine(_ rows: [Row], lineNumber: Int) -> LogicalLine? {
        var start = lineNumber - 1
        guard rows.indices.contains(start) else { return nil }
        while start > 0, rows[start].isWrapped { start -= 1 }
        var end = start
        while end + 1 < rows.count, rows[end + 1].isWrapped { end += 1 }
        return LogicalLine(text: rows[start...end].map(\.text).joined(), startLine: start + 1)
    }

    public struct Cell: Equatable, Sendable {
        public let x: Int
        public let y: Int
    }

    public static func range(_ link: DetectedTerminalLink, startLine: Int, columns: Int) -> (start: Cell, end: Cell)? {
        guard columns > 0, link.displayLength > 0 else { return nil }
        let end = link.index + link.displayLength - 1
        return (Cell(x: link.index % columns + 1, y: startLine + link.index / columns),
                Cell(x: end % columns + 1, y: startLine + end / columns))
    }

    public static func stripLineColumn(_ text: String) -> String {
        text.replacingOccurrences(of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
    }

    public static func classify(_ text: String) -> DetectedTerminalLink.FileKind? {
        let clean = stripLineColumn(text)
        if matches(#"\.(md|markdown|mdx)$"#, clean) { return .markdown }
        if matches(#"\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$"#, clean) { return .image }
        if matches(#"\.(mp4|m4v|mov|avi|mkv|webm|ogv)$"#, clean) { return .video }
        return matches(#"\.[A-Za-z0-9]{1,12}$"#, clean) ? .text : nil
    }

    public static func relativePath(_ path: String) -> String? {
        let clean = stripLineColumn(path.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !matches(#"^(?:[A-Za-z]:[\\/]|\\\\|~(?:[\\/]|$)|/)"#, clean) else { return nil }
        return clean.replacingOccurrences(of: #"^\.([\\/])"#, with: "", options: .regularExpression)
    }

    public static func resolvePath(_ path: String, cwd: String?, home: String? = nil) -> String {
        let clean = stripLineColumn(path.trimmingCharacters(in: .whitespacesAndNewlines))
        func join(_ base: String, _ relative: String) -> String {
            let separator = base.contains("\\") ? "\\" : "/"
            let root = base.replacingOccurrences(of: #"[\\/]+$"#, with: "", options: .regularExpression)
            return relative.isEmpty ? root : root + separator + relative.replacingOccurrences(
                of: #"[\\/]"#, with: separator == "\\" ? "\\\\" : "/", options: .regularExpression)
        }
        if matches(#"^~(?:[\\/]|$)"#, clean) {
            return home.map { join($0, String(clean.dropFirst(min(2, clean.count)))) } ?? clean
        }
        guard let cwd, !matches(#"^(?:[A-Za-z]:[\\/]|\\\\|/)"#, clean) else { return clean }
        return join(cwd, clean.replacingOccurrences(of: #"^\.([\\/])"#, with: "", options: .regularExpression))
    }

    /// filesystem.rs find_relative_path: cwd first, then the newest worktree match, including
    /// a printed worktree-directory prefix (repo-feature/docs/report.md).
    public static func findRelativePath(_ relative: String, cwd: String, worktrees: [String],
        exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        modifiedAt: (String) -> Date? = {
            (try? FileManager.default.attributesOfItem(atPath: $0)[.modificationDate]) as? Date
        }) -> String? {
        guard !relative.isEmpty, relativePath(relative) != nil else { return nil }
        let direct = resolvePath(relative, cwd: cwd)
        if exists(direct) { return direct }
        let components = relative.split(separator: "/", omittingEmptySubsequences: true)
        var best: (path: String, date: Date)?
        for root in worktrees {
            var candidates = [resolvePath(relative, cwd: root)]
            if components.first.map(String.init) == URL(filePath: root).lastPathComponent {
                candidates.append(resolvePath(components.dropFirst().joined(separator: "/"), cwd: root))
            }
            for candidate in candidates {
                guard let date = modifiedAt(candidate) else { continue }
                if best == nil || date >= best!.date { best = (candidate, date) }
            }
        }
        return best?.path
    }

    public static func detect(_ line: String) -> [DetectedTerminalLink] {
        guard let expression = startExpression else { return [] }
        let source = line as NSString
        var links: [DetectedTerminalLink] = []
        for match in expression.matches(in: line, range: NSRange(location: 0, length: source.length)) {
            let index = match.range.location
            if links.contains(where: { index < $0.index + $0.displayLength }) { continue }
            let candidate = source.substring(with: match.range)
            let isURL = matches(#"^https?://"#, candidate) || matches(bareURL, candidate)
            let raw = source.substring(with: NSRange(location: index, length: end(in: source, start: index, url: isURL) - index))
            let display = raw.replacingOccurrences(of: #"[\s),.;:]+$"#, with: "", options: .regularExpression)
            guard !display.isEmpty else { continue }
            let text = isURL ? display : display.replacingOccurrences(of: "\\ ", with: " ")
            if !isURL, matches(#"^(?:~[\\/]|/)"#, text) {
                let clean = stripLineColumn(text)
                let withoutRoot = String(clean.dropFirst(clean.hasPrefix("~") ? 2 : 1))
                guard matches(#"[\\/]"#, withoutRoot) || classify(clean) != nil else { continue }
            }
            let target: String
            if isURL {
                if let colon = text.firstIndex(of: ":"), matches(#"^https?://"#, text) {
                    target = text[..<colon].lowercased() + text[colon...]
                } else {
                    target = (matches(#"^localhost(?::|/|$)"#, text) ? "http://" : "https://") + text
                }
            } else { target = text }
            links.append(DetectedTerminalLink(text: text, target: target, index: index,
                displayLength: (display as NSString).length, kind: isURL ? .url : .path,
                fileKind: isURL ? nil : classify(text)))
        }
        return links
    }

    private static func end(in line: NSString, start: Int, url: Bool) -> Int {
        func char(_ index: Int) -> String {
            guard index >= 0, index < line.length else { return "" }
            return line.substring(with: NSRange(location: index, length: 1))
        }
        let opener = char(start - 1)
        let closer = opener == "(" ? ")" : opener == "[" ? "]" : ""
        let bracket = closer.isEmpty || url ? NSNotFound : line.range(of: closer,
            range: NSRange(location: start, length: line.length - start)).location
        var end = start
        while end < line.length {
            if bracket != NSNotFound, end >= bracket { break }
            let character = char(end)
            if ["\t", "\r", "\n", "<", ">", "\"", "'", "`", "|"].contains(character) { break }
            if url, matches(#"\s"#, character) { break }
            if character == " ", char(end + 1) == " " { break }
            if character == " ", !url {
                let soFar = line.substring(with: NSRange(location: start, length: end - start))
                if soFar.hasSuffix("/") || (matches(#"^(?:[A-Za-z]:\\|\\\\|~\\)"#, soFar) && soFar.hasSuffix("\\")) { break }
                if char(end - 1) != "\\", !matches(extensionBoundary, line.substring(from: end + 1)) { break }
            }
            if character == " ", matches(#"^(?:https?://|[A-Za-z]:\\|\\\\|~[\\/]|/)"#, line.substring(from: end + 1)) { break }
            end += 1
            if !url, classify(line.substring(with: NSRange(location: start, length: end - start))) != nil {
                let next = char(end)
                let suffix = next == ":" && matches(#"\d"#, char(end + 1))
                if next.isEmpty || (!suffix && matches(#"[\s),.;:]"#, next)) { break }
            }
        }
        return end
    }
}
