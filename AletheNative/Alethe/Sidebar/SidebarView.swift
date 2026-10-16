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
            List {}.modifier(SidebarListAppearance())
        }
    }

    @ViewBuilder private func content(_ workspace: WorkspaceModel) -> some View {
        if metrics.isWebInterface {
            VStack(spacing: 0) {
                SidebarProjectsHeader(actions: SidebarActions(workspace: workspace, undoManager: undoManager))
                projectList(workspace)
            }
        } else { projectList(workspace) }
    }

    private func projectList(_ workspace: WorkspaceModel) -> some View {
        let actions = SidebarActions(workspace: workspace, undoManager: undoManager)
        let doc = workspace.document
        return List(selection: selection(workspace, actions)) {
            Section {
                if doc.projects.isEmpty && doc.groups.isEmpty {
                    VStack(alignment: .leading, spacing: metrics.space(.s)) {
                        Label("sidebar.empty.title", systemImage: "folder")
                            .font(metrics.font(.headline))
                        Text("sidebar.empty.detail")
                            .font(metrics.font(.caption))
                        Button("menu.file.newProject") { environment.editorRequest = .newProject(.ungrouped) }
                    }
                    .padding(metrics.space(.s))
                    .accessibilityIdentifier("sidebar.empty")
                }
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
                if !metrics.isWebInterface { SidebarProjectsHeader(actions: actions) }
            }
        }
        .modifier(SidebarListAppearance())
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

    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: metrics.isWebInterface ? metrics.size(4) : metrics.space(.xxs)) {
            AletheSectionLabel(Text("sidebar.projects.header"))
            Spacer(minLength: metrics.space(.s))
            Button { environment.editorRequest = .newGroup(parent: nil) } label: {
                Label("menu.file.newGroup", systemImage: metrics.isWebInterface ? "folder.badge.plus" : "rectangle.stack.badge.plus")
            }
            .buttonStyle(AletheIconButtonStyle(side: 20))
            .help(Text("menu.file.newGroup"))
            .accessibilityIdentifier("sidebar.newGroup")
            if !metrics.isWebInterface {
                Button { actions.chooseFolders() } label: {
                    Label("sidebar.addProject", systemImage: "folder.badge.plus")
                }
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .help(Text("sidebar.addProject"))
                .accessibilityIdentifier("sidebar.addProject")
            }
            if metrics.isWebInterface {
                Menu {
                    Button("menu.file.newProject") { environment.editorRequest = .newProject(.ungrouped) }
                    Button("sidebar.addProject") { actions.chooseFolders() }
                        .accessibilityIdentifier("sidebar.addProject")
                } label: {
                    Label("menu.file.newProject", systemImage: "plus")
                } primaryAction: {
                    environment.editorRequest = .newProject(.ungrouped)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .frame(width: metrics.size(20), height: metrics.size(20))
                .help(Text("menu.file.newProject"))
                .accessibilityIdentifier("sidebar.newProject")
            } else {
                Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                    Label("menu.file.newProject", systemImage: "plus")
                }
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .help(Text("menu.file.newProject"))
                .accessibilityIdentifier("sidebar.newProject")
            }
        }
        .padding(.horizontal, metrics.isWebInterface ? metrics.size(12) : 0)
        .frame(height: metrics.isWebInterface ? metrics.size(34) : nil)
        .overlay(alignment: .bottom) {
            if metrics.isWebInterface {
                Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
            }
        }
    }
}

private struct GroupRow: View {
    let group: ProjectGroup
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @State private var hovering = false

    var body: some View {
        let doc = actions.workspace.document
        SidebarDisclosure(isGroup: true, item: .group(group.id), isExpanded: Binding {
            !group.isCollapsed
        } set: { expanded in
            actions.setCollapsed(group.id, !expanded)
        }) {
            if group.projectIDs.isEmpty && doc.childGroups(of: group.id).isEmpty {
                Text("sidebar.group.empty")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.fgFaint])
            }
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
                HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.s)) {
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
                        .frame(height: metrics.size(1))
                        .frame(maxWidth: .infinity)
                    Button { environment.editorRequest = .newProject(.group(group.id)) } label: {
                        Label("sidebar.newProjectHere", systemImage: "plus")
                    }
                    .buttonStyle(AletheIconButtonStyle(side: metrics.isWebInterface ? 18 : 20))
                    .help(Text("sidebar.newProjectHere"))
                    .opacity(hovering ? 1 : 0)
                }
            } icon: {
                if metrics.isWebInterface {
                    EmptyView()
                } else if let color = group.color {
                    AletheMonogram(name: group.name, color: theme[color.token], side: 14)
                } else {
                    Image(systemName: "folder")
                        .foregroundStyle(theme[.fgFaint])
                }
            }
            .modifier(SidebarLabelAppearance(isGroup: true))
            .modifier(SidebarWebRow(kind: .group, first: doc.childGroups(of: nil).first?.id == group.id))
            .onDrop(of: [.plainText], isTargeted: nil) { providers in
                SidebarDrag.load(providers) { actions.drop($0, onGroup: group.id) }
                return true
            }
            .onHover { hovering = $0 }
            .contextMenu {
                Button("sidebar.openOnlyGroup") { actions.openGroup(group.id, adding: false) }
                    .disabled(!doc.groups.contains { doc.isGroup($0.id, inside: group.id) && !$0.projectIDs.isEmpty })
                Button("sidebar.addGroupToTab") { actions.openGroup(group.id, adding: true) }
                    .disabled(!doc.groups.contains { doc.isGroup($0.id, inside: group.id) && !$0.projectIDs.isEmpty })
                Divider()
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
                Button("sidebar.deleteGroupAndProjects", role: .destructive) { actions.deleteGroupAndProjects(group) }
            }
            .accessibilityIdentifier("sidebar.group.\(group.name)")
        }
        .modifier(SidebarNativeDragSource(payload: SidebarDrag.payload(group.id)))
    }
}

private struct ProjectRow: View {
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var merges = ProjectMergeWatcher()
    @State private var hovering = false

    var body: some View {
        let tabs = project.panes.flatMap(\.tabs)
        let planning = environment.gsdSync.sessions(of: project.id)
        Group {
            if !metrics.isWebInterface && tabs.isEmpty && merges.sessions.isEmpty && planning.isEmpty {
                label
            } else {
                SidebarDisclosure(isGroup: false, item: .project(project.id)) {
                    if metrics.isWebInterface {
                        ForEach(project.panes) { pane in
                            if let tab = pane.activeTab {
                                SidebarTerminalRow(tab: tab, project: project, actions: actions)
                            } else if pane.content.filePath != nil {
                                SidebarFileRow(pane: pane, project: project, actions: actions)
                            }
                        }
                    } else {
                        ForEach(tabs) { tab in
                            SidebarTerminalRow(tab: tab, project: project, actions: actions)
                        }
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
        .modifier(SidebarNativeDragSource(payload: SidebarDrag.payload(project.id)))
        .task(id: project.folder) {
            await merges.watch(folder: URL(filePath: project.folder, directoryHint: .isDirectory), projectID: project.id)
        }
    }

    private var label: some View {
        let doc = actions.workspace.document
        let dimmed = doc.isProjectDisabled(project.id) || doc.isSuspended(project.id)
        let selected = doc.workspace.selectedProjectID == project.id
        let working = project.panes.flatMap(\.tabs).contains { environment.terminals.activity[$0.id] == .working }
        return Label {
            HStack(spacing: metrics.isWebInterface ? metrics.size(9) : metrics.space(.xs)) {
                Text(verbatim: project.name)
                    .font(metrics.font(size: 12.5, weight: selected ? .medium : .regular))
                    .foregroundStyle(theme[dimmed ? .textTertiary : .textPrimary])
                if working && !metrics.isWebInterface {
                    AletheActivitySpinner()
                        .accessibilityLabel(Text("agentStatus.working"))
                }
                if !project.panes.isEmpty && project.panes.allSatisfy(\.isDisabled) {
                    Image(systemName: "pause.circle")
                        .foregroundStyle(theme[.statusDisabled])
                        .accessibilityLabel(Text("sidebar.disableProject"))
                }
                Spacer(minLength: metrics.space(.xxs))
                Button { environment.editorRequest = .newTerminal(project.id) } label: {
                    Label("terminal.new", systemImage: "plus")
                }
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .help(Text("terminal.new"))
                .opacity(hovering || (metrics.isWebInterface && project.panes.isEmpty) ? 1 : 0)
                Menu { ProjectContextMenu(project: project, actions: actions) } label: {
                    Label("sidebar.rowMenu", systemImage: "ellipsis")
                }
                .menuIndicator(.hidden)
                .menuStyle(.borderlessButton)
                .fixedSize()
                .frame(width: metrics.isWebInterface ? metrics.size(hovering ? 20 : working ? 16 : 0) : nil)
                .help(Text("sidebar.rowMenu"))
                .opacity(hovering ? 1 : 0)
                .overlay {
                    if metrics.isWebInterface && working && !hovering {
                        AletheActivitySpinner()
                            .accessibilityLabel(Text("agentStatus.working"))
                            .allowsHitTesting(false)
                    }
                }
            }
        } icon: {
            if metrics.isWebInterface {
                Image(systemName: "folder")
                    .font(metrics.font(size: 16))
                    .foregroundStyle(theme[project.color.token])
                    .saturation(dimmed ? 0 : 1)
                    .opacity(dimmed ? 0.6 : 1)
            } else {
                AletheMonogram(name: project.name, color: theme[project.color.token])
                    .opacity(dimmed ? 0.6 : 1)
            }
        }
        .modifier(SidebarLabelAppearance(isGroup: false))
        .modifier(SidebarWebRow(kind: .project))
        .onHover { hovering = $0 }
        .tag(SidebarItem.project(project.id))
        .help(Text(verbatim: project.folder))
        .onDrop(of: [.plainText], isTargeted: nil) { providers in
            SidebarDrag.load(providers) { actions.drop($0, onProject: project.id) }
            return true
        }
        .contextMenu { ProjectContextMenu(project: project, actions: actions) }
        .accessibilityIdentifier("sidebar.project.\(project.name)")
    }
}

private struct SidebarTerminalRow: View {
    let tab: PaneTab
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    private var webAgentSymbol: String {
        switch tab.agent {
        case "shell": "chevron.right"
        case "claude": "sun.max.fill"
        case "codex": "hexagon"
        case "opencode": "chevron.left.forwardslash.chevron.right"
        default: "terminal"
        }
    }

    var body: some View {
        let pane = actions.workspace.document.paneHolding(tab.id)?.pane
        let disabled = pane?.isDisabled == true
        let statusTab = pane?.tabs.first { environment.terminals.activity[$0.id] == .working }
            ?? pane?.tabs.first { environment.terminals.unread.contains($0.id) } ?? tab
        Label {
            HStack(spacing: metrics.isWebInterface ? metrics.size(9) : metrics.space(.xs)) {
                Text(verbatim: environment.terminals.displayName(of: tab))
                    .font(metrics.font(size: 12.5))
                    .foregroundStyle(theme[disabled ? (metrics.isWebInterface ? .textQuaternary : .textTertiary) : metrics.isWebInterface ? .fg : .fgMuted])
                    .lineLimit(1)
                if !metrics.isWebInterface { AgentStatusGlyph(tab: tab.id) }
                if let pane, pane.tabs.count > 1, metrics.isWebInterface || pane.tabs.first?.id == tab.id {
                    if metrics.isWebInterface {
                        Text(verbatim: "\(pane.tabs.count)")
                            .font(metrics.font(size: 11))
                            .foregroundStyle(theme[.textTertiary])
                            .padding(.horizontal, metrics.size(7))
                            .padding(.vertical, metrics.size(4))
                            .background(theme[.panelHover].opacity(0.6),
                                        in: RoundedRectangle(cornerRadius: metrics.size(5)))
                    } else { AletheCountPill(pane.tabs.count) }
                }
                Spacer(minLength: metrics.space(.xxs))
                if metrics.isWebInterface && !hovering { AgentStatusGlyph(tab: statusTab.id) }
                Menu {
                    TabContextMenu(tab: tab, project: project, actions: actions)
                } label: {
                    Label("sidebar.rowMenu", systemImage: "ellipsis")
                }
                .menuIndicator(.hidden)
                .menuStyle(.borderlessButton)
                .fixedSize()
                .frame(width: metrics.isWebInterface ? metrics.size(hovering ? 20 : 0) : nil)
                .help(Text("sidebar.rowMenu"))
                .opacity(hovering ? 1 : 0)
                if pane?.isRemoteShared == true { RemoteSharedGlyph() }
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
            if metrics.isWebInterface {
                AletheSidebarItemIcon(symbol: webAgentSymbol, shell: tab.agent == "shell")
                    .foregroundStyle(theme[tab.agent == "shell" ? .fgMuted : AgentTokens.accent(for: tab.agent)])
                    .saturation(disabled ? 0 : 1)
                    .opacity(disabled ? 0.6 : 1)
            } else {
                Image(systemName: disabled ? "pause.circle"
                      : environment.terminals.hibernated.contains(tab.id) ? "moon.zzz"
                      : tab.agent == "shell" ? "terminal" : "sparkles")
                    .foregroundStyle(theme[disabled ? .statusDisabled : AgentTokens.accent(for: tab.agent)])
                    .saturation(disabled ? 0 : 1)
                    .help(environment.terminals.hibernated.contains(tab.id) ? Text("sidebar.hibernated") : Text(verbatim: ""))
            }
        }
        .modifier(SidebarLabelAppearance(isGroup: false))
        .modifier(SidebarWebRow(kind: .terminal,
            focused: actions.workspace.document.workspace.focusedPaneID == pane?.id))
        .onHover { hovering = $0 }
        .tag(SidebarItem.tab(tab.id))
        .contextMenu { TabContextMenu(tab: tab, project: project, actions: actions) }
        .accessibilityIdentifier("sidebar.tab.\(tab.agent)")
    }
}

/// File panes have no terminal sub-tabs, but occupy the same row in the web tree.
private struct SidebarFileRow: View {
    let pane: Pane
    let project: Project
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    private var path: String { pane.content.filePath ?? "" }

    var body: some View {
        HStack(spacing: metrics.size(9)) {
            AletheSidebarItemIcon(symbol: "doc.text")
                .foregroundStyle(theme[.fgMuted])
            Text(verbatim: URL(filePath: path).lastPathComponent)
                .font(metrics.font(size: 12.5))
                .lineLimit(1)
            Spacer(minLength: 0)
            Menu {
                Button("sidebar.revealInFinder") { OpenInActions.revealInFinder(path) }
                Button("terminal.close") { actions.workspace.update { $0.closePane(pane.id) } }
            } label: {
                Label("sidebar.rowMenu", systemImage: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .frame(width: metrics.size(hovering ? 20 : 0))
            .opacity(hovering ? 1 : 0)
            .help(Text("sidebar.rowMenu"))
        }
        .foregroundStyle(theme[.fg])
        .contentShape(Rectangle())
        .onTapGesture {
            actions.select(.project(project.id))
            actions.workspace.update {
                $0.activateGrid(pane.gridID, in: project.id)
                $0.workspace.focusedPaneID = pane.id
            }
        }
        .modifier(SidebarWebRow(kind: .terminal,
            focused: actions.workspace.document.workspace.focusedPaneID == pane.id))
        .onHover { hovering = $0 }
        .help(Text(verbatim: path))
        .accessibilityIdentifier("sidebar.file.\(pane.id.rawValue)")
    }
}

private struct ProjectContextMenu: View {
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    var body: some View {
        let doc = actions.workspace.document
        NewTerminalButton(project: project)
        Divider()
        Button("sidebar.designLayout") { environment.editorRequest = .layoutDesigner(project.id) }
        Button("sidebar.rename") {
            guard let name = SidebarRenamePrompt.name(initial: project.name, width: metrics.size(280), height: metrics.size(24)) else { return }
            actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "sidebar.rename")) {
                $0.updateProject(project.id) { $0.name = name }
            }
        }
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
    @Environment(\.metrics) private var metrics

    var body: some View {
        Button("sidebar.rename") {
            guard let name = SidebarRenamePrompt.name(initial: tab.title ?? "", width: metrics.size(280), height: metrics.size(24)) else { return }
            actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "sidebar.rename")) {
                $0.updateTab(tab.id) { $0.title = name }
            }
        }
        Button("sidebar.killTerminal") { environment.terminals.view(for: tab.id)?.terminate() }
            .disabled(environment.terminals.view(for: tab.id) == nil)
        Button("terminal.restart") { environment.terminals.restart(tab, in: project, environment: environment) }
        Button("openIn.vscode") {
            OpenInActions.vsCode(tab.workingDirectory ?? project.folder, launchers: environment.launchers)
        }
        Button("sidebar.revealInFinder") { OpenInActions.revealInFinder(tab.workingDirectory ?? project.folder) }
        if let pane = actions.workspace.document.paneHolding(tab.id)?.pane {
            Button(environment.focusModePaneID == pane.id ? LocalizedStringKey("focusMode.exit") : "focusMode.enter") {
                if environment.focusModePaneID == pane.id {
                    environment.focusModePaneID = nil
                } else {
                    actions.select(.tab(tab.id))
                    environment.focusModePaneID = pane.id
                }
            }
            if !project.namedGrids.isEmpty {
                Menu("pane.moveToGrid") {
                    Button("projectGrid.main") { move(pane.id, to: nil) }
                        .disabled(pane.gridID == nil)
                    ForEach(project.namedGrids) { grid in
                        Button { move(pane.id, to: grid.id) } label: { Text(verbatim: grid.name) }
                            .disabled(pane.gridID == grid.id)
                    }
                }
            }
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

    private func move(_ pane: PaneID, to grid: ProjectGridID?) {
        actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "undo.move")) {
            $0.movePane(pane, toGrid: grid)
        }
    }
}

@MainActor
private enum SidebarRenamePrompt {
    static func name(initial: String, width: CGFloat, height: CGFloat) -> String? {
        let alert = NSAlert()
        alert.messageText = String(localized: "sidebar.rename")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: width, height: height))
        field.stringValue = initial
        field.setAccessibilityIdentifier("sidebar.rename.name")
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "files.rename"))
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
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
