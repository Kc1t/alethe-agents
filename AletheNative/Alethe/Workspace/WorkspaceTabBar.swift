import AletheDesign
import AletheModel
import SwiftUI

/// Workspace tabs above the panes (upstream TitleBar tabs): back/forward, one tab per saved view,
/// pinned tabs first. Click shows a tab, the close button closes it (⇧⌘T reopens), the context menu
/// pins it; tabs reorder by dragging.
struct WorkspaceTabBar: View {
    let workspace: WorkspaceModel
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovered: WorkspaceTabID?
    @State private var closeHovered: WorkspaceTabID?
    @State private var dragging: WorkspaceTabID?

    private var document: WorkspaceDocument { workspace.document }

    var body: some View {
        HStack(spacing: metrics.space(.xs)) {
            if metrics.isWebInterface {
                HStack(spacing: metrics.size(2)) { historyButtons }
            } else {
                historyButtons
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: metrics.space(.xs)) {
                    ForEach(document.workspace.tabs) { tab in
                        tabView(tab)
                    }
                }
            }
        }
        .padding(.horizontal, metrics.size(metrics.isWebInterface ? 8 : 6))
        .frame(height: metrics.size(32))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.bgElevated])
        .overlay(alignment: .bottom) { if !metrics.isWebInterface { theme[.border].frame(height: metrics.size(1)) } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspaceTabs")
    }

    @ViewBuilder
    private var historyButtons: some View {
        navigationButton("arrow.left", label: "menu.view.back", id: "workspaceTabs.back",
                         enabled: document.canGoBack) { navigate(-1) }
        navigationButton("arrow.right", label: "menu.view.forward", id: "workspaceTabs.forward",
                         enabled: document.canGoForward) { navigate(1) }
    }

    private func tabView(_ tab: WorkspaceTab) -> some View {
        let isActive = tab.id == document.workspace.activeTabID
        let isHovered = hovered == tab.id
        let label = document.label(of: tab)
        let name = label?.name ?? String(localized: "workspaceTabs.empty")
        let radius = metrics.radius(.sm)
        // Upstream `groupTab`: 26pt, muted until hovered; the active tab sits pressed into the bar.
        return HStack(spacing: metrics.isWebInterface ? metrics.size(2) : metrics.space(.s)) {
            if tab.pinned {
                Image(systemName: "pin.fill")
                    .font(metrics.font(size: 9))
                    .rotationEffect(.degrees(45))
                    .foregroundStyle(theme[.accent])
            }
            if metrics.isWebInterface, tab.kind == .composition {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(metrics.font(size: 14))
                    .foregroundStyle(theme[.fgMuted])
                    .fixedSize()
            } else {
                Circle()
                    .fill(document.color(of: tab).map { theme[$0.token] } ?? theme[.fgFaint])
                    .frame(width: metrics.size(8), height: metrics.size(8))
                    .padding(.trailing, metrics.isWebInterface ? metrics.size(5) : 0)
            }
            Text(verbatim: name)
                .font(metrics.font(size: 11, weight: .semibold))
                .foregroundStyle(theme[isActive || isHovered ? .fg : .fgMuted])
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let more = label?.more, more > 0 {
                AletheCountPill(more)
            }
            // Pure SwiftUI, not a borderless (AppKit-backed) button: inside the horizontal scroll
            // view an NSButton reports a wrong frame and cannot be hit where it is drawn.
            Image(systemName: "xmark")
                .font(metrics.font(size: 8, weight: .bold))
                .frame(width: metrics.size(metrics.isWebInterface && !isActive && !isHovered ? 0 : 18), height: metrics.size(18))
                .background(theme[.panelHover].opacity(closeHovered == tab.id ? 1 : 0), in: Circle())
                .contentShape(Circle())
                .onHover { closeHovered = $0 ? tab.id : (closeHovered == tab.id ? nil : closeHovered) }
                .onTapGesture { workspace.update { $0.closeWorkspaceTab(tab.id) } }
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { workspace.update { $0.closeWorkspaceTab(tab.id) } }
            .foregroundStyle(theme[closeHovered == tab.id ? .fg : .fgFaint])
            .opacity(isActive || isHovered ? 1 : 0)
            .help(Text("workspaceTabs.close"))
            .accessibilityLabel(Text("workspaceTabs.close"))
            .accessibilityIdentifier("workspaceTabs.close.\(name)")
        }
        .padding(.leading, metrics.size(8))
        .padding(.trailing, metrics.size(4))
        .frame(minWidth: metrics.size(96), maxWidth: metrics.size(190))
        .frame(height: metrics.size(26))
        .background(
            RoundedRectangle(cornerRadius: radius)
                .fill(isActive ? theme[.bgSunken] : theme[.panelHover].opacity(isHovered ? 1 : 0))
                .shadow(color: isActive && (!metrics.isWebInterface || metrics.style != .clean) ? theme.shadow(.sm).color.color : .clear,
                        radius: metrics.size(4), y: metrics.size(2))
        )
        .overlay {
            if isActive { RoundedRectangle(cornerRadius: radius).strokeBorder(theme[.borderStrong]) }
        }
        .offset(y: (isActive || isHovered) && metrics.style == .normal ? -metrics.size(1) : 0)
        .opacity(dragging == tab.id ? 0.5 : 1)
        .contentShape(Rectangle())
        .onHover { hovered = $0 ? tab.id : (hovered == tab.id ? nil : hovered) }
        .onTapGesture {
            workspace.update { $0.activateWorkspaceTab(tab.id) }
            if metrics.isWebInterface { environment.showingHome = false }
        }
        .onDrag {
            dragging = tab.id
            return NSItemProvider(object: tab.id.rawValue as NSString)
        }
        .onDrop(of: [.text], delegate: TabDropDelegate(target: tab.id, dragging: $dragging, workspace: workspace))
        .contextMenu {
            if metrics.isWebInterface {
                Button { workspace.update { $0.togglePinned(tab.id) } } label: {
                    Label(tab.pinned ? LocalizedStringKey("workspaceTabs.unpin") : "workspaceTabs.pin",
                          systemImage: tab.pinned ? "pin.slash" : "pin")
                }
                Divider()
                Button { workspace.update { $0.closeWorkspaceTab(tab.id) } } label: {
                    Label("workspaceTabs.close", systemImage: "xmark")
                }
            } else {
                Button(tab.pinned ? LocalizedStringKey("workspaceTabs.unpin") : "workspaceTabs.pin") {
                    workspace.update { $0.togglePinned(tab.id) }
                }
                Divider()
                Button("workspaceTabs.close") { workspace.update { $0.closeWorkspaceTab(tab.id) } }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
        .accessibilityLabel(Text(verbatim: name))
        .accessibilityIdentifier("workspaceTabs.tab.\(name)")
    }

    private func navigate(_ direction: Int) {
        workspace.update { $0.navigateHistory(direction) }
        if metrics.isWebInterface { environment.showingHome = false }
    }

    private func navigationButton(_ symbol: String, label: LocalizedStringKey, id: String, enabled: Bool,
                                  action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
        }
        .buttonStyle(AletheIconButtonStyle(side: 24))
        .disabled(!enabled)
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }
}

/// Reorders tabs live while one is dragged over another.
private struct TabDropDelegate: DropDelegate {
    let target: WorkspaceTabID
    @Binding var dragging: WorkspaceTabID?
    let workspace: WorkspaceModel

    func dropEntered(info: DropInfo) {
        MainActor.assumeIsolated {
            guard let dragging, dragging != target,
                  let index = workspace.document.workspace.tabs.firstIndex(where: { $0.id == target }) else { return }
            workspace.update { $0.moveWorkspaceTab(dragging, to: index) }
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

    func performDrop(info: DropInfo) -> Bool {
        dragging = nil
        return true
    }
}
