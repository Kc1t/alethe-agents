import Foundation

/// Schema-compatible with the web's CustomAgentDefinition and discriminated iconSpec.
public struct CustomAgentDefinition: Codable, Hashable, Sendable, Identifiable {
    public var id = ""
    public var label = ""
    public var cliCommand = ""
    public var unrestrictedFlag: String?
    public var accentToken: String? = "--agent-shell"
    public var icon: String? = "bot"
    public var iconSpec: CustomAgentIconSpec? = .init(kind: "preset", key: "bot")
    public init() {}
    public static let accents = ["shell", "claude", "codex", "opencode", "cursor", "copilot", "antigravity", "kiro", "freebuff", "mimo"].map { "--agent-" + $0 }
    public static let icons = ["bot", "shell", "wsl", "claude", "codex", "copilot", "cursor", "opencode", "antigravity", "kiro", "mimo", "freebuff"]
    public static func isID(_ id: String) -> Bool { id.range(of: #"^[a-z0-9-]{2,32}$"#, options: .regularExpression) != nil }
    public static func validURL(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf16.count <= 512, let url = URLComponents(string: text), url.scheme == "https",
              url.user == nil, url.password == nil, let host = url.host, !host.isEmpty else { return false }
        return ["png", "jpg", "jpeg"].contains((url.path as NSString).pathExtension.lowercased())
    }
    public var tokens: [String]? { Self.tokenize(cliCommand) }
    public static func tokenize(_ text: String) -> [String]? {
        var tokens: [String] = [], current = ""
        var quote: Character?, started = false
        let forbidden = CharacterSet(charactersIn: ";&|`$()><\n\r\0")
        for char in text {
            if char.unicodeScalars.contains(where: forbidden.contains) { return nil }
            if let active = quote {
                if char == active { quote = nil } else { current.append(char) }
                started = true
            } else if char == "\"" || char == "'" { quote = char; started = true }
            else if char == " " || char == "\t" {
                if started { tokens.append(current); current = ""; started = false }
            } else { current.append(char); started = true }
        }
        guard quote == nil else { return nil }
        if started { tokens.append(current) }
        guard let binary = tokens.first, !binary.isEmpty, binary.utf16.count <= 128,
              binary.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last?
                .range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil,
              tokens.dropFirst().allSatisfy({ !$0.isEmpty && $0.utf16.count <= 256 }) else { return nil }
        return tokens
    }
    public func validationError(existing: [Self], builtins: Set<String>, editing: String?) -> String? {
        if !Self.isID(id) { return "idFormat" }
        if builtins.contains(id) { return "idBuiltin" }
        if existing.contains(where: { $0.id.lowercased() == id && $0.id != editing }) { return "idTaken" }
        if label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || label.utf16.count > 48 { return "labelEmpty" }
        if cliCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "cliEmpty" }
        if tokens == nil { return "cliUnsafe" }
        if let flag = unrestrictedFlag, !flag.isEmpty,
           (!flag.hasPrefix("-") || flag.utf16.count > 64 || flag.rangeOfCharacter(from: .whitespacesAndNewlines) != nil || Self.tokenize("agent " + flag) == nil) { return "cliUnsafe" }
        if let accentToken, !Self.accents.contains(accentToken) { return "cliUnsafe" }
        if let icon, !Self.icons.contains(icon) { return "cliUnsafe" }
        if let spec = iconSpec {
            switch spec.kind {
            case "preset": if !Self.icons.contains(spec.key ?? "") { return "cliUnsafe" }
            case "url": if !Self.validURL(spec.href ?? "") { return "iconUrl" }
            case "file": if spec.assetId != id { return "iconFile" }
            default: return "iconFile"
            }
        }
        return nil
    }
    public static func icoError(_ data: Data) -> String? {
        if data.count > 512 * 1024 { return "iconFileTooLarge" }
        let bytes = [UInt8](data)
        guard bytes.count >= 4, Array(bytes.prefix(4)) == [0, 0, 1, 0] else { return "iconFileInvalid" }
        if bytes.count >= 8, bytes[6] != bytes[7] { return "iconFileNotSquare" }
        return nil
    }
}

public struct CustomAgentIconSpec: Codable, Hashable, Sendable {
    public var kind: String
    public var key: String?
    public var href: String?
    public var assetId: String?
    public init(kind: String, key: String? = nil, href: String? = nil, assetId: String? = nil) {
        self.kind = kind; self.key = key; self.href = href; self.assetId = assetId
    }
}
