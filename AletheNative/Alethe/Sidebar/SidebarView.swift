import AletheAgents
import AletheDesign
import AletheGit
import AletheGitControl
import AletheModel
import AppKit
import SwiftUI

/// Projects organized in nested groups, with each project's terminals underneath.
struct SidebarView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.undoManager) private var undoManager
    @Environment(\.metrics) private var metrics

    var body: some View {
        if let workspace = environment.workspace {
            content(workspace)
        } else {
            List {}.listStyle(.sidebar)
        }
    }

    private func content(_ workspace: WorkspaceModel) -> some View {
        let actions = SidebarActions(workspace: workspace, undoManager: undoManager)
        let doc = workspace.document
        return List(selection: selection(workspace, actions)) {
            Section {
                ForEach(doc.childGroups(of: nil)) { group in
                    GroupRow(group: group, actions: actions)
                }
                .onInsert(of: [.plainText]) { index, providers in
                    SidebarDrag.load(providers) { actions.insertGroup($0, under: nil, at: index) }
                }
                ForEach(doc.ungroupedProjectIDs, id: \.self) { id in
                    if let project = doc.project(id) {
                        ProjectRow(project: project, actions: actions)
                    }
                }
                .onMove { source, destination in actions.reorder(in: .ungrouped, from: source, to: destination) }
                .onInsert(of: [.plainText]) { index, providers in
                    SidebarDrag.load(providers) { actions.insert($0, into: .ungrouped, at: index) }
                }
            } header: {
                SidebarProjectsHeader(actions: actions)
            }
        }
        .listStyle(.sidebar)
        // Clean style: the compact sidebar (upstream `CleanProjectSidebar`).
        .environment(\.sidebarRowSize, metrics.style == .clean ? .small : .medium)
        .accessibilityIdentifier("sidebar.list")
        .dropDestination(for: URL.self) { urls, _ in
            let added = actions.addProjects(folders: urls)
            return !added.isEmpty
        }
        .contextMenu {
            Button("menu.file.newProject") { environment.editorRequest = .newProject(.ungrouped) }
            Button("sidebar.addProject") { actions.chooseFolders() }
            Button("menu.file.newGroup") { environment.editorRequest = .newGroup(parent: nil) }
        }
        .safeAreaInset(edge: .bottom) {
            SidebarNowPlaying()
        }
    }

    private func selection(_ workspace: WorkspaceModel, _ actions: SidebarActions) -> Binding<SidebarItem?> {
        Binding {
            let state = workspace.document.workspace
            if let focused = state.focusedPaneID, let (project, pane) = workspace.document.pane(focused),
               project.id == state.selectedProjectID, let tab = pane.activeTab {
                return .tab(tab.id)
            }
            return state.selectedProjectID.map(SidebarItem.project)
        } set: { item in
            actions.select(item)
        }
    }
}

/// Upstream sidebar header: the uppercase `PROJECTS` label with add-folder and new-project actions.
private struct SidebarProjectsHeader: View {
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.space(.xxs)) {
            AletheSectionLabel(Text("sidebar.projects.header"))
            Spacer(minLength: metrics.space(.s))
            Button { actions.chooseFolders() } label: {
                Label("sidebar.addProject", systemImage: "folder.badge.plus")
            }
            .buttonStyle(AletheIconButtonStyle(side: 20))
            .help(Text("sidebar.addProject"))
            .accessibilityIdentifier("sidebar.addProject")
            Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                Label("menu.file.newProject", systemImage: "plus")
            }
            .buttonStyle(AletheIconButtonStyle(side: 20))
            .help(Text("menu.file.newProject"))
            .accessibilityIdentifier("sidebar.newProject")
        }
    }
}

private struct GroupRow: View {
    let group: ProjectGroup
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let doc = actions.workspace.document
        DisclosureGroup(isExpanded: Binding {
            !group.isCollapsed
        } set: { expanded in
            actions.setCollapsed(group.id, !expanded)
        }) {
            ForEach(doc.childGroups(of: group.id)) { child in
                GroupRow(group: child, actions: actions)
            }
            .onInsert(of: [.plainText]) { index, providers in
                SidebarDrag.load(providers) { actions.insertGroup($0, under: group.id, at: index) }
            }
            ForEach(group.projectIDs, id: \.self) { id in
                if let project = doc.project(id) {
                    ProjectRow(project: project, actions: actions)
                }
            }
            .onMove { source, destination in actions.reorder(in: .group(group.id), from: source, to: destination) }
            .onInsert(of: [.plainText]) { index, providers in
                SidebarDrag.load(providers) { actions.insert($0, into: .group(group.id), at: index) }
            }
        } label: {
            Label {
                // Upstream group tag: faint, lightly tracked name followed by a hairline rule.
                HStack(spacing: metrics.space(.s)) {
                    Text(verbatim: group.name)
                        .font(metrics.font(size: 11))
                        .tracking(metrics.size(11) * 0.04)
                        .foregroundStyle(theme[group.suspended == true ? .textQuaternary : .fgFaint])
                        .lineLimit(1)
                    if group.suspended == true {
                        Image(systemName: "pause.circle.fill")
                            .foregroundStyle(theme[.statusDisabled])
                            .help(Text("sidebar.suspended"))
                            .accessibilityLabel(Text("sidebar.suspended"))
                    }
                    Rectangle()
                        .fill(theme[.border])
                        .frame(height: 1)
                        .frame(maxWidth: .infinity)
                }
            } icon: {
                if let color = group.color {
                    AletheMonogram(name: group.name, color: theme[color.token], side: 14)
                } else {
                    Image(systemName: "folder")
                        .foregroundStyle(theme[.fgFaint])
                }
            }
            .onDrop(of: [.plainText], isTargeted: nil) { providers in
                SidebarDrag.load(providers) { actions.drop($0, onGroup: group.id) }
                return true
            }
            .contextMenu {
                Button("sidebar.editGroup") { environment.editorRequest = .editGroup(group.id) }
                Button("sidebar.newProjectHere") { environment.editorRequest = .newProject(.group(group.id)) }
                Button("sidebar.newSubgroup") { environment.editorRequest = .newGroup(parent: group.id) }
                Divider()
                if group.suspended == true {
                    Button("sidebar.resumeGroup") { actions.resumeGroup(group.id) }
                } else {
                    Button("sidebar.suspendGroupEllipsis") { actions.suspendGroup(group) }
                }
                Divider()
                Button("sidebar.deleteGroup") { actions.deleteGroup(group.id) }
            }
            .accessibilityIdentifier("sidebar.group.\(group.name)")
        }
        .tag(SidebarItem.group(group.id))
        .itemProvider { NSItemProvider(object: SidebarDrag.payload(group.id) as NSString) }
    }
}

private struct ProjectRow: View {
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var merges = ProjectMergeWatcher()

    private var disabledTabs: Set<TabID> {
        Set(project.panes.filter(\.isDisabled).flatMap { $0.tabs.map(\.id) })
    }

    private var sharedTabs: Set<TabID> {
        Set(project.panes.filter(\.isRemoteShared).flatMap { $0.tabs.map(\.id) })
    }

    var body: some View {
        let tabs = project.panes.flatMap(\.tabs)
        let planning = environment.gsdSync.sessions(of: project.id)
        Group {
            if tabs.isEmpty && merges.sessions.isEmpty && planning.isEmpty {
                label
            } else {
                DisclosureGroup {
                    ForEach(tabs) { tab in
                        let disabled = disabledTabs.contains(tab.id)
                        Label {
                            HStack(spacing: metrics.space(.xs)) {
                                Text(verbatim: environment.terminals.displayName(of: tab))
                                    .font(metrics.font(size: 12.5))
                                    .foregroundStyle(theme[disabled ? .textTertiary : .fgMuted])
                                    .lineLimit(1)
                                AgentStatusGlyph(tab: tab.id)
                                if sharedTabs.contains(tab.id) { RemoteSharedGlyph() }
                                if let branch = tab.worktreeBranch {
                                    Image(systemName: "arrow.triangle.branch")
                                        .font(metrics.font(.footnote))
                                        .foregroundStyle(theme[.textTertiary])
                                        .help(Text(verbatim: String(format: String(localized: "sidebar.worktree"), branch)))
                                        .accessibilityLabel(Text(verbatim: String(format: String(localized: "sidebar.worktree"), branch)))
                                        .accessibilityIdentifier("sidebar.tab.worktree")
                                }
                            }
                        } icon: {
                            Image(systemName: disabled ? "pause.circle"
                                  : environment.terminals.hibernated.contains(tab.id) ? "moon.zzz"
                                  : tab.agent == "shell" ? "terminal" : "sparkles")
                                .foregroundStyle(theme[disabled ? .statusDisabled : AgentTokens.accent(for: tab.agent)])
                                .saturation(disabled ? 0 : 1)
                                .help(environment.terminals.hibernated.contains(tab.id) ? Text("sidebar.hibernated") : Text(verbatim: ""))
                        }
                        .tag(SidebarItem.tab(tab.id))
                        .contextMenu { TabContextMenu(tab: tab, project: project, actions: actions) }
                        .accessibilityIdentifier("sidebar.tab.\(tab.agent)")
                    }
                    ForEach(merges.sessions) { session in
                        SidebarMergePanel(session: session, project: project)
                    }
                    ForEach(planning) { session in
                        SidebarPlanningStatus(session: session)
                    }
                } label: {
                    label
                }
            }
        }
        .tag(SidebarItem.project(project.id))
        .itemProvider { NSItemProvider(object: SidebarDrag.payload(project.id) as NSString) }
        .task(id: project.folder) {
            await merges.watch(folder: URL(filePath: project.folder, directoryHint: .isDirectory), projectID: project.id)
        }
    }

    private var label: some View {
        let doc = actions.workspace.document
        let dimmed = doc.isProjectDisabled(project.id) || doc.isSuspended(project.id)
        let selected = doc.workspace.selectedProjectID == project.id
        return Label {
            Text(verbatim: project.name)
                .font(metrics.font(size: 12.5, weight: selected ? .medium : .regular))
                .foregroundStyle(theme[dimmed ? .textTertiary : .textPrimary])
        } icon: {
            AletheMonogram(name: project.name, color: theme[project.color.token])
                .opacity(dimmed ? 0.6 : 1)
        }
        .help(Text(verbatim: project.folder))
        .onDrop(of: [.plainText], isTargeted: nil) { providers in
            SidebarDrag.load(providers) { actions.drop($0, onProject: project.id) }
            return true
        }
        .contextMenu { ProjectContextMenu(project: project, actions: actions) }
        .accessibilityIdentifier("sidebar.project.\(project.name)")
    }
}

private struct ProjectContextMenu: View {
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        let doc = actions.workspace.document
        NewTerminalButton(project: project)
        Divider()
        Button("sidebar.editProject") { environment.editorRequest = .editProject(project.id) }
        Button("sidebar.revealInFinder") { actions.revealInFinder(project) }
        Button("openIn.vscode") { OpenInActions.vsCode(project.folder, launchers: environment.launchers) }
            .accessibilityIdentifier("openIn.vscode")
        Button("openIn.browser") { OpenInActions.browser(project) }
            .accessibilityIdentifier("openIn.browser")
        Button("projectSettings.exportEllipsis") { ProjectSettingsTransfer.export(project) }
        Button("projectSettings.importEllipsis") {
            ProjectSettingsTransfer.importSettings(into: project.id, workspace: actions.workspace, undoManager: actions.undoManager)
        }
        Menu("sidebar.moveToGroup") {
            Button("sidebar.ungrouped") { actions.move(project.id, to: .ungrouped) }
                .disabled(doc.location(of: project.id) == .ungrouped)
            if !doc.groups.isEmpty { Divider() }
            ForEach(doc.groups) { group in
                Button { actions.move(project.id, to: .group(group.id)) } label: { Text(verbatim: group.name) }
                    .disabled(doc.location(of: project.id) == .group(group.id))
            }
        }
        Button("menu.history.conversations") { environment.editorRequest = .conversations(project.id) }
        if environment.hasPluginCommand(GitControlPlugin.openCommandID) {
            Button("menu.git.control") { environment.openPluginSheet(GitControlPlugin.sheetID, project: project.id) }
        }
        Button("menu.merge.center") { environment.editorRequest = .mergeCenter(project.id) }
        Button("worktrees.manageEllipsis") { environment.editorRequest = .worktrees(project.id) }
        Button("menu.merge.branchTesting") { environment.editorRequest = .branchTesting(project.id) }
        Button("agentLibrary.openEllipsis") { environment.editorRequest = .agentLibrary(project.id) }
        if environment.features.isOn(.graphify) {
            Button("graphify.openInProject") {
                environment.open(.graphify, in: project.id, actionName: String(localized: "undo.addContent"))
            }
            .accessibilityIdentifier("graphify.openInProject")
        }
        if environment.features.isOn(.orchestrator) {
            // Upstream `menu.addOrchestrator` always adds a board, like Add Content.
            Button("orchestrator.addToProject") {
                actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "undo.addContent")) {
                    $0.addPane(to: project.id, content: .orchestrator)
                }
            }
            .accessibilityIdentifier("orchestrator.addToProject")
        }
        Menu("sidebar.grids") {
            Button("projectGrid.main") { actions.workspace.update { $0.activateGrid(nil, in: project.id) } }
            ForEach(project.namedGrids) { grid in
                Button { actions.workspace.update { $0.activateGrid(grid.id, in: project.id) } } label: { Text(verbatim: grid.name) }
            }
            Divider()
            Button("projectGrid.newEllipsis") {
                ProjectGridPrompts.createGrid(in: project.id, workspace: actions.workspace, undoManager: actions.undoManager)
            }
        }
        Divider()
        if doc.isProjectDisabled(project.id) {
            Button("sidebar.enableProject") { actions.setProjectDisabled(project.id, false) }
        } else {
            Button("sidebar.disableProject") { actions.setProjectDisabled(project.id, true) }
                .disabled(project.panes.isEmpty)
        }
        Divider()
        Button("sidebar.removeProject") { actions.remove(project.id) }
    }
}

private struct TabContextMenu: View {
    let tab: PaneTab
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        Button("terminal.restart") { environment.terminals.restart(tab, in: project, environment: environment) }
        Button("openIn.vscode") {
            OpenInActions.vsCode(tab.workingDirectory ?? project.folder, launchers: environment.launchers)
        }
        Button("sidebar.revealInFinder") { OpenInActions.revealInFinder(tab.workingDirectory ?? project.folder) }
        if let pane = actions.workspace.document.paneHolding(tab.id)?.pane {
            Button(pane.isDisabled ? LocalizedStringKey("pane.enable") : "pane.disable") {
                actions.setTabDisabled(tab.id, !pane.isDisabled)
            }
            Divider()
            Button("subtabs.newEllipsis") { environment.editorRequest = .newSubTab(pane.id) }
            Button(pane.isLaneVisible ? LocalizedStringKey("subtabs.hideLane") : "subtabs.showLane") {
                actions.setLaneVisible(!pane.isLaneVisible, for: pane.id)
            }
            .disabled(pane.tabs.count > 1)
            if pane.content.isTerminal {
                Divider()
                RemoteShareToggle(pane: pane)
            }
        }
        if let agentID = tab.worktreeAgentID {
            Divider()
            Button("worktree.commitEllipsis") { WorktreeActions.commit(agentID, project: project) }
            Button("worktree.remove") {
                WorktreeActions.remove(agentID, tab: tab.id, project: project, workspace: actions.workspace)
            }
        }
        Divider()
        Button("terminal.close") { actions.closeTab(tab.id) }
    }
}

/// Share with Remote Devices (upstream `sidebarMenus.tsx` `remoteShared`): a terminal pane stays
/// private to this Mac until shared; paired devices see every tab of a shared pane.
struct RemoteShareToggle: View {
    let pane: Pane
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        Toggle("remote.share", isOn: Binding(get: { pane.isRemoteShared },
                                             set: { environment.remoteControl.setShared(pane.id, $0) }))
            .accessibilityIdentifier("remote.share")
    }
}

/// Marks a terminal shared with remote devices, in the sidebar and the pane header.
struct RemoteSharedGlyph: View {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Image(systemName: "iphone.radiowaves.left.and.right")
            .font(metrics.font(.caption))
            .foregroundStyle(theme[.accent])
            .help(Text("remote.shared"))
            .accessibilityLabel(Text("remote.shared"))
            .accessibilityIdentifier("remote.sharedGlyph")
    }
}

/// Worktree actions of an agent tab (P4-9); git runs off the main thread, failures show an alert.
@MainActor
enum WorktreeActions {
    static func commit(_ agentID: String, project: Project) {
        let alert = NSAlert()
        alert.messageText = String(localized: "worktree.commit.title")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = GitWorktrees.defaultCommitMessage
        field.setAccessibilityIdentifier("worktree.commit.message")
        alert.informativeText = String(localized: "worktree.commit.message")
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "worktree.commit.confirm"))
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let message = field.stringValue
        let repo = URL(filePath: project.folder)
        Task {
            do {
                let committed = try await GitWorktrees().commitPending(repo: repo, agentId: agentID, message: message)
                if !committed { inform(String(localized: "worktree.nothingToCommit"), text: "") }
            } catch {
                inform(String(localized: "worktree.failed"), text: NewTerminalSheet.describe(error))
            }
        }
    }

    static func remove(_ agentID: String, tab: TabID, project: Project, workspace: WorkspaceModel) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(localized: "worktree.remove.title")
        alert.informativeText = String(localized: "worktree.remove.detail")
        alert.addButton(withTitle: String(localized: "worktree.remove"))
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let repo = URL(filePath: project.folder)
        Task {
            do {
                try await GitWorktrees().remove(repo: repo, agentId: agentID, force: true)
                workspace.update {
                    $0.updateTab(tab) {
                        $0.worktreeAgentID = nil
                        $0.worktreeBranch = nil
                        $0.workingDirectory = nil
                    }
                }
            } catch {
                inform(String(localized: "worktree.failed"), text: NewTerminalSheet.describe(error))
            }
        }
    }

    private static func inform(_ title: String, text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }
}

/// Display names of agents (product names, not translated).
enum AgentLabels {
    static func name(for agent: String) -> String {
        AgentRegistry.builtin.descriptor(for: AgentKind(rawValue: agent))?.displayName ?? agent
    }
}
