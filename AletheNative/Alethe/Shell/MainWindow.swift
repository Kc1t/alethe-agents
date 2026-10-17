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
    @State private var webFullScreen = false
    @State private var showsTitleBarNews = false
    @State private var showsTitleBarMemory = false
    @State private var showsTitleBarCustomization = false
    @AppStorage("main.webRightWidth") private var webRightWidth = 300.0

    var body: some View {
        Group {
            if metrics.isWebInterface {
                webShell
            } else {
                nativeShell
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aletheOpenTitleBarMemory)) { _ in
            if metrics.isWebInterface { showsTitleBarMemory = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aletheCustomizeTitleBar)) { _ in
            if metrics.isWebInterface { showsTitleBarCustomization = true }
        }
        .onChange(of: metrics.isWebInterface) { _, web in
            if !web {
                showsTitleBarMemory = false
                showsTitleBarNews = false
                showsTitleBarCustomization = false
            }
        }
        .onPreferenceChange(WebTitleBarNewsKey.self) { showsTitleBarNews = $0 }
        .onAppear {
            if metrics.isWebInterface, UserDefaults.standard.object(forKey: "main.webRightSidebarInitialized") == nil {
                environment.rightSidebarVisible = true
                UserDefaults.standard.set(true, forKey: "main.webRightSidebarInitialized")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aletheToggleWebSidebar)) { _ in
            if metrics.isWebInterface { sidebarVisible.toggle() }
        }
        .overlay {
            WindowChromeBridge(web: metrics.isWebInterface, barHeight: metrics.size(40),
                               fullScreen: $webFullScreen)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .ignoresSafeArea(.container, edges: .top)
        }
        .accessibilityHidden(!environment.startupFinished)
        .overlay {
            if !environment.startupFinished { StartupLoadingView() }
        }
        // Keep the window usable at 800×500 even when its controls are zoomed.
        .frame(minWidth: metrics.isWebInterface ? metrics.size(800 / metrics.scale) : 800,
               minHeight: metrics.isWebInterface ? metrics.size(500 / metrics.scale) : 500)
        .blur(radius: webTerminalPresented || showsTitleBarMemory || showsTitleBarNews || showsTitleBarCustomization ? metrics.size(10) : 0)
        .allowsHitTesting(!webTerminalPresented && !showsTitleBarMemory && !showsTitleBarNews && !showsTitleBarCustomization)
        .accessibilityHidden(webTerminalPresented || showsTitleBarMemory || showsTitleBarNews || showsTitleBarCustomization)
        .sheet(item: systemEditorRequest) { request in
            if let workspace = environment.workspace { editor(for: request, workspace: workspace) }
        }
        .overlay {
            if webTerminalPresented, let request = environment.editorRequest, let workspace = environment.workspace {
                editorOverlay(for: request, workspace: workspace)
                .id(request.id)
            }
        }
        .overlay {
            if metrics.isWebInterface, showsTitleBarCustomization {
                ProjectGroupWebOverlay(width: 440, onClose: { showsTitleBarCustomization = false }) { close in
                    WebTitleBarCustomization(close: close)
                }
            }
            if metrics.isWebInterface, showsTitleBarMemory {
                ProjectGroupWebOverlay(width: 760, onClose: { showsTitleBarMemory = false }) { close in
                    WebTitleBarMemory(close: close)
                }
            }
            if metrics.isWebInterface, showsTitleBarNews {
                ProjectGroupWebOverlay(width: 480, onClose: closeTitleBarNews) { close in
                    WebTitleBarNews(close: close)
                }
            }
        }
    }

    private func closeTitleBarNews() {
        showsTitleBarNews = false
        NotificationCenter.default.post(name: .aletheCloseTitleBarNews, object: nil)
    }

    private var webTerminalPresented: Bool {
        guard metrics.isWebInterface, let request = environment.editorRequest else { return false }
        switch request {
        case .newTerminal, .newSubTab, .newProject, .editProject, .newGroup, .editGroup, .aiUsage, .findJump: return true
        default: return false
        }
    }

    @ViewBuilder
    private func editorOverlay(for request: EditorRequest, workspace: WorkspaceModel) -> some View {
        switch request {
        case .findJump:
            ProjectGroupWebOverlay(width: 520, onClose: { environment.editorRequest = nil }) { close in
                WebTitleBarSearch(workspace: workspace, undoManager: undoManager, close: close)
            }
        case .aiUsage:
            ProjectGroupWebOverlay(width: 920, onClose: { environment.editorRequest = nil }) { close in
                WebTitleBarUsage(close: close)
            }
        case .newProject, .newGroup, .editGroup, .editProject:
            ProjectGroupWebOverlay(width: projectGroupModalWidth(request),
                                   onClose: { environment.editorRequest = nil }) { close in
                editor(for: request, workspace: workspace, closeOverlay: close)
            }
        default:
            NewTerminalWebOverlay(onClose: { environment.editorRequest = nil }) { close in
                editor(for: request, workspace: workspace, closeOverlay: close)
            }
        }
    }

    private func projectGroupModalWidth(_ request: EditorRequest) -> CGFloat {
        if case .editProject = request { return 760 }
        return 440
    }

    private var systemEditorRequest: Binding<EditorRequest?> {
        Binding { webTerminalPresented ? nil : environment.editorRequest } set: { environment.editorRequest = $0 }
    }

    private var webShell: some View {
        GeometryReader { windowGeometry in
            VStack(spacing: 0) {
                WebTitleBar(sidebarVisible: $sidebarVisible, fullScreen: webFullScreen)
                    .frame(maxWidth: .infinity)
                    .fixedSize(horizontal: false, vertical: true)
                GeometryReader { geometry in
                    HStack(spacing: 0) {
                        if sidebarVisible {
                            LeftSidebar()
                                .frame(width: min(metrics.size(webLeftWidth), geometry.size.width * 0.30))
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
                                .frame(width: min(metrics.size(webRightWidth), geometry.size.width * 0.30))
                                .background(theme[.bg])
                        }
                    }
                    .frame(maxHeight: .infinity)
                }
            }
            .frame(width: windowGeometry.size.width, height: windowGeometry.size.height, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .modifier(WebTitleBarPopoverLayer())
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
    private func editor(for request: EditorRequest, workspace: WorkspaceModel, closeOverlay: (() -> Void)? = nil) -> some View {
        switch request {
        case .newProject(let location, let folder):
            ProjectEditor(workspace: workspace, undoManager: undoManager, editing: nil, initialLocation: location,
                          initialFolder: folder, closeOverlay: closeOverlay)
        case .editProject(let id):
            ProjectEditor(workspace: workspace, undoManager: undoManager, editing: id, initialLocation: .ungrouped, closeOverlay: closeOverlay)
        case .newGroup(let parent):
            GroupEditor(workspace: workspace, undoManager: undoManager, editing: nil, initialParent: parent, closeOverlay: closeOverlay)
        case .editGroup(let id):
            GroupEditor(workspace: workspace, undoManager: undoManager, editing: id, initialParent: nil, closeOverlay: closeOverlay)
        case .newTerminal(let project):
            NewTerminalSheet(workspace: workspace, undoManager: undoManager,
                             initialProject: project ?? workspace.document.workspace.selectedProjectID, closeOverlay: closeOverlay)
        case .newSubTab(let pane):
            NewTerminalSheet(workspace: workspace, undoManager: undoManager,
                             initialProject: workspace.document.pane(pane)?.project.id, targetPane: pane, closeOverlay: closeOverlay)
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
