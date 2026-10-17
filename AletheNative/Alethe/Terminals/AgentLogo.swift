import AletheDesign
import AppKit
import SwiftUI

/// An agent's brand logo (upstream `AgentIcon`, `src/components/icons/AgentIcons.tsx`), drawn at a
/// square size. Agents without a bundled logo fall back to an SF Symbol tinted with the agent color.
struct AgentLogo: View {
    let agent: String
    var size: CGFloat = 16
    var templateColor: Color? = nil
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let side = metrics.size(size)
        Group {
            if let asset = Self.asset(for: agent, isLight: theme.isLight),
               metrics.isWebInterface || !Self.webOnlyAgents.contains(agent) {
                assetImage(asset, side: side)
                    .resizable()
                    .renderingMode(asset.template ? .template : .original)
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(templateColor ?? theme[.fgMuted])
            } else {
                Image(systemName: metrics.isWebInterface ? "cpu" : "sparkles")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(theme[AgentTokens.accent(for: agent)])
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }

    private func assetImage(_ asset: Asset, side: CGFloat) -> Image {
        if metrics.isWebInterface, let image = Self.menuImage(for: agent, isLight: theme.isLight, side: side) {
            return Image(nsImage: image)
        }
        return Image(asset.name)
    }

    /// AppKit menus can use a bitmap's intrinsic dimensions despite the SwiftUI label frame.
    static func menuImage(for agent: String, isLight: Bool, side: CGFloat) -> NSImage? {
        guard let asset = asset(for: agent, isLight: isLight),
              let source = NSImage(named: asset.name), let image = source.copy() as? NSImage else { return nil }
        image.size = NSSize(width: side, height: side)
        image.isTemplate = asset.template
        return image
    }

    private static let webOnlyAgents: Set<String> = ["mimo", "cursor", "copilot", "kimi", "grok", "codewhale", "wsl"]

    struct Asset: Equatable {
        let name: String
        let template: Bool
    }

    /// Asset catalog image for an agent id (`AgentKind.rawValue`), nil when none is bundled.
    static func asset(for agent: String, isLight: Bool) -> Asset? {
        switch agent {
        case "claude": Asset(name: "AgentLogo-claude", template: false)
        case "codex": Asset(name: "AgentLogo-codex", template: false)
        case "freebuff": Asset(name: "AgentLogo-freebuff", template: false)
        case "antigravity": Asset(name: "AgentLogo-antigravity", template: false)
        case "kiro": Asset(name: "AgentLogo-kiro", template: false)
        case "opencode": Asset(name: isLight ? "AgentLogo-opencode-light" : "AgentLogo-opencode-dark", template: false)
        case "mimo": Asset(name: "AgentLogo-mimo", template: true)
        case "cursor": Asset(name: "AgentLogo-cursor", template: true)
        case "copilot": Asset(name: "AgentLogo-copilot", template: true)
        case "kimi": Asset(name: "AgentLogo-kimi", template: true)
        case "grok": Asset(name: "AgentLogo-grok", template: true)
        case "codewhale": Asset(name: "AgentLogo-codewhale", template: true)
        case "wsl": Asset(name: "AgentLogo-wsl", template: true)
        case "shell": Asset(name: "AgentLogo-shell", template: true)
        default: nil
        }
    }
}
