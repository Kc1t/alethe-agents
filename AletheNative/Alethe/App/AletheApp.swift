import AletheAgents
import AletheDesign
import AletheFoundation
import AletheModel
import AletheGitControl
import AletheTodos
import SwiftUI

@main
struct AletheApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    @State private var environment = AppEnvironment()

    init() {
        SymbolRenderingGuard.install()
        AletheFonts.registerBundledFonts()
    }

    var body: some Scene {
        // A single main window: ⌘N belongs to "New Project", not to a second workspace window.
        Window(AppIdentity.displayName, id: "main") {
            MainWindow()
                .environment(environment)
                .environment(\.theme, environment.theme)
                .environment(\.metrics, environment.metrics)
                .tint(environment.metrics.isWebInterface ? environment.theme[.accent] : nil)
                .accentColor(environment.metrics.isWebInterface ? environment.theme[.accent] : nil)
                .preferredColorScheme(environment.theme.isLight ? .light : .dark)
                .task {
                    delegate.environment = environment
                    await environment.load()
                    environment.openLaunchArguments()
                }
        }
        .windowBackgroundDragBehavior(.disabled)
        .defaultSize(width: 1280, height: 800)
        .windowToolbarStyle(.unified)
        .commands {
            if environment.metrics.isWebInterface {
                CommandGroup(after: .sidebar) {
                    Button("chrome.toggleSidebar") {
                        NotificationCenter.default.post(name: .aletheToggleWebSidebar, object: nil)
                    }
                    .keyboardShortcut("b", modifiers: .command)
                }
            } else {
                SidebarCommands()
            }
            ToolbarCommands()
            FileCommands(environment: environment)
            ViewCommands(environment: environment)
            TerminalCommands(environment: environment)
            HistoryCommands(environment: environment)
            #if DEBUG
            DebugSampleDataCommands(environment: environment)
            #endif
        }

        WindowGroup("orchestrator.title", id: "orchestration", for: DetachedBoardID.self) { target in
            DetachedOrchestrationWindow(target: target.wrappedValue)
                .task {
                    delegate.environment = environment
                    await environment.load()
                }
                .environment(environment)
                .environment(\.theme, environment.theme)
                .environment(\.metrics, environment.metrics)
                .preferredColorScheme(environment.theme.isLight ? .light : .dark)
        }
        .defaultSize(width: environment.metrics.size(1100), height: environment.metrics.size(760))

        Settings {
            SettingsView()
                .environment(environment)
                .environment(\.theme, environment.theme)
                .environment(\.metrics, environment.metrics)
                .preferredColorScheme(environment.theme.isLight ? .light : .dark)
        }
    }
}

/// File menu: adding projects and groups (undoable through the key window's undo manager).
private struct FileCommands: Commands {
    let environment: AppEnvironment

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("menu.file.newProject") { environment.editorRequest = .newProject(.ungrouped) }
                .keyboardShortcut(environment.metrics.isWebInterface ? "p" : "n", modifiers: environment.metrics.isWebInterface ? [.command, .shift] : .command)
                .disabled(environment.workspace == nil)
            Button("menu.file.newGroup") { environment.editorRequest = .newGroup(parent: nil) }
                .keyboardShortcut(environment.metrics.isWebInterface ? "g" : "n", modifiers: [.command, .shift])
                .disabled(environment.workspace == nil)
            Button("menu.file.newTerminal") { environment.editorRequest = .newTerminal(nil) }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(environment.workspace?.document.projects.isEmpty ?? true)
            Button("menu.file.newTerminalLikeLast") { newTerminalLikeLast() }
                .keyboardShortcut("t", modifiers: [.command, .option])
                .disabled(environment.workspace?.document.projects.isEmpty ?? true)
            Button("menu.file.addContent") { environment.editorRequest = .addContent(nil) }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .disabled(AddContentSheet.options.isEmpty || (environment.workspace?.document.projects.isEmpty ?? true))
            Divider()
            Button("sidebar.addProject") { actions?.chooseFolders() }
                .keyboardShortcut("o", modifiers: .command)
                .disabled(environment.workspace == nil)
            Button("menu.file.importTauri") { environment.editorRequest = .importTauri }
                .disabled(environment.workspace == nil)
        }
    }

    /// Repeats the last New Terminal choice in the selected project without the sheet (upstream
    /// Ctrl+Alt+T); with nothing to repeat, the sheet opens.
    @MainActor private func newTerminalLikeLast() {
        guard let workspace = environment.workspace,
              let project = workspace.document.workspace.selectedProjectID ?? workspace.document.projects.first?.id,
              let last = environment.preferences?.document.lastTerminalCreation,
              AgentRegistry.builtin.enabledKinds(environment.preferences?.document.enabledAgents)
                .contains(AgentKind(rawValue: last.agent)) else {
            environment.editorRequest = .newTerminal(nil)
            return
        }
        workspace.update(undoManager: NSApp.keyWindow?.undoManager, actionName: String(localized: "undo.newTerminal")) {
            $0.addPane(to: project, tab: last.tab())
        }
    }

    @MainActor private var actions: SidebarActions? {
        environment.workspace.map { SidebarActions(workspace: $0, undoManager: NSApp.keyWindow?.undoManager) }
    }
}

/// View menu additions: UI zoom (font and metric scale only — never `scaleEffect`, plan lesson 1),
/// and showing one pane or one project alone.
private struct ViewCommands: Commands {
    let environment: AppEnvironment

    @MainActor private var isolated: Bool { environment.workspace?.document.workspace.isolatedPaneID != nil }
    @MainActor private var fullscreen: Bool { environment.workspace?.document.workspace.fullscreenProjectID != nil }

    @MainActor private var flat: Binding<Bool> {
        Binding { environment.workspace?.document.workspace.flat ?? false } set: { value in
            environment.workspace?.update { $0.workspace.flat = value }
        }
    }

    /// The selected project's layout.
    @MainActor private var layout: Binding<PaneLayoutMode> {
        Binding {
            environment.workspace.flatMap { doc in doc.document.workspace.selectedProjectID.flatMap(doc.document.project) }?.layout ?? .auto
        } set: { mode in
            environment.workspace?.update { doc in doc.workspace.selectedProjectID.map { doc.setLayoutMode(mode, for: $0) } }
        }
    }

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("menu.view.zoomIn") { environment.preferences?.update { $0.zoom(by: 1) } }
                .keyboardShortcut("+", modifiers: .command)
            Button("menu.view.zoomOut") { environment.preferences?.update { $0.zoom(by: -1) } }
                .keyboardShortcut("-", modifiers: .command)
            Button("menu.view.actualSize") { environment.preferences?.update { $0.uiScale = 1 } }
                .keyboardShortcut("0", modifiers: .command)
            Divider()
            Button(environment.showingHome ? LocalizedStringKey("menu.view.showWorkspace") : "menu.view.showHome") {
                environment.showingHome.toggle()
            }
            .keyboardShortcut("h", modifiers: [.command, .shift])
            .disabled(environment.workspace == nil)
            Divider()
            Button(isolated ? LocalizedStringKey("menu.view.showAllPanes") : "menu.view.showPaneAlone") {
                environment.workspace?.update { $0.isolate(isolated ? nil : $0.workspace.focusedPaneID) }
            }
            .keyboardShortcut(.return, modifiers: [.command, .shift])
            .disabled(environment.workspace?.document.workspace.focusedPaneID == nil && !isolated)
            Button(fullscreen ? LocalizedStringKey("menu.view.showAllProjects") : "menu.view.showProjectAlone") {
                environment.workspace?.update { $0.setFullscreen(fullscreen ? nil : $0.workspace.selectedProjectID) }
            }
            .keyboardShortcut(.return, modifiers: [.command, .option])
            .disabled(environment.workspace?.document.workspace.selectedProjectID == nil && !fullscreen)
            Button(environment.focusModePaneID == nil ? LocalizedStringKey("focusMode.enter") : "focusMode.exit") {
                environment.focusModePaneID = environment.focusModePaneID == nil
                    ? environment.workspace?.document.workspace.focusedPaneID : nil
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(environment.workspace?.document.workspace.focusedPaneID == nil && environment.focusModePaneID == nil)
            Button(environment.rightSidebarVisible ? LocalizedStringKey("menu.view.hideRightSidebar") : "menu.view.showRightSidebar") {
                environment.rightSidebarVisible.toggle()
            }
            .keyboardShortcut("0", modifiers: [.command, .option])
            Button("menu.view.newTodo") {
                environment.plugins?.contributions.commands.first { $0.id == TodosPlugin.newTodoCommandID }?.perform()
            }
            .disabled(environment.plugins?.contributions.commands.contains { $0.id == TodosPlugin.newTodoCommandID } != true)
                        Toggle("menu.view.flat", isOn: flat)
            Picker("menu.view.layout", selection: layout) {
                ForEach(PaneLayoutMode.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .disabled(environment.workspace?.document.workspace.selectedProjectID == nil)
            Divider()
        }
        CommandGroup(after: .pasteboard) {
            Divider()
            Button(environment.dictation.machine.isActive ? LocalizedStringKey("menu.edit.stopDictation") : "menu.edit.dictate") {
                environment.dictation.toggle()
            }
            .keyboardShortcut("e", modifiers: environment.metrics.isWebInterface ? .command : [.command, .option])
        }
        CommandGroup(after: .help) {
            Button("menu.help.showSetup") {
                environment.preferences?.update { $0.setupHidden = nil }
                environment.showingHome = true
            }
            .disabled(environment.workspace == nil)
            Button("menu.help.showOnboarding") { environment.editorRequest = .onboarding }
                .disabled(environment.workspace == nil)
            Divider()
            Button("menu.help.diagnostics") { environment.editorRequest = .diagnostics }
                .disabled(environment.workspace == nil)
            Button("menu.help.exportLogs") { environment.diagnostics.exportLogs() }
            Button("menu.help.openLogsFolder") { environment.diagnostics.openLogsFolder() }
        }
    }
}

/// History menu (Safari's idiom): back/forward through visited workspace views, switching and
/// reopening workspace tabs (upstream Alt+←/→, Ctrl+Tab, Ctrl+Shift+T).
private struct HistoryCommands: Commands {
    let environment: AppEnvironment

    @MainActor private var document: WorkspaceDocument? { environment.workspace?.document }

    var body: some Commands {
        CommandMenu("menu.history") {
            Button("menu.history.findJump") { environment.editorRequest = .findJump }
                .keyboardShortcut(environment.metrics.isWebInterface ? "p" : "k", modifiers: .command)
                .disabled(environment.workspace == nil)
            Divider()
            Button("menu.view.back") { environment.workspace?.update { $0.navigateHistory(-1) } }
                .keyboardShortcut(environment.metrics.isWebInterface ? .leftArrow : "[", modifiers: environment.metrics.isWebInterface ? .option : .command)
                .disabled(document?.canGoBack != true)
            Button("menu.view.forward") { environment.workspace?.update { $0.navigateHistory(1) } }
                .keyboardShortcut(environment.metrics.isWebInterface ? .rightArrow : "]", modifiers: environment.metrics.isWebInterface ? .option : .command)
                .disabled(document?.canGoForward != true)
            Button("menu.history.conversations") { environment.editorRequest = .conversations(nil) }
                .keyboardShortcut("y", modifiers: .command)
                .disabled(environment.workspace?.document.projects.isEmpty ?? true)
            if environment.features.isOn(.mcp) {
                Button("menu.history.skills") { environment.editorRequest = .skills }
                    .disabled(environment.workspace == nil)
                Button("menu.history.mcp") { environment.editorRequest = .mcpManager(McpManagerRoute()) }
                    .disabled(environment.mcp == nil || environment.workspace == nil)
            }
            if environment.hasPluginCommand(GitControlPlugin.openCommandID) {
                Button("menu.git.control") { environment.performPluginCommand(GitControlPlugin.openCommandID) }
                    .disabled(environment.workspace?.document.workspace.selectedProjectID == nil)
            }
            Button("menu.merge.center") { environment.editorRequest = .mergeCenter(nil) }
                .disabled(environment.workspace?.document.workspace.selectedProjectID == nil)
            Button("menu.merge.branchTesting") { environment.editorRequest = .branchTesting(nil) }
                .disabled(environment.workspace?.document.workspace.selectedProjectID == nil)
            Divider()
            Button("menu.history.nextTab") { showTab(1) }
                .keyboardShortcut(.tab, modifiers: .control)
                .disabled(document?.workspaceTab(1) == nil)
            Button("menu.history.previousTab") { showTab(-1) }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
                .disabled(document?.workspaceTab(-1) == nil)
            Divider()
            Button("menu.history.closeTab") {
                environment.workspace?.update { doc in
                    if environment.metrics.isWebInterface {
                        if let project = doc.workspace.openProjectIDs.first.flatMap(doc.project),
                           let pane = project.visiblePanes.first { doc.closePane(pane.id) }
                    } else { doc.workspace.activeTabID.map { doc.closeWorkspaceTab($0) } }
                }
            }
            .keyboardShortcut(environment.metrics.isWebInterface ? KeyboardShortcut("w", modifiers: .command) : nil)
            .disabled(document?.workspace.activeTabID == nil)
            Button("menu.history.reopenTab") { environment.workspace?.update { $0.reopenClosedWorkspaceTab() } }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(document?.workspace.closedTabs.isEmpty ?? true)
        }
    }

    @MainActor private func showTab(_ offset: Int) {
        environment.workspace?.update { doc in doc.workspaceTab(offset).map { doc.activateWorkspaceTab($0) } }
    }
}
