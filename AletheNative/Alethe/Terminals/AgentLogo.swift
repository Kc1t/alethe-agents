import AletheDesign
import SwiftUI

/// An agent's brand logo (upstream `AgentIcon`, `src/components/icons/AgentIcons.tsx`), drawn at a
/// square size. Agents without a bundled logo fall back to an SF Symbol tinted with the agent color.
struct AgentLogo: View {
    let agent: String
    var size: CGFloat = 16
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let side = metrics.size(size)
        Group {
            if let asset = Self.asset(for: agent, isLight: theme.isLight) {
                Image(asset.name)
                    .resizable()
                    .renderingMode(asset.template ? .template : .original)
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(theme[.fgMuted])
            } else {
                Image(systemName: "sparkles")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(theme[AgentTokens.accent(for: agent)])
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }

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
        case "shell": Asset(name: "AgentLogo-shell", template: true)
        default: nil
        }
    }
}
