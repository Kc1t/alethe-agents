import Foundation

/// How long a hidden web pane keeps its page alive (upstream `BrowserResourceMode`).
public enum WebResourceMode: String, Codable, CaseIterable, Hashable, Sendable {
    case appFirst = "app-first"
    case balanced
    case keepAlive = "keep-alive"

    /// Seconds a hidden page may stay loaded before it is released; nil: never released. Under memory
    /// pressure every hidden page goes at once (upstream `browserHiddenEvictionDelay`).
    public func hiddenEvictionDelay(underMemoryPressure: Bool) -> Duration? {
        if underMemoryPressure { return .zero }
        switch self {
        case .appFirst: return .seconds(1)
        case .balanced: return .seconds(30)
        case .keepAlive: return nil
        }
    }
}

/// Per-pane browser settings (upstream `BrowserPaneConfig`, minus the CDP engine the native app does
/// not have).
public struct WebPaneOptions: Codable, Hashable, Sendable {
    public var resourceMode: WebResourceMode
    public var javascriptEnabled: Bool
    public var zoom: Double
    public var name: String?

    public static let zoomRange = 0.5...2.0

    public init(resourceMode: WebResourceMode = .appFirst, javascriptEnabled: Bool = true, zoom: Double = 1, name: String? = nil) {
        self.resourceMode = resourceMode
        self.javascriptEnabled = javascriptEnabled
        self.zoom = zoom
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.name = trimmedName?.isEmpty == false ? trimmedName : nil
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        resourceMode = try container.decodeIfPresent(WebResourceMode.self, forKey: .resourceMode) ?? .appFirst
        javascriptEnabled = try container.decodeIfPresent(Bool.self, forKey: .javascriptEnabled) ?? true
        zoom = try container.decodeIfPresent(Double.self, forKey: .zoom) ?? 1
        name = try container.decodeIfPresent(String.self, forKey: .name)
    }
}

public enum WebAddress {
    /// What was typed, as an http(s) URL (upstream `normalizeBrowserUrl`): public hosts default to
    /// https, local development addresses to http; other schemes and junk are refused.
    public static func normalize(_ value: String) -> URL? {
        let input = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return nil }
        let hasScheme = input.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil
        let isLocal = input.range(of: #"^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?(/|$)"#,
                                  options: [.regularExpression, .caseInsensitive]) != nil
        if !hasScheme, !isLocal,
           input.range(of: #"^[a-z][a-z\d+.-]*:"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return nil
        }
        let candidate = hasScheme ? input : "\(isLocal ? "http" : "https")://\(input)"
        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return nil }
        // WHATWG URL (upstream) gives a bare origin a "/" path.
        if components.path.isEmpty { components.path = "/" }
        return components.url
    }
}
