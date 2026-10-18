import AletheDesign
import AletheModel
import SwiftUI

extension Notification.Name {
    static let aletheCustomizeTitleBar = Notification.Name("alethe.customizeTitleBar")
}

/// TopbarSettingsModal.tsx: seven 42-point rows, provider artwork and trailing checked squares.
struct WebTitleBarCustomization: View {
    let close: () -> Void

    var body: some View {
        WebTitleBarAnalytics(title: "settings.toolbar", close: close) { WebTitleBarCustomizationContent() }
    }
}

/// The modal's body, shared by the title-bar overlay and Settings › Appearance › Customize topbar.
struct WebTitleBarCustomizationContent: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    private let items: [ToolbarItemKind] = [.usageClaude, .usageCodex, .usageAntigravity, .sync, .profile, .memory, .router9]

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            Text("titlebar.customize.description").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
            VStack(spacing: metrics.size(6)) {
                ForEach(items, id: \.self) { item in
                    WebTitleBarCustomizationRow(item: item, enabled: environment.preferences?.document.showsToolbarItem(item) ?? item.shownByDefault) {
                        environment.preferences?.update {
                            $0.setToolbarItem(item, shown: !$0.showsToolbarItem(item))
                        }
                    }
                }
            }
        }
    }
}

private struct WebTitleBarCustomizationRow: View {
    let item: ToolbarItemKind
    let enabled: Bool
    let action: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: metrics.size(10)) {
                Group {
                    switch item {
                    case .usageClaude: AgentLogo(agent: "claude", size: 18)
                    case .usageCodex: AgentLogo(agent: "codex", size: 18)
                    case .usageAntigravity: AgentLogo(agent: "antigravity", size: 18)
                    default:
                        Image(systemName: symbol).resizable().scaledToFit()
                            .frame(width: metrics.size(18), height: metrics.size(18)).foregroundStyle(theme[.fgMuted])
                    }
                }.frame(width: metrics.size(22))
                Text(item.title).font(metrics.font(size: 13))
                Spacer(minLength: 0)
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .fill(theme[.accent].opacity(enabled ? 1 : 0))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[enabled ? .accent : .borderStrong], lineWidth: metrics.size(1)))
                    .overlay {
                        Image(systemName: "checkmark").resizable().scaledToFit()
                            .frame(width: metrics.size(14), height: metrics.size(14))
                            .foregroundStyle(theme[.bg]).opacity(enabled ? 1 : 0)
                    }
                    .frame(width: metrics.size(20), height: metrics.size(20))
            }
            .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(8))
            .frame(minHeight: metrics.size(42))
            .background(theme[hovering ? .panelHover : .panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[hovering ? .borderStrong : .border], lineWidth: metrics.size(1)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
        .accessibilityValue(Text(enabled ? "titlebar.customize.on" : "titlebar.customize.off"))
        .accessibilityIdentifier("settings.toolbar.\(item.rawValue)")
    }

    private var symbol: String {
        switch item {
        case .sync: "icloud"
        case .profile: "person"
        case .memory: "memorychip"
        default: "point.3.connected.trianglepath.dotted"
        }
    }
}

/// TopbarSettingsModal as opened from Settings: the same chrome and rows as the title-bar overlay.
struct WebSettingsToolbarModal: View {
    @Environment(\.modalsM2Close) private var closeOverlay

    var body: some View {
        ModalsM2WebModal(title: Text("settings.toolbar"), close: { closeOverlay?() }, width: 440) {
            WebTitleBarCustomizationContent()
        } footer: {}
    }
}
