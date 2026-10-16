import AletheDesign
import AletheModel
import SwiftUI

/// Title bar of a project container: color, name, collapse, show alone (fullscreen), close. Dragging
/// it moves the container among the open ones.
struct ContainerHeader: View {
    let project: Project
    let isSelected: Bool
    let isFullscreen: Bool
    let onLayout: (PaneLayoutMode) -> Void
    let onDesignLayout: () -> Void
    let onGrid: (GridAction) -> Void
    let onCollapse: () -> Void
    let onFullscreen: () -> Void
    let onClose: () -> Void
    let onDrag: (CGSize?) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.space(.m)) {
            Circle()
                .fill(theme[project.color.token])
                .frame(width: metrics.size(8), height: metrics.size(8))
            Text(verbatim: project.name)
                .font(metrics.font(.headline))
                .foregroundStyle(theme[isSelected ? .textPrimary : .textSecondary])
                .lineLimit(1)
            Spacer(minLength: 0)
            if !project.namedGrids.isEmpty { gridMenu }
            layoutMenu
            if !isFullscreen {
                headerButton("sidebar.left", label: "workspace.container.collapse", id: "container.collapse.\(project.name)",
                             action: onCollapse)
            }
            headerButton(isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                         label: isFullscreen ? "workspace.container.showAll" : "workspace.container.showAlone",
                         id: "container.fullscreen.\(project.name)", action: onFullscreen)
            headerButton("xmark", label: "workspace.container.close", id: "container.close.\(project.name)", action: onClose)
        }
        .padding(.horizontal, metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bgElevated])
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 4, coordinateSpace: .global)
                .onChanged { onDrag($0.translation) }
                .onEnded { _ in onDrag(nil) }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("container.\(project.name)")
    }

    /// Layout picker (upstream `LayoutFooter`): Auto stays the default.
    private var layoutMenu: some View {
        Menu {
            Picker(selection: Binding(get: { project.layout }, set: onLayout)) {
                ForEach(PaneLayoutMode.allCases, id: \.self) { mode in
                    Label(mode.title, systemImage: mode.symbol).tag(mode)
                }
            } label: {
                EmptyView()
            }
            .pickerStyle(.inline)
            Divider()
            Button("workspace.layout.design", action: onDesignLayout)
            if project.namedGrids.isEmpty {
                Button("projectGrid.newEllipsis") { onGrid(.new) }
            }
        } label: {
            Image(systemName: project.layout.symbol)
                .font(metrics.font(.caption).weight(.semibold))
                .frame(width: metrics.size(18), height: metrics.size(18))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(theme[.textTertiary])
        .help(Text("workspace.layout"))
        .accessibilityLabel(Text("workspace.layout"))
        .accessibilityIdentifier("container.layout.\(project.name)")
    }

    /// Switches between the project's grids (upstream `ProjectGrids`), named after the shown one.
    private var gridMenu: some View {
        Menu {
            Picker(selection: Binding(get: { project.shownGridID }, set: { onGrid(.activate($0)) })) {
                Text("projectGrid.main").tag(ProjectGridID?.none)
                ForEach(project.namedGrids) { grid in
                    Text(verbatim: grid.name).tag(Optional(grid.id))
                }
            } label: {
                EmptyView()
            }
            .pickerStyle(.inline)
            Divider()
            Button("projectGrid.newEllipsis") { onGrid(.new) }
            if let shown = project.shownGridID {
                Button("projectGrid.renameEllipsis") { onGrid(.rename(shown)) }
                Button("projectGrid.deleteEllipsis") { onGrid(.delete(shown)) }
            }
        } label: {
            HStack(spacing: metrics.space(.xs)) {
                Image(systemName: "rectangle.3.group")
                Text(verbatim: project.gridName(project.shownGridID) ?? String(localized: "projectGrid.main"))
                    .lineLimit(1)
            }
            .font(metrics.font(.footnote).weight(.medium))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .foregroundStyle(theme[.textSecondary])
        .help(Text("projectGrid.switch"))
        .accessibilityLabel(Text("projectGrid.switch"))
        .accessibilityIdentifier("container.grids.\(project.name)")
    }

    private func headerButton(_ symbol: String, label: LocalizedStringKey, id: String,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(metrics.font(.caption).weight(.semibold))
                .frame(width: metrics.size(18), height: metrics.size(18))
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(theme[.textTertiary])
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }
}

/// A collapsed container: a narrow strip with the project's color and vertical name; clicking it
/// expands the container, dragging it moves it.
struct CollapsedContainerStrip: View {
    let project: Project
    let isSelected: Bool
    let onExpand: () -> Void
    let onDrag: (CGSize?) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(spacing: metrics.space(.m)) {
            Circle()
                .fill(theme[project.color.token])
                .frame(width: metrics.size(8), height: metrics.size(8))
            Text(verbatim: project.name)
                .font(metrics.font(.footnote).weight(.medium))
                .foregroundStyle(theme[isSelected ? .textPrimary : .textSecondary])
                .lineLimit(1)
                .fixedSize()
                .rotationEffect(.degrees(90))
                .frame(width: metrics.size(18))
                .frame(maxHeight: .infinity, alignment: .top)
        }
        .padding(.vertical, metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border]))
        .contentShape(Rectangle())
        .onTapGesture(perform: onExpand)
        .gesture(
            DragGesture(minimumDistance: 4, coordinateSpace: .global)
                .onChanged { onDrag($0.translation) }
                .onEnded { _ in onDrag(nil) }
        )
        .help(Text("workspace.container.expand"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: project.name))
        .accessibilityHint(Text("workspace.container.expand"))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onExpand() }
        .accessibilityIdentifier("container.collapsed.\(project.name)")
    }
}

/// Title bar of a pane: agent, title, close. Dragging it reorders the pane; its context menu adds a
/// sub-tab and shows or hides the sub-tabs lane.
struct PaneHeader: View {
    let tab: PaneTab
    let isFocused: Bool
    let isLaneVisible: Bool
    /// The lane can only be hidden while the pane has a single tab.
    let canHideLane: Bool
    let isIsolated: Bool
    let onClose: () -> Void
    let onNewSubTab: () -> Void
    let onToggleLane: () -> Void
    let onToggleIsolation: () -> Void
    /// Grows the pane over the free grid slots next to it; nil outside a grid with room.
    let onFillFreeSpace: (() -> Void)?
    /// The other grids of the project the pane can move to (empty: no named grids).
    let gridTargets: [GridTarget]
    let onMoveToGrid: (ProjectGridID?) -> Void
    let isInFocusMode: Bool
    let onToggleFocus: () -> Void
    let onDisable: () -> Void
    /// The pane is shared with remote devices (P7-18).
    let isRemoteShared: Bool
    let onToggleRemoteShared: () -> Void
    /// Session Cost… for the shown tab; nil when it has no session.
    let onSessionCost: (() -> Void)?
    /// Continue in the other agent (Claude Code ↔ Codex); nil for other agents.
    let onHandoff: (() -> Void)?
    /// Translation of an ongoing header drag, in the header's coordinates; nil when it ends.
    let onDrag: (CGSize?) -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.space(.s)) {
            Circle()
                .fill(theme[AgentTokens.accent(for: tab.agent)])
                .frame(width: metrics.size(6), height: metrics.size(6))
            Text(verbatim: environment.terminals.displayName(of: tab))
                .font(metrics.font(.footnote).weight(.medium))
                .foregroundStyle(theme[isFocused ? .textPrimary : .textSecondary])
                .lineLimit(1)
            AgentStatusGlyph(tab: tab.id)
            if isRemoteShared { RemoteSharedGlyph() }
            if tab.unrestricted {
                Image(systemName: "bolt.fill")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.statusWaiting])
                    .help(Text("pane.unrestricted"))
                    .accessibilityLabel(Text("pane.unrestricted"))
            }
            Spacer(minLength: 0)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(metrics.font(.caption).weight(.semibold))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(theme[.textTertiary])
            .help(Text("pane.close"))
            .accessibilityLabel(Text("pane.close"))
            .accessibilityIdentifier("pane.close")
        }
        .padding(.horizontal, metrics.space(.m))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[isFocused ? .bgElevated : .bgSunken])
        .contentShape(Rectangle())
        .onTapGesture(count: 2, perform: onToggleFocus)
        .help(Text(isInFocusMode ? "focusMode.exitHint" : "focusMode.enterHint"))
        .gesture(
            DragGesture(minimumDistance: 4, coordinateSpace: .global)
                .onChanged { onDrag($0.translation) }
                .onEnded { _ in onDrag(nil) }
        )
        .contextMenu {
            Button("subtabs.newEllipsis", action: onNewSubTab)
            Button(isLaneVisible ? LocalizedStringKey("subtabs.hideLane") : "subtabs.showLane", action: onToggleLane)
                .disabled(isLaneVisible && !canHideLane)
            Button(isIsolated ? LocalizedStringKey("pane.showAll") : "pane.showAlone", action: onToggleIsolation)
            Button(isInFocusMode ? LocalizedStringKey("focusMode.exit") : "focusMode.enter", action: onToggleFocus)
            if let onFillFreeSpace {
                Button("pane.fillFreeSpace", action: onFillFreeSpace)
            }
            if !gridTargets.isEmpty {
                Menu("pane.moveToGrid") {
                    ForEach(gridTargets) { target in
                        Button { onMoveToGrid(target.grid) } label: {
                            if let name = target.name { Text(verbatim: name) } else { Text("projectGrid.main") }
                        }
                    }
                }
            }
            if let onSessionCost {
                Button("menu.terminal.sessionCost", action: onSessionCost)
            }
            if let onHandoff {
                Button("menu.terminal.handoff", action: onHandoff)
            }
            Toggle("remote.share", isOn: Binding(get: { isRemoteShared }, set: { _ in onToggleRemoteShared() }))
                .accessibilityIdentifier("remote.share")
            Button("pane.disable", action: onDisable)
            Divider()
            Button("pane.close", action: onClose)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.header.\(tab.title ?? tab.agent)")
    }
}

enum AgentTokens {
    static func accent(for agent: String) -> ThemeToken {
        switch agent {
        case "claude": .agentClaude
        case "codex": .agentCodex
        case "opencode": .agentOpencode
        case "cursor": .agentCursor
        case "antigravity": .agentAntigravity
        case "mimo": .agentMimo
        case "freebuff": .agentFreebuff
        case "kiro": .agentKiro
        case "kimi": .agentKimi
        case "grok": .agentGrok
        case "codewhale": .agentCodewhale
        default: .agentShell
        }
    }
}

extension PaneLayoutMode {
    var title: LocalizedStringKey {
        switch self {
        case .auto: "workspace.layout.auto"
        case .spotlight: "workspace.layout.spotlight"
        case .sidebar: "workspace.layout.sidebar"
        case .grid: "workspace.layout.grid"
        }
    }

    var symbol: String {
        switch self {
        case .auto: "square.grid.2x2"
        case .spotlight: "rectangle.righthalf.inset.filled"
        case .sidebar: "rectangle.leadinghalf.inset.filled"
        case .grid: "square.grid.3x3"
        }
    }
}

/// What the container header's grid menu asks for.
enum GridAction {
    case activate(ProjectGridID?)
    case new
    case rename(ProjectGridID)
    case delete(ProjectGridID)
}

/// A grid a pane can move to (nil `grid`: the main one; nil `name`: shown as "Main").
struct GridTarget: Identifiable {
    let grid: ProjectGridID?
    let name: String?
    var id: String { grid?.rawValue ?? "" }

    /// Every grid of the project except the pane's own.
    static func all(for pane: Pane, in project: Project) -> [GridTarget] {
        guard !project.namedGrids.isEmpty else { return [] }
        let targets = [GridTarget(grid: nil, name: nil)] + project.namedGrids.map { GridTarget(grid: $0.id, name: $0.name) }
        return targets.filter { $0.grid != project.shownGridID }
    }
}
