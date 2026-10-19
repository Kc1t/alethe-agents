import Foundation

/// Where a ⌘-clicked terminal link goes (upstream `terminalLinks.ts` + `XTermView` link actions).
/// Ghostty detects the link (URLs, rooted or relative paths, OSC 8 hyperlinks); this decides what it
/// means once clicked.
public enum TerminalLink: Equatable, Sendable {
    /// An http(s) page.
    case web(URL)
    /// An existing file, with the line (and column) an agent printed after it, if any.
    case file(path: String, line: Int?)
    case directory(path: String)
    /// Another scheme (mailto:, ssh:…), handed to the system.
    case other(URL)
    /// Nothing that exists or can be opened.
    case none

    /// Web `terminalLinks.ts`: bare localhost uses HTTP; deployment domains use HTTPS. Keep this
    /// separate from `resolve` so the macOS profile's existing routing does not change.
    public static func resolveWeb(_ raw: String, cwd: String?, home: String = NSHomeDirectory(),
                                  fileKind: (String) -> Bool? = TerminalLink.fileKind) -> TerminalLink {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = text.first, "([{'\"`".contains(first) { text.removeFirst() }
        while let last = text.last, ".,;:)]}'\"`".contains(last) { text.removeLast() }
        let bare = #"^(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:/[^\s<>\"'`|]*)?$"#
        if text.range(of: bare, options: [.regularExpression, .caseInsensitive]) != nil {
            let local = text.range(of: #"^localhost(?::|/|$)"#, options: [.regularExpression, .caseInsensitive]) != nil
            let scheme = local ? "http" : "https"
            return resolve("\(scheme)://\(text)", cwd: cwd, home: home, fileKind: fileKind)
        }
        if text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://"),
           let colon = text.firstIndex(of: ":") {
            text = text[..<colon].lowercased() + text[colon...]
        } else {
            text = text.replacingOccurrences(of: "\\ ", with: " ")
        }
        return resolve(text, cwd: cwd, home: home, fileKind: fileKind)
    }

    /// - Parameters:
    ///   - raw: the text Ghostty reports for the link.
    ///   - cwd: the terminal's working directory, for relative paths.
    ///   - fileKind: whether a path exists and is a directory (nil: missing); injected for tests.
    public static func resolve(_ raw: String, cwd: String?, home: String = NSHomeDirectory(),
                               fileKind: (String) -> Bool? = TerminalLink.fileKind) -> TerminalLink {
        // Sentence punctuation after a link, and quotes or brackets around it; a leading `.` stays
        // (`./file`, `../dir`, `.env`).
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = text.last, ".,;:)]}'\"`".contains(last) { text.removeLast() }
        while let first = text.first, "([{'\"`".contains(first) { text.removeFirst() }
        guard !text.isEmpty else { return .none }

        // `README.md:12` parses as a URL with scheme "README.md": a scheme has no dots, and a
        // location suffix is not a URL.
        if text.firstMatch(of: /^[A-Za-z][A-Za-z0-9+\-]*:(?!\d+(:\d+)?$)/) != nil,
           let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme.count > 1 {
            switch scheme {
            case "http", "https": return .web(url)
            case "file": return resolvePath(url.path, line: nil, cwd: cwd, home: home, fileKind: fileKind)
            default: return .other(url)
            }
        }
        // `path:12` or `path:12:4`, as compilers and agents print locations.
        var path = text
        var line: Int?
        if let match = text.firstMatch(of: /^(.+?):(\d+)(?::\d+)?$/) {
            path = String(match.1)
            line = Int(match.2)
        }
        return resolvePath(path, line: line, cwd: cwd, home: home, fileKind: fileKind)
    }

    private static func resolvePath(_ raw: String, line: Int?, cwd: String?, home: String,
                                    fileKind: (String) -> Bool?) -> TerminalLink {
        let decoded = raw.removingPercentEncoding ?? raw
        var path: String
        if decoded == "~" {
            path = home
        } else if decoded.hasPrefix("~/") {
            path = home + decoded.dropFirst(1)
        } else if decoded.hasPrefix("/") {
            path = decoded
        } else if let cwd {
            path = URL(filePath: cwd, directoryHint: .isDirectory).appending(path: decoded).path
        } else {
            return .none
        }
        path = URL(filePath: path).standardizedFileURL.path
        switch fileKind(path) {
        case true?: return .directory(path: path)
        case false?: return .file(path: path, line: line)
        case nil: return .none
        }
    }

    /// true: a directory, false: a file, nil: nothing there.
    public static func fileKind(_ path: String) -> Bool? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return nil }
        return isDirectory.boolValue
    }

    /// OSC 7 reports `file://host/path`; Ghostty may pass it on as a URL or a plain path.
    public static func workingDirectory(fromReported value: String) -> String? {
        if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
        return value.hasPrefix("/") ? value : nil
    }
}
