import AletheDesign
import AletheModel
import SwiftUI

/// Vertical strip of a pane's sub-tabs (upstream `SubTabsLane`): one agent icon per tab, the active
/// one marked by an accent bar, a close button on hover when there is more than one tab, and + to add.
/// Closing is undoable (⌘Z), so it does not ask first as upstream does.
struct SubTabsLane: View {
    let pane: Pane
    let isFocused: Bool
    var canDragPane: Bool = true
    var onDrag: (CGSize?) -> Void = { _ in }
    let onActivate: (TabID) -> Void
    let onClose: (TabID) -> Void
    let onRestart: (PaneTab) -> Void
    let onAdd: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webLane } else { nativeLane }
    }

    @State private var addHovered = false

    private var webLane: some View {
        ScrollView(.vertical) {
            VStack(spacing: metrics.size(5)) {
                ForEach(pane.tabs) { tab in
                    SubTabItem(tab: tab, isActive: tab.id == pane.activeTab?.id, isFocused: isFocused,
                               canClose: pane.tabs.count > 1,
                               onActivate: { onActivate(tab.id) }, onClose: { onClose(tab.id) },
                               onRestart: { onRestart(tab) })
                        .transition(.opacity)
                }
                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .font(metrics.font(size: 12))
                        .frame(width: metrics.size(26), height: metrics.size(26))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(6))
                            .strokeBorder(theme[addHovered ? .accentBorder : .borderStrong], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(3), metrics.size(2)])))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme[addHovered ? .fg : .fgFaint])
                .background(theme[.accentSoft].opacity(addHovered ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.size(6)))
                .onHover { addHovered = $0 }
                .animation(Motion.WorkspaceEffect.action.animation(reduceMotion: metrics.reducesMotion), value: addHovered)
                .padding(.top, metrics.size(6))
                .help(Text("subtabs.new"))
                .accessibilityLabel(Text("subtabs.new"))
                .accessibilityIdentifier("subtabs.new")
            }
            .animation(metrics.style == .clean ? nil : Motion.WorkspaceEffect.insertion.animation(reduceMotion: metrics.reducesMotion), value: pane.tabs.map(\.id))
            .padding(.vertical, metrics.size(6))
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.never)
        .frame(width: metrics.size(36))
        .background(theme[.shapeTabsLaneBg])
        // No visible grip (it left an empty slot): the lane's free area drags the pane.
        .background {
            if canDragPane {
                Color.clear.contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: metrics.size(4), coordinateSpace: .global)
                        .onChanged { onDrag($0.translation) }.onEnded { _ in onDrag(nil) })
            }
        }
        .overlay(alignment: .trailing) { theme[.shapeTabsLaneBorder].frame(width: metrics.size(1)) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subtabs.lane")
        .onMoveCommand { direction in
            guard let index = pane.tabs.firstIndex(where: { $0.id == pane.activeTab?.id }), !pane.tabs.isEmpty else { return }
            let delta: Int
            switch direction {
            case .up, .left: delta = -1
            case .down, .right: delta = 1
            default: return
            }
            onActivate(pane.tabs[(index + delta + pane.tabs.count) % pane.tabs.count].id)
        }
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
                    if isActive && (!metrics.isWebInterface || metrics.style != .clean) { RoundedRectangle(cornerRadius: metrics.size(6)).strokeBorder(theme[.border], lineWidth: metrics.isWebInterface ? metrics.size(1) : 1) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            if isActive && (!metrics.isWebInterface || metrics.style != .clean) {
                // Accent bar on the lane's leading edge (upstream `.active::before`).
                RoundedRectangle(cornerRadius: metrics.size(1))
                    .fill(theme[metrics.isWebInterface || isFocused ? .accent : .borderStrong])
                    .frame(width: metrics.size(2), height: metrics.size(16))
                    .shadow(color: isFocused && (!metrics.isWebInterface || metrics.style != .clean) ? theme[.accentRing] : .clear, radius: metrics.size(4))
                    .offset(x: -metrics.size(5))
            }
        }
        .overlay(alignment: .bottomTrailing) {
            Group {
                if metrics.isWebInterface {
                    if environment.terminals.unread.contains(tab.id) {
                        Text(verbatim: "!")
                            .font(metrics.font(size: 8, weight: .heavy))
                            .foregroundStyle(theme[.accentOn])
                            .frame(width: metrics.size(10), height: metrics.size(10))
                            .background(theme[.statusWorking], in: Circle())
                            .overlay(Circle().strokeBorder(theme[.bgSunken], lineWidth: metrics.size(1)))
                            .padding(metrics.size(2))
                            .accessibilityLabel(Text("agentStatus.done"))
                    }
                } else { AgentStatusGlyph(tab: tab.id) }
            }
            .allowsHitTesting(false)
        }
        .overlay(alignment: .topTrailing) {
            if canClose && (metrics.isWebInterface || isHovered) {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(metrics.font(size: metrics.isWebInterface ? 8 : 7, weight: .bold))
                        .frame(width: metrics.size(12), height: metrics.size(12))
                        .background(Circle().fill(theme[.bgElevated]))
                        .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.isWebInterface ? metrics.size(1) : 1))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme[.textSecondary])
                .offset(x: metrics.size(metrics.isWebInterface ? 4 : 3), y: -metrics.size(metrics.isWebInterface ? 4 : 3))
                .help(Text("subtabs.close"))
                .accessibilityLabel(Text("subtabs.close"))
                .accessibilityIdentifier("subtabs.close")
                .opacity(isHovered ? 1 : 0)
                .allowsHitTesting(isHovered)
                .accessibilityHidden(!isHovered)
                .animation(metrics.isWebInterface ? Motion.WorkspaceEffect.action.animation(reduceMotion: metrics.reducesMotion) : nil, value: isHovered)
            }
        }
        .opacity(metrics.isWebInterface && metrics.style == .clean && !isActive ? 0.46 : 1)
        .animation(metrics.isWebInterface ? Motion.WorkspaceEffect.tab.animation(reduceMotion: metrics.reducesMotion) : nil, value: isHovered)
        .animation(metrics.isWebInterface ? Motion.WorkspaceEffect.laneSelection.animation(reduceMotion: metrics.reducesMotion) : nil, value: isActive)
        .onHover { isHovered = $0 }
        .help(Text(verbatim: name))
        .contextMenu {
            if !metrics.isWebInterface {
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
