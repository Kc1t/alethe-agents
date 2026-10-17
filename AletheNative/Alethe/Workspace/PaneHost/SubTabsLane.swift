import AletheDesign
import AletheModel
import SwiftUI

/// Vertical strip of a pane's sub-tabs (upstream `SubTabsLane`): one agent icon per tab, the active
/// one marked by an accent bar, a close button on hover when there is more than one tab, and + to add.
/// Closing is undoable (⌘Z), so it does not ask first as upstream does.
struct SubTabsLane: View {
    let pane: Pane
    let isFocused: Bool
    let onActivate: (TabID) -> Void
    let onClose: (TabID) -> Void
    let onRestart: (PaneTab) -> Void
    let onAdd: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webLane } else { nativeLane }
    }

    private var webLane: some View {
        ScrollView(.vertical) {
            VStack(spacing: metrics.size(5)) {
                ForEach(pane.tabs) { tab in
                    SubTabItem(tab: tab, isActive: tab.id == pane.activeTab?.id, isFocused: isFocused,
                               canClose: pane.tabs.count > 1,
                               onActivate: { onActivate(tab.id) }, onClose: { onClose(tab.id) },
                               onRestart: { onRestart(tab) })
                }
                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .font(metrics.font(size: 12))
                        .frame(width: metrics.size(26), height: metrics.size(26))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(6))
                            .strokeBorder(theme[.borderStrong], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(3), metrics.size(2)])))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme[.fgFaint])
                .padding(.top, metrics.size(6))
                .help(Text("subtabs.new"))
                .accessibilityLabel(Text("subtabs.new"))
                .accessibilityIdentifier("subtabs.new")
            }
            .padding(.vertical, metrics.size(6))
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.never)
        .frame(width: metrics.size(36))
        .background(theme[.shapeTabsLaneBg])
        .overlay(alignment: .trailing) { theme[.shapeTabsLaneBorder].frame(width: metrics.size(1)) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subtabs.lane")
    }

    private var nativeLane: some View {
        VStack(spacing: metrics.isWebInterface ? metrics.size(5) : metrics.space(.xs)) {
            ScrollView(.vertical) {
                VStack(spacing: metrics.size(5)) {
                    ForEach(pane.tabs) { tab in
                        SubTabItem(tab: tab, isActive: tab.id == pane.activeTab?.id, isFocused: isFocused,
                                   canClose: pane.tabs.count > 1,
                                   onActivate: { onActivate(tab.id) }, onClose: { onClose(tab.id) },
                                   onRestart: { onRestart(tab) })
                            .transition(.scale(scale: 0.85).combined(with: .opacity))
                    }
                }
                .padding(.vertical, metrics.space(.s))
                .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: pane.tabs.map(\.id))
            }
            .scrollIndicators(.never)
            .frame(maxHeight: metrics.isWebInterface ? nil : .infinity, alignment: .top)

            Button(action: onAdd) {
                Image(systemName: "plus")
                    .font(metrics.font(.caption).weight(.semibold))
                    .frame(width: metrics.size(26), height: metrics.size(26))
                    .overlay(
                        RoundedRectangle(cornerRadius: metrics.size(6))
                            .strokeBorder(theme[.borderStrong], style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme[.fgFaint])
            .help(Text("subtabs.new"))
            .accessibilityLabel(Text("subtabs.new"))
            .accessibilityIdentifier("subtabs.new")
            .padding(.top, metrics.isWebInterface ? metrics.size(6) : 0)
            .padding(.bottom, metrics.space(.s))
        }
        .frame(width: metrics.size(36))
        .frame(maxHeight: .infinity, alignment: .top)
        .background(theme[.shapeTabsLaneBg])
        .overlay(alignment: .trailing) {
            Rectangle().fill(theme[.shapeTabsLaneBorder]).frame(width: metrics.size(1))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subtabs.lane")
    }
}

private struct SubTabItem: View {
    let tab: PaneTab
    let isActive: Bool
    let isFocused: Bool
    let canClose: Bool
    let onActivate: () -> Void
    let onClose: () -> Void
    let onRestart: () -> Void
    @State private var isHovered = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @Environment(AppEnvironment.self) private var environment
    private var name: String { environment.terminals.displayName(of: tab) }

    var body: some View {
        Button(action: onActivate) {
            Group {
                if metrics.isWebInterface {
                    AgentLogo(agent: tab.agent, size: 14,
                              templateColor: theme[isActive || isHovered ? AgentTokens.accent(for: tab.agent) : .fgMuted])
                } else {
                    Image(systemName: tab.agent == "shell" ? "terminal" : "sparkles")
                        .font(metrics.font(.footnote))
                }
            }
                .foregroundStyle(theme[isActive || isHovered ? AgentTokens.accent(for: tab.agent) : .fgMuted])
                .frame(width: metrics.size(26), height: metrics.size(26))
                // Upstream: accent-soft on hover; the active item a selected card with an inset border.
                .background(
                    RoundedRectangle(cornerRadius: metrics.size(6))
                        .fill(isActive ? theme[.surfaceCardSelected] : theme[.accentSoft].opacity(isHovered ? 1 : 0))
                )
                .overlay {
                    if isActive { RoundedRectangle(cornerRadius: metrics.size(6)).strokeBorder(theme[.border]) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            if isActive {
                // Accent bar on the lane's leading edge (upstream `.active::before`).
                RoundedRectangle(cornerRadius: metrics.size(1))
                    .fill(theme[metrics.isWebInterface || isFocused ? .accent : .borderStrong])
                    .frame(width: metrics.size(2), height: metrics.size(16))
                    .shadow(color: isFocused && (!metrics.isWebInterface || metrics.style != .clean) ? theme[.accentRing] : .clear, radius: metrics.size(4))
                    .offset(x: -metrics.size(5))
            }
        }
        .overlay(alignment: .bottomTrailing) {
            AgentStatusGlyph(tab: tab.id)
                .allowsHitTesting(false)
        }
        .overlay(alignment: .topTrailing) {
            if canClose && isHovered {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(metrics.font(size: 7, weight: .bold))
                        .frame(width: metrics.size(12), height: metrics.size(12))
                        .background(Circle().fill(theme[.bgElevated]))
                        .overlay(Circle().strokeBorder(theme[.border]))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme[.textSecondary])
                .offset(x: metrics.size(metrics.isWebInterface ? 4 : 3), y: -metrics.size(metrics.isWebInterface ? 4 : 3))
                .help(Text("subtabs.close"))
                .accessibilityLabel(Text("subtabs.close"))
                .accessibilityIdentifier("subtabs.close")
            }
        }
        .onHover { isHovered = $0 }
        .help(Text(verbatim: name))
        .contextMenu {
            if metrics.isWebInterface {
                Button(action: onRestart) { Label("terminal.restart", systemImage: "arrow.clockwise") }
                if canClose {
                    Divider()
                    Button(action: onClose) { Label("subtabs.close", systemImage: "xmark") }
                }
            } else {
                Button("terminal.restart", action: onRestart)
                if canClose {
                    Divider()
                    Button("subtabs.close", action: onClose)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: name))
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .accessibilityIdentifier("subtab.\(tab.title ?? tab.agent)")
    }
}
