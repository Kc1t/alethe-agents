import AletheFoundation
import Foundation

/// An item of the main window's toolbar (UI-7, upstream `TopbarSettingsModal`). Shown or hidden in
/// Settings › Toolbar (stored in `PreferencesDocument.toolbarItems`); arranged through
/// View › Customize Toolbar…, which AppKit stores itself.
public enum ToolbarItemKind: String, CaseIterable, Codable, Hashable, Sendable {
    case home
    case usageClaude = "usage.claude"
    case usageCodex = "usage.codex"
    case usageAntigravity = "usage.antigravity"
    /// The AI Usage button.
    case aiUsage = "usage"
    case notifications
    case memory
    case profile
    /// Remote control's pill; it shows only while remote control is on.
    case remote
    /// 9router's status pill (upstream `topbarShowRouter9`, hidden by default).
    case router9
    /// GitHub gist sync (upstream `topbarShowSync`).
    case sync

    /// Providers with a usage pill, in toolbar order.
    public static let usageProviders = ["claude", "codex", "antigravity"]

    public static func usagePill(for provider: String) -> ToolbarItemKind? {
        ToolbarItemKind(rawValue: "usage.\(provider)")
    }

    /// The provider of a usage pill; nil for every other item.
    public var usageProvider: String? {
        guard rawValue.hasPrefix("usage.") else { return nil }
        return String(rawValue.dropFirst("usage.".count))
    }

    /// Authenticated usage providers are visible unless explicitly disabled.
    public var shownByDefault: Bool { self != .router9 }

    /// When the window is too narrow, lower ranks go to the overflow menu first (ADR-7a
    /// `ToolbarItemVisibilityPriority`, macOS 26.1 and later).
    public var overflowRank: ToolbarOverflowRank {
        switch self {
        case .usageClaude, .usageCodex, .usageAntigravity: .first
        case .memory, .aiUsage, .router9, .sync: .early
        case .notifications, .remote: .standard
        case .home, .profile: .last
        }
    }
}

public enum ToolbarOverflowRank: Int, Comparable, Sendable {
    case first, early, standard, last

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

extension PreferencesDocument {
    public func showsToolbarItem(_ item: ToolbarItemKind) -> Bool {
        toolbarItems?[item.rawValue] ?? item.shownByDefault
    }

    /// Only choices that differ from the default are stored.
    public mutating func setToolbarItem(_ item: ToolbarItemKind, shown: Bool) {
        var items = toolbarItems ?? [:]
        items[item.rawValue] = shown == item.shownByDefault ? nil : shown
        toolbarItems = items.isEmpty ? nil : items
    }

    /// Providers whose usage pill is shown, in toolbar order.
    public var usagePillProviders: [String] {
        ToolbarItemKind.usageProviders.filter { provider in
            ToolbarItemKind.usagePill(for: provider).map(showsToolbarItem) ?? false
        }
    }

    /// v1 → v2 (P5-13): P3-13's `usagePills` list becomes the usage pill toolbar items.
    static func migrateUsagePills(_ object: inout JSONObject) {
        guard let pills = object.removeValue(forKey: "usagePills") else { return }
        let shown = Set(pills.arrayValue?.compactMap(\.stringValue) ?? [])
        var items = object["toolbarItems"]?.objectValue ?? [:]
        for provider in ToolbarItemKind.usageProviders {
            if let item = ToolbarItemKind.usagePill(for: provider) { items[item.rawValue] = .bool(shown.contains(provider)) }
        }
        if !items.isEmpty { object["toolbarItems"] = .object(items) }
    }
}
