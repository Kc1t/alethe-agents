import AletheDesign
import AletheIntegrations
import AletheModel
import SwiftUI

struct MainWindow: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    /// The window's undo manager: a sheet gets its own, so edits made there would not be undoable
    /// from the main window once it closes.
    @Environment(\.undoManager) private var undoManager
    @SceneStorage("main.columnVisibility") private var sidebarVisible = true
    @AppStorage("main.rightSidebarWidth") private var rightSidebarWidth = 280.0
    @AppStorage("main.webLeftWidth") private var webLeftWidth = 286.0
    @AppStorage("main.webRightWidth") private var webRightWidth = 300.0

    var body: some View {
        Group {
            if metrics.isWebInterface {
                webShell
            } else {
                nativeShell
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aletheToggleWebSidebar)) { _ in
            if metrics.isWebInterface { sidebarVisible.toggle() }
        }
        .background(WindowChromeBridge(web: metrics.isWebInterface, barHeight: metrics.size(32)))
        .accessibilityHidden(!environment.startupFinished)
        .overlay {
            if !environment.startupFinished { StartupLoadingView() }
        }
        .frame(minWidth: metrics.isWebInterface ? metrics.size(800) : 800,
               minHeight: metrics.isWebInterface ? metrics.size(500) : 500)
        .sheet(item: editorRequest) { request in
            if let workspace = environment.workspace { editor(for: request, workspace: workspace) }
        }
    }

    private var webShell: some View {
        VStack(spacing: 0) {
            WebTitleBar(sidebarVisible: $sidebarVisible)
            HStack(spacing: 0) {
                if sidebarVisible {
                    LeftSidebar()
                        .frame(width: metrics.size(webLeftWidth))
                        .background(theme[.bg])
                    WebShellSeparator(width: $webLeftWidth, limits: 220...380)
                }
                WorkspaceView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                    .overlay(alignment: .bottom) { DictationHUD() }
                if environment.rightSidebarVisible {
                    WebShellSeparator(width: $webRightWidth, limits: 260...420, trailing: true)
                    RightSidebar()
                        .frame(width: metrics.size(webRightWidth))
                        .background(theme[.bg])
                }
            }
            .frame(maxHeight: .infinity)
        }
        .background(theme[.bg])
        .ignoresSafeArea(.container, edges: .top)
        .toolbarVisibility(.hidden, for: .windowToolbar)
    }

    private var nativeShell: some View {
        NavigationSplitView(columnVisibility: columnVisibility) {
            LeftSidebar()
                .navigationSplitViewColumnWidth(min: metrics.size(200), ideal: metrics.size(240), max: metrics.size(360))
        } detail: {
            WorkspaceView()
                // Inside the detail column: over the whole split view, AppKit's split views take the clicks.
                .overlay(alignment: .bottom) { DictationHUD() }
                .animation(environment.reducesMotion ? nil : .easeOut(duration: 0.2), value: environment.dictation.machine.phase)
                .modifier(MainToolbar())
                .inspector(isPresented: rightSidebarVisible) {
                    RightSidebar()
                        .inspectorColumnWidth(min: metrics.size(220), ideal: rightSidebarWidth, max: metrics.size(480))
                        .onGeometryChange(for: Double.self) { $0.size.width } action: { width in
                            if width > 0 { rightSidebarWidth = width }
                        }
                }
        }
    }

    private var editorRequest: Binding<EditorRequest?> {
        Binding { environment.editorRequest } set: { environment.editorRequest = $0 }
    }

    @ViewBuilder
    private func editor(for request: EditorRequest, workspace: WorkspaceModel) -> some View {
        switch request {
        case .newProject(let location, let folder):
            ProjectEditor(workspace: workspace, undoManager: undoManager, editing: nil, initialLocation: location,
                          initialFolder: folder)
        case .editProject(let id):
            ProjectEditor(workspace: workspace, undoManager: undoManager, editing: id, initialLocation: .ungrouped)
        case .newGroup(let parent):
            GroupEditor(workspace: workspace, undoManager: undoManager, editing: nil, initialParent: parent)
        case .editGroup(let id):
            GroupEditor(workspace: workspace, undoManager: undoManager, editing: id, initialParent: nil)
        case .newTerminal(let project):
            NewTerminalSheet(workspace: workspace, undoManager: undoManager,
                             initialProject: project ?? workspace.document.workspace.selectedProjectID)
        case .newSubTab(let pane):
            NewTerminalSheet(workspace: workspace, undoManager: undoManager,
                             initialProject: workspace.document.pane(pane)?.project.id, targetPane: pane)
        case .addContent(let project):
            AddContentSheet(workspace: workspace, undoManager: undoManager,
                            project: project ?? workspace.document.workspace.selectedProjectID)
        case .previewLink(let target):
            LinkPreviewSheet(target: target)
        case .importTauri:
            TauriImportSheet(workspace: workspace, undoManager: undoManager)
        case .layoutDesigner(let project):
            LayoutDesignerSheet(workspace: workspace, undoManager: undoManager, projectID: project)
        case .findJump:
            FindJumpSheet(workspace: workspace, undoManager: undoManager)
        case .conversations(let project):
            ConversationsSheet(workspace: workspace, undoManager: undoManager, initialProject: project)
        case .sessionCost(let tab):
            SessionCostSheet(workspace: workspace, tabID: tab)
        case .handoff(let tab):
            HandoffSheet(workspace: workspace, undoManager: undoManager, tabID: tab)
        case .aiUsage:
            AIUsageSheet()
        case .pluginSheet(let viewID, let project):
            PluginViewRegistry.sheet(for: viewID, workspace: workspace, undoManager: undoManager,
                                     projectID: project ?? workspace.document.workspace.selectedProjectID)
        case .mergeCenter(let project, let resume):
            MergeCenterSheet(workspace: workspace, undoManager: undoManager,
                             projectID: project ?? workspace.document.workspace.selectedProjectID,
                             resumeID: resume)
        case .worktrees(let project):
            WorktreesSheet(workspace: workspace, projectID: project ?? workspace.document.workspace.selectedProjectID)
        case .branchTesting(let project):
            BranchTestingSheet(folder: (project ?? workspace.document.workspace.selectedProjectID)
                .flatMap { workspace.document.project($0) }
                .map { URL(filePath: $0.folder, directoryHint: .isDirectory) })
        case .agentLibrary(let project):
            AgentLibrarySheet(workspace: workspace, projectID: project ?? workspace.document.workspace.selectedProjectID)
        case .diagnostics:
            DiagnosticsSheet()
        case .crashNotice:
            CrashNoticeSheet()
        case .skills:
            SkillsSheet(store: environment.skillStore)
        case .gsdSyncActivity(let target):
            GSDSyncActivitySheet(target: target)
        case .onboarding:
            OnboardingSheet(workspace: workspace, undoManager: undoManager)
        case .welcome(let welcome):
            WelcomeBackSheet(welcome: welcome)
        case .mcpManager(let route):
            McpManagerSheet(route: route)
        case .mcpIntro:
            McpIntroSheet()
        case .remotePairing:
            RemotePairingSheet()
        case .gistSync:
            GistSyncSheet()
        }
    }

    private var rightSidebarVisible: Binding<Bool> {
        Binding { environment.rightSidebarVisible } set: { environment.rightSidebarVisible = $0 }
    }

    /// Sidebar visibility survives relaunch (state restoration).
    private var columnVisibility: Binding<NavigationSplitViewVisibility> {
        Binding {
            sidebarVisible ? .all : .detailOnly
        } set: { visibility in
            sidebarVisible = visibility != .detailOnly
        }
    }
}
