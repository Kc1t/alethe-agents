import AletheDesign
import AlethePluginKit
import AletheGitControl
import AletheModel
import AletheTodos
import SwiftUI

/// Maps a contributed `viewID` to the app's SwiftUI view and localized title (ADR-9).
enum PluginViewRegistry {
    static func title(for tab: SidebarTabContribution) -> LocalizedStringKey {
        switch tab.viewID {
        case TodosPlugin.viewID: "rightSidebar.todos"
        case DocsView.tabID: "rightSidebar.docs"
        case PullRequestsView.tabID: "rightSidebar.pullRequests"
        case AgentsView.tabID: "rightSidebar.agents"
        case QueueView.tabID: "queue.title"
        case GSDSyncView.tabID: "rightSidebar.gsdSync"
        case McpPanel.tabID: "rightSidebar.mcp"
        case "jev": "rightSidebar.jev"
        case "plugins": "rightSidebar.plugins"
        default: LocalizedStringKey(tab.title)
        }
    }

    @MainActor @ViewBuilder
    static func view(for viewID: String) -> some View {
        switch viewID {
        case TodosPlugin.viewID: TodosView()
        case DocsView.tabID: DocsView()
        case PullRequestsView.tabID: PullRequestsView()
        case AgentsView.tabID: AgentsView()
        case QueueView.tabID: QueueView()
        case GSDSyncView.tabID: GSDSyncView()
        case McpPanel.tabID: McpPanel()
        case "jev": WebVoiceHistoryPanel()
        case "plugins": PluginsWebPanel()
        default: ExtensionOrUnavailable(viewID: viewID)
        }
    }

    /// The sheet a `SheetContribution` names, for a project.
    @MainActor @ViewBuilder
    static func sheet(for viewID: String, workspace: WorkspaceModel, undoManager: UndoManager?,
                      projectID: ProjectID?) -> some View {
        switch viewID {
        case GitControlPlugin.viewID:
            GitControlSheet(workspace: workspace, undoManager: undoManager, projectID: projectID)
        default:
            ContentUnavailableView("rightSidebar.unavailable", systemImage: "puzzlepiece.extension")
        }
    }
}

/// A third-party extension's tab (P4-19), or a placeholder for an unknown `viewID`.
private struct ExtensionOrUnavailable: View {
    let viewID: String
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        if let identity = environment.extensions?.identity(forViewID: viewID) {
            ExtensionTabView(identity: identity)
        } else {
            ContentUnavailableView("rightSidebar.unavailable", systemImage: "puzzlepiece.extension")
        }
    }

    /// The sheet a `SheetContribution` names, for a project.
    @MainActor @ViewBuilder
    static func sheet(for viewID: String, workspace: WorkspaceModel, undoManager: UndoManager?,
                      projectID: ProjectID?) -> some View {
        switch viewID {
        case GitControlPlugin.viewID:
            GitControlSheet(workspace: workspace, undoManager: undoManager, projectID: projectID)
        default:
            ContentUnavailableView("rightSidebar.unavailable", systemImage: "puzzlepiece.extension")
        }
    }
}

/// The inspector column (P4-3): the right-side contributed tabs, in `ViewPlacements` order.
private struct TabStripState: Equatable {
    var offset: CGFloat = 0
    var content: CGFloat = 0
    var visible: CGFloat = 0
    var canBack: Bool { offset > 1 }
    var canForward: Bool { content - visible - offset > 1 }
}

struct RightSidebar: View {
    @Environment(AppEnvironment.self) private var environment

    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var droppedMarkdown: [URL] = []
    @State private var tabScroll = ScrollPosition()
    @State private var tabStrip = TabStripState()

    private var nativeContributions: [SidebarTabContribution] {
        let plugins = environment.plugins.map {
            $0.viewPlacements.arranged($0.contributions.sidebarTabs).right
        } ?? []
        return [DocsView.tab]
            + (environment.gsdSync.isAvailable(in: selectedProject) ? [GSDSyncView.tab] : [])
            + plugins.filter { $0.viewID != TodosPlugin.viewID && $0.viewID != FilesView.tabID }
            + (environment.features.isOn(.mcp) ? [McpPanel.tab] : [])
            + (environment.features.isOn(.prs) ? [PullRequestsView.tab] : [])
            + [AgentsView.tab, QueueView.tab]
            + plugins.filter { $0.viewID == TodosPlugin.viewID }
            + (environment.extensions?.sidebarTabs ?? [])
    }

    private var tabs: [SidebarTabContribution] {
        guard metrics.isWebInterface else { return nativeContributions }
        let native = nativeContributions
        return native.filter { $0.viewID != PullRequestsView.tabID && $0.viewID != AgentsView.tabID && $0.viewID != McpPanel.tabID }
            + native.filter { $0.viewID == McpPanel.tabID }
            + [SidebarTabContribution(id: "jev", title: "Jev", symbol: "mic", side: .right, viewID: "jev")]
            + native.filter { $0.viewID == PullRequestsView.tabID || $0.viewID == AgentsView.tabID }
            + [SidebarTabContribution(id: "plugins", title: "Plugins", symbol: "square.3.layers.3d", side: .right, viewID: "plugins")]
    }

    private var selectedProject: Project? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)
        }
    }

    private var selected: SidebarTabContribution? {
        tabs.first { $0.id == environment.rightSidebarTab } ?? tabs.first
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if metrics.isWebInterface { webTabs } else { nativeTabs }
            }
            .dropDestination(for: URL.self) { urls, _ in
                let markdown = urls.filter { $0.isFileURL && ["md", "markdown"].contains($0.pathExtension.lowercased()) }
                guard !markdown.isEmpty else { return false }
                droppedMarkdown = markdown
                environment.rightSidebarTab = DocsView.tabID
                return true
            }
            if let selected {
                ZStack {
                    DocsView(droppedFiles: $droppedMarkdown).opacity(selected.viewID == DocsView.tabID ? 1 : 0)
                        .allowsHitTesting(selected.viewID == DocsView.tabID)
                        .accessibilityHidden(selected.viewID != DocsView.tabID)
                    if selected.viewID != DocsView.tabID {
                        PluginViewRegistry.view(for: selected.viewID)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("rightSidebar.empty", systemImage: "sidebar.right")
            }
        }
        .background(metrics.isWebInterface ? theme[.bg] : .clear)
    }

    private var nativeTabs: some View {
        HStack(spacing: metrics.space(.xs)) {
            ScrollView(.horizontal) {
                Picker("rightSidebar.tabs", selection: selection) {
                    ForEach(tabs, id: \.id) { tab in
                        Label(PluginViewRegistry.title(for: tab), systemImage: tab.symbol).tag(Optional(tab.id))
                    }
                }
                .pickerStyle(.segmented)
                .labelStyle(.iconOnly)
                .labelsHidden()
                .accessibilityIdentifier("rightSidebar.tabs")
            }
            if selected?.viewID == McpPanel.tabID {
                ContentPaneButton(symbol: "arrow.up.left.and.arrow.down.right", label: "rightSidebar.maximize", id: "rightSidebar.maximize")
                {
                    environment.editorRequest = .mcpManager(McpManagerRoute())
                }
            }
            ContentPaneButton(symbol: "sidebar.right", label: "rightSidebar.close", id: "rightSidebar.close") {
                environment.rightSidebarVisible = false
            }
            .padding(.trailing, metrics.space(.xs))
        }
    }

    /// Tabs as a carousel: no scroll bar, small chevrons only while tabs hide off-screen (no gradients allowed).
    private var tabCarousel: some View {
        HStack(spacing: metrics.size(2)) {
            if tabStrip.canBack { carouselChevron("chevron.left") { pageTabs(-1) } }
            ScrollView(.horizontal) {
                HStack(spacing: metrics.size(4)) {
                    ForEach(tabs, id: \.id) { tab in
                        Button {
                            environment.rightSidebarTab = tab.id
                        } label: {
                            Label { Text(PluginViewRegistry.title(for: tab)) } icon: {
                                Image(systemName: webSymbol(tab))
                                    .resizable().scaledToFit()
                                    .frame(width: metrics.size(14), height: metrics.size(14))
                            }
                        }
                        .buttonStyle(AletheAnimatedRightSidebarTabStyle(selected: selected?.id == tab.id))
                        .help(Text(webTitle(tab)))
                        .accessibilityAddTraits(selected?.id == tab.id ? .isSelected : [])
                        .id(tab.id)
                    }
                }
            }
            .scrollIndicators(.never)
            .scrollPosition($tabScroll)
            .onScrollGeometryChange(for: TabStripState.self) { geo in
                TabStripState(offset: geo.contentOffset.x, content: geo.contentSize.width, visible: geo.visibleRect.width)
            } action: { _, state in tabStrip = state }
            .fixedSize(horizontal: false, vertical: true)
            .frame(height: metrics.size(26))
            .onChange(of: selected?.id) { _, id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.2)) { tabScroll.scrollTo(id: id) }
            }
            .accessibilityIdentifier("rightSidebar.tabs")
            if tabStrip.canForward { carouselChevron("chevron.right") { pageTabs(1) } }
        }
    }

    private func carouselChevron(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: metrics.size(9), weight: .semibold))
                .foregroundStyle(theme[.fgFaint])
                .frame(width: metrics.size(12), height: metrics.size(22))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHidden(true)
    }

    private func pageTabs(_ direction: CGFloat) {
        let step = max(tabStrip.visible * 0.7, metrics.size(60))
        let target = min(max(0, tabStrip.offset + direction * step), max(0, tabStrip.content - tabStrip.visible))
        withAnimation(.easeOut(duration: 0.2)) { tabScroll.scrollTo(x: target) }
    }

    private var webTabs: some View {
        HStack(spacing: metrics.size(4)) {
            tabCarousel
            Spacer(minLength: 0)
            if selected?.viewID == McpPanel.tabID {
                Button {
                    environment.editorRequest = .mcpManager(McpManagerRoute())
                } label: {
                    Label { Text("rightSidebar.maximize") } icon: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .resizable().scaledToFit()
                            .frame(width: metrics.size(14), height: metrics.size(14))
                    }
                }
                .buttonStyle(AletheAnimatedRightSidebarTabStyle())
                .help(Text("rightSidebar.web.mcpExpand"))
                .accessibilityIdentifier("rightSidebar.maximize")
            }
        }
        .padding(.horizontal, metrics.size(10))
        .padding(.vertical, metrics.size(4))
        .frame(height: metrics.size(34))
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
    }

    private func webTitle(_ tab: SidebarTabContribution) -> LocalizedStringKey {
        switch tab.viewID {
        case PullRequestsView.tabID: "rightSidebar.web.prs"
        case "jev": "rightSidebar.web.jevHistory"
        default: PluginViewRegistry.title(for: tab)
        }
    }

    private func webSymbol(_ tab: SidebarTabContribution) -> String {
        switch tab.viewID {
        case AgentsView.tabID: "cpu"
        case McpPanel.tabID: "powerplug"
        case "plugins": "square.grid.2x2"
        case GSDSyncView.tabID: "sparkles"
        default: tab.symbol
        }
    }

    private var selection: Binding<String?> {
        Binding { selected?.id } set: { environment.rightSidebarTab = $0 }
    }
}

/// Shared web panel header; native panels retain their original header layouts.
struct WebSidebarHeader<Content: View>: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var trailing: CGFloat = 10
    @ViewBuilder var content: Content
    var body: some View {
        HStack(spacing: metrics.size(7)) { content }
            .font(metrics.font(size: 12, weight: 650))
            .foregroundStyle(theme[.fg])
            .padding(.leading, metrics.size(12))
            .padding(.trailing, metrics.size(trailing))
            .frame(height: metrics.size(38))
            .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
    }
}

struct WebSidebarEmpty: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey? = nil
    var symbol = "doc.text"
    var boxed = false
    var iconSize: CGFloat = 20
    var minimumHeight: CGFloat? = nil
    var gap: CGFloat? = nil
    var centeredInPanel = true
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        VStack(spacing: metrics.size(gap ?? (boxed ? 7 : 8))) {
            Image(systemName: symbol)
                .resizable().scaledToFit()
                .frame(width: metrics.size(iconSize), height: metrics.size(iconSize))
                .foregroundStyle(theme[boxed ? .fgFaint : .fgMuted])
                .frame(width: boxed ? metrics.size(38) : nil, height: boxed ? metrics.size(38) : nil)
                .background(theme[.bgElevated].opacity(boxed ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay {
                    if boxed { RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)) }
                }
                .padding(.bottom, boxed ? metrics.size(3) : 0)
            Text(title).font(metrics.font(size: 12, weight: .bold)).foregroundStyle(theme[.fg])
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if let detail {
                Text(detail).font(metrics.font(size: 11))
                    .multilineTextAlignment(.center).lineSpacing(metrics.size(2))
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: metrics.size(boxed ? 210 : 240))
            }
        }
        .foregroundStyle(theme[.fgMuted])
        .padding(metrics.size(24))
        .frame(maxWidth: .infinity, minHeight: metrics.size(minimumHeight ?? (boxed ? 220 : 180)), maxHeight: centeredInPanel ? .infinity : nil)
    }
}

/// Voice-command history retains an honest availability state until Jev has a native backend.
struct NativeVoiceHistoryPanel: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "mic").resizable().scaledToFit()
                    .frame(width: metrics.size(15), height: metrics.size(15))
                Text("rightSidebar.jev").font(metrics.font(size: 14, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
                Button {} label: {
                    Label("rightSidebar.jev.clear", systemImage: "trash").font(metrics.font(size: 14))
                }
                .buttonStyle(AletheSidebarUtilityStyle())
                .disabled(true).help(Text("rightSidebar.jev.clear"))
                .accessibilityIdentifier("jev.clear")
            }
            .foregroundStyle(theme[.fg]).padding(.horizontal, metrics.size(10))
            .frame(height: metrics.size(44))
            .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
            ScrollView {
                WebSidebarEmpty(title: "rightSidebar.jev.empty", detail: "rightSidebar.jev.unavailable",
                                symbol: "mic", boxed: true, iconSize: 18, centeredInPanel: false)
            }.padding(metrics.size(10))
        }
        .accessibilityIdentifier("jev.panel")
    }
}
