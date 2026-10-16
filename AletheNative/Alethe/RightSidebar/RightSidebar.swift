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
        case GSDSyncView.tabID: "rightSidebar.gsdSync"
        case McpPanel.tabID: "rightSidebar.mcp"
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
        case GSDSyncView.tabID: GSDSyncView()
        case McpPanel.tabID: McpPanel()
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
struct RightSidebar: View {
    @Environment(AppEnvironment.self) private var environment

    @Environment(\.metrics) private var metrics
    @State private var droppedMarkdown: [URL] = []

    private var tabs: [SidebarTabContribution] {
        let plugins = environment.plugins.map {
            $0.viewPlacements.arranged($0.contributions.sidebarTabs).right
        } ?? []
        return [DocsView.tab]
            + (environment.gsdSync.isAvailable(in: selectedProject) ? [GSDSyncView.tab] : [])
            + plugins.filter { $0.viewID != TodosPlugin.viewID && $0.viewID != FilesView.tabID }
            + (environment.features.isOn(.mcp) ? [McpPanel.tab] : [])
            + (environment.features.isOn(.prs) ? [PullRequestsView.tab] : [])
            + (environment.features.isOn(.orchestrator) ? [AgentsView.tab] : [])
            + plugins.filter { $0.viewID == TodosPlugin.viewID }
            + (environment.extensions?.sidebarTabs ?? [])
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
                    ContentPaneButton(symbol: "arrow.up.left.and.arrow.down.right", label: "rightSidebar.maximize", id: "rightSidebar.maximize") {
                        environment.editorRequest = .mcpManager(McpManagerRoute())
                    }
                }
                ContentPaneButton(symbol: "sidebar.right", label: "rightSidebar.close", id: "rightSidebar.close") {
                    environment.rightSidebarVisible = false
                }
                .padding(.trailing, metrics.space(.xs))
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
    }

    private var selection: Binding<String?> {
        Binding { selected?.id } set: { environment.rightSidebarTab = $0 }
    }
}
