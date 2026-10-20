import AletheAgents
import AletheDesign
import AletheGit
import AletheGitControl
import AletheModel
import AppKit
import SwiftUI

/// Projects organized in nested groups, with each project's terminals underneath.
struct SidebarView: View {
    @AppStorage(SidebarProjectVisibility.archivedGroupsKey) private var archivedGroups = "[]"
    @AppStorage(SidebarProjectVisibility.revealKey) private var revealHidden = false

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
                if workspace.document.projects.isEmpty && workspace.document.groups.isEmpty {
                    GeometryReader { geometry in
                        ScrollView {
                            SidebarWebEmptyState()
                                .frame(minHeight: geometry.size.height)
                        }
                    }
                    .accessibilityIdentifier("sidebar.list")
                    .dropDestination(for: URL.self) { urls, _ in
                        !SidebarActions(workspace: workspace, undoManager: undoManager).addProjects(folders: urls).isEmpty
                    }
                    .webContextMenu {
                        SidebarMenuButton("menu.file.newProject", symbol: "plus") {
                            environment.editorRequest = .newProject(.ungrouped)
                        }
                        SidebarMenuButton("sidebar.addProject", symbol: "folder.badge.plus") {
                            SidebarActions(workspace: workspace, undoManager: undoManager).chooseFolders()
                        }
                        SidebarMenuButton("menu.file.newGroup", symbol: "folder.badge.plus") {
                            environment.editorRequest = .newGroup(parent: nil)
                        }
                    }
                } else { projectList(workspace) }
                if workspace.document.groups.contains(where: { groupArchived($0.id) }) || workspace.document.projects.contains(where: {
                    $0.hidden == true
                    || $0.archived == true
                }) {
                    WebMenu { visibilityControls(workspace) } label: {
                        Label { Text("sidebar.web.projectVisibility") } icon: { Image(systemName: "eye").webProfileSized(14) }
                            .font(metrics.font(size: 11))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(metrics.size(8))
                    }
                    .menuStyle(.borderlessButton)
                    .padding(.horizontal, metrics.size(8))
                    .accessibilityIdentifier("sidebar.projectVisibility")
                }
            }
        } else { projectList(workspace) }
    }

    private func projectList(_ workspace: WorkspaceModel) -> some View {
        let actions = SidebarActions(workspace: workspace, undoManager: undoManager)
        let doc = workspace.document
        let projectIDs = doc.ungroupedProjectIDs.filter {
            !metrics.isWebInterface || SidebarProjectVisibility.visible(doc.project($0), reveal: revealHidden)
        }
        return List(selection: selection(workspace, actions)) {
            Section {
                if doc.projects.isEmpty && doc.groups.isEmpty {
                    VStack(alignment: .leading, spacing: metrics.space(.s)) {
                        Label { Text("sidebar.empty.title") } icon: { Image(systemName: "folder").webProfileSized(14) }
                            .font(metrics.font(.headline))
                        Text("sidebar.empty.detail")
                            .font(metrics.font(.caption))
                        Button("menu.file.newProject") { environment.editorRequest = .newProject(.ungrouped) }
                    }
                    .padding(metrics.space(.s))
                    .accessibilityIdentifier("sidebar.empty")
                }
                ForEach(doc.childGroups(of: nil).filter { !metrics.isWebInterface || !SidebarProjectVisibility.containsGroup(archivedGroups, group: $0.id, profile: environment.profileID) }) { group in
                    GroupRow(group: group, actions: actions)
                }
                .onInsert(of: metrics.isWebInterface ? [] : [.plainText]) { index, providers in
                    SidebarDrag.load(providers) { actions.insertGroup($0, under: nil, at: index) }
                }
                if metrics.isWebInterface && projectIDs.isEmpty {
                    SidebarUngroupedDropArea(actions: actions)
                }
                ForEach(projectIDs, id: \.self) { id in
                    if let project = doc.project(id) {
                        ProjectRow(project: project, actions: actions)
                    }
                }
                .onMove(perform: metrics.isWebInterface ? nil : { source, destination in actions.reorder(in: .ungrouped, from: source, to: destination, visibleIDs: nil) })
                .onInsert(of: metrics.isWebInterface ? [] : [.plainText]) { index, providers in
                    SidebarDrag.load(providers) { actions.insert($0, into: .ungrouped, at: metrics.isWebInterface ? actions.insertionIndex(index, in: .ungrouped, visibleIDs: projectIDs) : index) }
                }
            } header: {
                if !metrics.isWebInterface { SidebarProjectsHeader(actions: actions) }
            }
        }
        .modifier(SidebarListAppearance())
        .modifier(SidebarWebDropSurface(actions: actions))
        // Clean density uses the available upstream visual-clean.css tokens.
        .environment(\.sidebarRowSize, metrics.style == .clean ? .small : .medium)
        .accessibilityIdentifier("sidebar.list")
        .modifier(SidebarNativeFolderDrop(actions: actions))
        .webContextMenu {
            SidebarMenuButton("menu.file.newProject", symbol: "plus") { environment.editorRequest = .newProject(.ungrouped) }
            SidebarMenuButton("sidebar.addProject", symbol: "folder.badge.plus") { actions.chooseFolders() }
            SidebarMenuButton("menu.file.newGroup", symbol: "folder.badge.plus") { environment.editorRequest = .newGroup(parent: nil) }
            if metrics.isWebInterface {
                visibilityControls(workspace)
            }
        }
    }

    @ViewBuilder private func visibilityControls(_ workspace: WorkspaceModel) -> some View {
        let groups = workspace.document.groups.filter { groupArchived($0.id) }
        if !groups.isEmpty {
            WebSubmenu("sidebar.web.restoreGroups") {
                ForEach(groups) { group in
                    Button {
                        archivedGroups = SidebarProjectVisibility.setting(archivedGroups,
                            project: ProjectID(rawValue: group.id.rawValue), profile: environment.profileID, enabled: false)
                    } label: { Text(verbatim: group.name) }
                }
            }
        }
        let hidden = workspace.document.projects.filter {
            $0.hidden == true
                && $0.archived != true
        }
        let archived = workspace.document.projects.filter {
            $0.archived == true
        }
        if !hidden.isEmpty || revealHidden {
            WebMenuDivider()
            SidebarMenuButton(revealHidden ? "sidebar.web.hideHidden" : "sidebar.web.revealHidden",
                              symbol: revealHidden ? "eye.slash" : "eye") { revealHidden.toggle() }
        }
        if !archived.isEmpty {
            WebSubmenu("sidebar.web.restoreArchived", symbol: "archivebox") {
                ForEach(archived) { project in
                    Button {
                        workspace.update { $0.updateProject(project.id) { $0.archived = false } }
                    } label: { Label { Text(verbatim: project.name) } icon: { Image(systemName: "arrow.uturn.backward").webProfileSized(14) } }
                }
            }
        }
    }

    private func groupArchived(_ id: GroupID) -> Bool {
        SidebarProjectVisibility.contains(archivedGroups, project: ProjectID(rawValue: id.rawValue), profile: environment.profileID)
    }

    private func selection(_ workspace: WorkspaceModel, _ actions: SidebarActions) -> Binding<SidebarItem?> {
        Binding {
            if metrics.isWebInterface { return nil }
            let state = workspace.document.workspace
            if let focused = state.focusedPaneID, let (project, pane) = workspace.document.pane(focused),
               project.id == state.selectedProjectID, let tab = pane.activeTab {
                return .tab(tab.id)
            }
            return state.selectedProjectID.map(SidebarItem.project)
        } set: { item in
            if !metrics.isWebInterface { actions.select(item) }
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
                .lineLimit(1)
            Spacer(minLength: metrics.space(.s))
            Button { environment.editorRequest = .newGroup(parent: nil) } label: {
                Label { Text("menu.file.newGroup") } icon: { Image(systemName: metrics.isWebInterface ? "folder.badge.plus" : "rectangle.stack.badge.plus").webProfileSized(14) }
                    .modifier(SidebarSymbolAppearance(size: 14))
            }
            .buttonStyle(AletheIconButtonStyle(side: 20))
            .help(Text("menu.file.newGroup"))
            .accessibilityIdentifier("sidebar.newGroup")
            if !metrics.isWebInterface {
                Button { actions.chooseFolders() } label: {
                    Label { Text("sidebar.addProject") } icon: { Image(systemName: "folder.badge.plus").webProfileSized(14) }
                }
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .help(Text("sidebar.addProject"))
                .accessibilityIdentifier("sidebar.addProject")
            }
            if metrics.isWebInterface {
                Menu {
                    SidebarMenuButton("menu.file.newProject", symbol: "plus") { environment.editorRequest = .newProject(.ungrouped) }
                    SidebarMenuButton("sidebar.addProject", symbol: "folder.badge.plus") { actions.chooseFolders() }
                        .accessibilityIdentifier("sidebar.addProject")
                } label: {
                    Label { Text("menu.file.newProject") } icon: { Image(systemName: "plus").webProfileSized(14) }.labelStyle(.iconOnly)
                } primaryAction: {
                    environment.editorRequest = .newProject(.ungrouped)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .modifier(SidebarMenuAppearance())
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .frame(width: metrics.size(20), height: metrics.size(20))
                .help(Text("menu.file.newProject"))
                .accessibilityIdentifier("sidebar.newProject")
            } else {
                Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                    Label { Text("menu.file.newProject") } icon: { Image(systemName: "plus").webProfileSized(14) }
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
    @AppStorage(SidebarProjectVisibility.archivedGroupsKey) private var archivedGroups = "[]"
    @AppStorage(SidebarProjectVisibility.revealKey) private var revealHidden = false

    let group: ProjectGroup
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private func groupArchived(_ id: GroupID) -> Bool {
        SidebarProjectVisibility.contains(archivedGroups, project: ProjectID(rawValue: id.rawValue), profile: environment.profileID)
    }

    @State private var hovering = false
    @State private var dropTarget = false

    var body: some View {
        let doc = actions.workspace.document
        let projectIDs = group.projectIDs.filter {
            !metrics.isWebInterface || SidebarProjectVisibility.visible(doc.project($0), reveal: revealHidden)
        }
        let webChildren = metrics.isWebInterface ? doc.sidebarChildren(of: group.id).filter { child in
            switch child {
            case .group(let id): !SidebarProjectVisibility.containsGroup(archivedGroups, group: id, profile: environment.profileID)
            case .project(let id): SidebarProjectVisibility.visible(doc.project(id), reveal: revealHidden)
            }
        } : []
        SidebarDisclosure(isGroup: true, item: .group(group.id),
                          firstRootGroup: doc.childGroups(of: nil).first?.id == group.id, isExpanded: Binding {
            !group.isCollapsed
        } set: { expanded in
            actions.setCollapsed(group.id, !expanded)
        }) {
            if projectIDs.isEmpty && doc.childGroups(of: group.id).isEmpty {
                if metrics.isWebInterface {
                    SidebarWebGroupEmpty()
                        .modifier(SidebarWebDrop(target: .groupBody(group.id), actions: actions))
                } else {
                    Text("sidebar.group.empty")
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.fgFaint])
                }
            }
            if metrics.isWebInterface {
                // Child groups and projects share one order (a sub-group may sit between projects).
                ForEach(webChildren, id: \.self) { child in
                    switch child {
                    case .group(let id):
                        if let nested = doc.group(id) { GroupRow(group: nested, actions: actions) }
                    case .project(let id):
                        if let project = doc.project(id) { ProjectRow(project: project, actions: actions) }
                    }
                }
            } else {
                ForEach(doc.childGroups(of: group.id)) { child in
                    GroupRow(group: child, actions: actions)
                }
                .onInsert(of: [.plainText]) { index, providers in
                    SidebarDrag.load(providers) { actions.insertGroup($0, under: group.id, at: index) }
                }
                ForEach(projectIDs, id: \.self) { id in
                    if let project = doc.project(id) {
                        ProjectRow(project: project, actions: actions)
                    }
                }
                .onMove { source, destination in actions.reorder(in: .group(group.id), from: source, to: destination, visibleIDs: nil) }
                .onInsert(of: [.plainText]) { index, providers in
                    SidebarDrag.load(providers) { actions.insert($0, into: .group(group.id), at: index) }
                }
            }
        } label: {
            Label {
                // Upstream group tag: faint, lightly tracked name followed by a hairline rule.
                HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.s)) {
                    if metrics.isWebInterface, let icon = group.iconUrl, !icon.isEmpty {
                        SidebarCoverImage(source: icon, side: 16) {
                            Image(systemName: "folder").webProfileSized(16)
                                .foregroundStyle(theme[group.color?.token ?? .fgFaint])
                        }
                        .saturation(group.suspended == true ? 0 : 1)
                        .opacity(group.suspended == true ? 0.6 : 1)
                    }
                    Text(verbatim: group.name)
                        .font(metrics.font(size: 11))
                        .tracking(metrics.size(11) * 0.04)
                        .foregroundStyle(theme[group.suspended == true ? .textQuaternary : .fgFaint])
                        .lineLimit(1)
                        .layoutPriority(1)
                    if group.suspended == true {
                        Image(systemName: metrics.isWebInterface ? "pause" : "pause.circle.fill")
                            .webProfileSized(metrics.isWebInterface ? 10 : 14)
                            .modifier(SidebarSymbolAppearance(size: 10))
                            .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .statusDisabled])
                            .help(Text("sidebar.suspended"))
                            .accessibilityLabel(Text("sidebar.suspended"))
                    }
                    Rectangle()
                        .fill(theme[.border])
                        .frame(height: metrics.size(1))
                        .frame(maxWidth: .infinity)
                    Button { environment.editorRequest = .newProject(.group(group.id)) } label: {
                        Label { Text("sidebar.newProjectHere") } icon: { Image(systemName: "plus").webProfileSized(14) }
                            .modifier(SidebarSymbolAppearance(size: 14))
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
                    Image(systemName: "folder").webProfileSized(14)
                        .foregroundStyle(theme[.fgFaint])
                }
            }
            .modifier(SidebarLabelAppearance(isGroup: true))
            .modifier(SidebarWebGroupOpen {
                actions.openGroup(group.id, adding: false, web: metrics.isWebInterface)
                environment.showingHome = false
            })
            .modifier(SidebarWebRow(kind: .group, first: doc.childGroups(of: metrics.style == .clean ? group.parentID : nil).first?.id == group.id))
            .modifier(SidebarGroupRowDrop(target: group.id, actions: actions, targeted: $dropTarget))
            .modifier(SidebarWebDragSource(payload: SidebarDrag.payload(group.id), name: group.name))
            .onHover { hovering = $0 }
            .webContextMenu {
                SidebarMenuButton("sidebar.openOnlyGroup", symbol: "rectangle") {
                    actions.openGroup(group.id, adding: false, web: metrics.isWebInterface)
                    if metrics.isWebInterface { environment.showingHome = false }
                }
                    .disabled(!metrics.isWebInterface && !doc.groups.contains { doc.isGroup($0.id, inside: group.id) && !$0.projectIDs.isEmpty })
                SidebarMenuButton("sidebar.addGroupToTab", symbol: "rectangle.badge.plus") {
                    actions.openGroup(group.id, adding: true, web: metrics.isWebInterface)
                    if metrics.isWebInterface { environment.showingHome = false }
                }
                    .disabled(!metrics.isWebInterface && !doc.groups.contains { doc.isGroup($0.id, inside: group.id) && !$0.projectIDs.isEmpty })
                WebMenuDivider()
                if metrics.isWebInterface {
                    SidebarMenuButton("sidebar.designLayout", symbol: "rectangle.split.2x2") {
                        environment.editorRequest = .layoutDesigner(.group(group.id))
                    }
                    SidebarMenuButton("sidebar.web.archiveGroup", symbol: "archivebox") {
                        archivedGroups = SidebarProjectVisibility.setting(archivedGroups,
                            project: ProjectID(rawValue: group.id.rawValue), profile: environment.profileID, enabled: true)
                    }
                    SidebarMenuButton(group.isCollapsed ? "sidebar.web.expandGroup" : "sidebar.web.collapseGroup", symbol: "chevron.down") {
                        actions.setCollapsed(group.id, !group.isCollapsed)
                    }
                    SidebarMenuButton("sidebar.rename", symbol: "pencil") {
                        SidebarRenamePrompt.name(initial: group.name,
                            width: metrics.size(280), height: metrics.size(24)) { name in
                            actions.workspace.update { $0.updateGroup(group.id) { $0.name = name } }
                        }
                    }
                    if group.parentID != nil {
                        SidebarMenuButton("sidebar.web.makeRoot", symbol: "arrow.up") {
                            actions.workspace.update { $0.moveGroup(group.id, toParent: nil, at: Int.max) }
                        }
                    } else {
                        WebSubmenu("sidebar.web.moveGroup") {
                            ForEach(doc.groups.filter { !doc.isGroup($0.id, inside: group.id) }) { parent in
                                Button { actions.workspace.update { $0.moveGroup(group.id, toParent: parent.id, at: Int.max) } }
                                    label: { Text(verbatim: parent.name) }
                            }
                        }
                    }
                }
                SidebarMenuButton("sidebar.editGroup", symbol: "pencil") { environment.editorRequest = .editGroup(group.id) }
                SidebarMenuButton("sidebar.newProjectHere", symbol: "plus") { environment.editorRequest = .newProject(.group(group.id)) }
                SidebarMenuButton("sidebar.newSubgroup", symbol: "folder.badge.plus") { environment.editorRequest = .newGroup(parent: group.id) }
                WebMenuDivider()
                if group.suspended == true {
                    SidebarMenuButton("sidebar.resumeGroup", symbol: "play") { actions.resumeGroup(group.id) }
                } else {
                    SidebarMenuButton("sidebar.suspendGroupEllipsis", symbol: "pause") { actions.suspendGroup(group) }
                }
                WebMenuDivider()
                if metrics.isWebInterface {
                    SidebarMenuButton("sidebar.designLayout", symbol: "rectangle.split.2x2") {
                        environment.editorRequest = .layoutDesigner(.group(group.id))
                    }
                    SidebarMenuButton("sidebar.web.archiveGroup", symbol: "archivebox") {
                        archivedGroups = SidebarProjectVisibility.settingGroup(archivedGroups, group: group.id,
                            profile: environment.profileID, enabled: true)
                    }
                }
                SidebarMenuButton("sidebar.deleteGroup", symbol: "trash") { actions.deleteGroup(group.id) }
                SidebarMenuButton("sidebar.deleteGroupAndProjects", symbol: "trash", role: .destructive) { actions.deleteGroupAndProjects(group) }
            }
            .accessibilityIdentifier("sidebar.group.\(group.name)")
        }
        .modifier(SidebarWebGroupRegion(group: group.id))
        .modifier(SidebarNativeDragSource(payload: SidebarDrag.payload(group.id)))
    }
}

private struct ProjectRow: View {
    @State private var dropInside = false
    @AppStorage("sidebar.web.collapsedProjects") private var collapsedProjects = "[]"
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var merges = ProjectMergeWatcher()
    @State private var hovering = false
    @State private var dropTarget = false

    var body: some View {
        let tabs = project.panes.flatMap(\.tabs)
        let planning = environment.gsdSync.sessions(of: project.id)
        Group {
            if !metrics.isWebInterface && tabs.isEmpty && merges.sessions.isEmpty && planning.isEmpty {
                label
            } else {
                SidebarDisclosure(isGroup: false, item: .project(project.id), isExpanded: metrics.isWebInterface ? Binding(
                    get: { !SidebarProjectVisibility.contains(collapsedProjects, project: project.id, profile: environment.profileID) },
                    set: { collapsedProjects = SidebarProjectVisibility.setting(collapsedProjects, project: project.id,
                        profile: environment.profileID, enabled: !$0) }
                ) : nil) {
                    if metrics.isWebInterface {
                        ForEach(project.panes) { pane in
                            if let tab = pane.activeTab {
                                SidebarTerminalRow(tab: tab, project: project, actions: actions)
                                    .id(pane.id)
                            } else if !pane.content.isTerminal {
                                // File panes and the board / Graphify / diff / web panes occupy a row in the tree too.
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
                    .font(metrics.font(size: 12.5, weight: selected && (!metrics.isWebInterface || metrics.style == .normal) ? .medium : .regular))
                    .foregroundStyle(theme[dimmed ? .textTertiary : .textPrimary])
                    .lineLimit(metrics.isWebInterface ? 1 : nil)
                    .frame(maxWidth: metrics.isWebInterface ? .infinity : nil, alignment: .leading)
                if working && !metrics.isWebInterface {
                    AletheActivitySpinner()
                        .accessibilityLabel(Text("agentStatus.working"))
                }
                if !project.panes.isEmpty && project.panes.allSatisfy(\.isDisabled) {
                    Image(systemName: metrics.isWebInterface ? "pause" : "pause.circle")
                        .webProfileSized(metrics.isWebInterface ? 11 : 14)
                        .modifier(SidebarSymbolAppearance(size: 11))
                        .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .statusDisabled])
                        .accessibilityLabel(Text("sidebar.disableProject"))
                }
                if !metrics.isWebInterface { Spacer(minLength: metrics.space(.xxs)) }
                Button { environment.editorRequest = .newTerminal(project.id) } label: {
                    Label { Text("terminal.new") } icon: { Image(systemName: "plus").webProfileSized(metrics.isWebInterface ? (metrics.style == .clean ? 12 : 15) : 14) }
                        .modifier(SidebarSymbolAppearance(size: metrics.style == .clean ? 12 : 15))
                }
                .buttonStyle(AletheIconButtonStyle(side: 20))
                .help(Text("terminal.new"))
                .opacity(hovering || (metrics.isWebInterface && project.panes.isEmpty) ? 1 : 0)
                if metrics.isWebInterface {
                    SidebarRowEndSlot(active: working, hovering: hovering) {
                        if working {
                            AletheSidebarSizeSpinner()
                                .accessibilityLabel(Text("agentStatus.working"))
                        }
                    } action: {
                        WebMenu { ProjectContextMenu(project: project, actions: actions) } label: {
                            Label { Text("sidebar.rowMenu") } icon: { Image(systemName: "ellipsis").webProfileSized(metrics.style == .clean ? 13 : 14) }
                        }
                        .menuIndicator(.hidden)
                        .menuStyle(.borderlessButton)
                        .modifier(SidebarMenuAppearance(size: metrics.style == .clean ? 13 : 14))
                        .fixedSize()
                        .help(Text("sidebar.rowMenu"))
                    }
                } else {
                    Menu { ProjectContextMenu(project: project, actions: actions) } label: {
                        Label { Text("sidebar.rowMenu") } icon: { Image(systemName: "ellipsis").webProfileSized(14) }
                    }
                    .menuIndicator(.hidden)
                    .menuStyle(.borderlessButton)
                    .modifier(SidebarMenuAppearance())
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
            }
        } icon: {
            if metrics.isWebInterface {
                SidebarCoverImage(source: project.iconUrl ?? "", side: metrics.style == .normal ? 16 : 15) {
                    Image(systemName: "folder").webProfileSized(metrics.style == .clean ? 15 : 16)
                        .font(metrics.font(size: metrics.style == .clean ? 15 : 16))
                        .foregroundStyle(theme[project.color.token])
                }
                .saturation(dimmed ? 0 : 1)
                .opacity(dimmed ? 0.6 : 1)
            } else {
                AletheMonogram(name: project.name, color: theme[project.color.token])
                    .opacity(dimmed ? 0.6 : 1)
            }
        }
        .modifier(SidebarLabelAppearance(isGroup: false, iconSize: 16))
        .modifier(SidebarWebRow(kind: .project))
        .modifier(SidebarWebClick(single: {
            actions.workspace.update { $0.openWebProject(project.id) }
            environment.showingHome = false
        }))
        .onHover { hovering = $0 }
        .tag(SidebarItem.project(project.id))
        .help(Text(verbatim: project.folder))
        .modifier(SidebarProjectRowDrop(project: project.id, actions: actions,
                                        targeted: $dropTarget, inside: $dropInside))
        .modifier(SidebarWebDragSource(payload: SidebarDrag.payload(project.id), name: project.name))
        .webContextMenu { ProjectContextMenu(project: project, actions: actions) }
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

    private var agentTypes: [String] {
        let tabs = actions.workspace.document.paneHolding(tab.id)?.pane.tabs ?? [tab]
        return tabs.reduce(into: [tab.agent]) { agents, entry in
            if !agents.contains(entry.agent) { agents.append(entry.agent) }
        }
    }

    var body: some View {
        let pane = actions.workspace.document.paneHolding(tab.id)?.pane
        let disabled = pane?.isDisabled == true
        let working = pane?.tabs.contains { environment.terminals.activity[$0.id] == .working } == true
        let hidden = metrics.isWebInterface
            ? !(pane.map { actions.workspace.document.webPaneIsVisible($0.id) } ?? false)
            : !actions.workspace.document.workspace.openProjectIDs.contains(project.id)
        let statusTab = pane?.tabs.first { environment.terminals.activity[$0.id] == .working }
            ?? pane?.tabs.first { environment.terminals.unread.contains($0.id) } ?? tab
        Label {
            HStack(spacing: metrics.isWebInterface ? metrics.size(9) : metrics.space(.xs)) {
                Text(verbatim: environment.terminals.displayName(of: tab))
                    .font(metrics.font(size: 12.5))
                    .foregroundStyle(theme[metrics.isWebInterface ? (working ? .fg : disabled ? .textQuaternary : hidden ? .textTertiary : .fg) : (disabled ? .textTertiary : .fgMuted)])
                    .lineLimit(1)
                    .frame(maxWidth: metrics.isWebInterface ? .infinity : nil, alignment: .leading)
                if !metrics.isWebInterface { AgentStatusGlyph(tab: tab.id) }
                if let pane, pane.tabs.count > 1, metrics.isWebInterface || pane.tabs.first?.id == tab.id {
                    if metrics.isWebInterface {
                        Text(verbatim: "\(pane.tabs.count)")
                            .font(metrics.font(size: 11))
                            .foregroundStyle(theme[.textTertiary])
                            .padding(.horizontal, metrics.size(7))
                            .padding(.vertical, metrics.size(4))
                            .fixedSize()
                            .background(theme[.panelHover].opacity(0.6),
                                        in: RoundedRectangle(cornerRadius: metrics.size(5)))
                    } else { AletheCountPill(pane.tabs.count) }
                }
                if !metrics.isWebInterface { Spacer(minLength: metrics.space(.xxs)) }
                if metrics.isWebInterface {
                    SidebarRowEndSlot(active: environment.terminals.activity[statusTab.id] == .working
                        || environment.terminals.unread.contains(statusTab.id), hovering: hovering) {
                        SidebarWebTerminalStatus(tab: statusTab.id)
                    } action: {
                        WebMenu { TabContextMenu(tab: tab, project: project, actions: actions) } label: {
                            Label { Text("sidebar.rowMenu") } icon: { Image(systemName: "ellipsis").webProfileSized(13) }
                        }
                        .menuIndicator(.hidden)
                        .menuStyle(.borderlessButton)
                        .modifier(SidebarMenuAppearance(size: 13))
                        .fixedSize()
                        .help(Text("sidebar.rowMenu"))
                    }
                } else {
                    Menu {
                        TabContextMenu(tab: tab, project: project, actions: actions)
                    } label: {
                        Label { Text("sidebar.rowMenu") } icon: { Image(systemName: "ellipsis").webProfileSized(14) }
                }
                .menuIndicator(.hidden)
                .menuStyle(.borderlessButton)
                .modifier(SidebarMenuAppearance(size: 13))
                .fixedSize()
                .frame(width: metrics.isWebInterface ? metrics.size(hovering ? 20 : 0) : nil)
                .help(Text("sidebar.rowMenu"))
                .opacity(hovering ? 1 : 0)
                }
                if pane?.isRemoteShared == true { RemoteSharedGlyph() }
                if let branch = tab.worktreeBranch {
                    Image(systemName: "arrow.triangle.branch").webProfileSized(14)
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textTertiary])
                        .help(Text(verbatim: String(format: String(localized: "sidebar.worktree"), branch)))
                        .accessibilityLabel(Text(verbatim: String(format: String(localized: "sidebar.worktree"), branch)))
                        .accessibilityIdentifier("sidebar.tab.worktree")
                }
            }
        } icon: {
            if metrics.isWebInterface {
                HStack(spacing: metrics.size(2)) {
                    ForEach(agentTypes, id: \.self) { agent in
                        AgentLogo(agent: agent, size: 14)
                            .frame(width: metrics.size(15), height: metrics.size(15))
                    }
                }
                    .saturation(!working && (disabled || hidden) ? 0 : 1)
                    .opacity(!working && (disabled || hidden) ? 0.6 : 1)
            } else {
                Image(systemName: disabled ? "pause.circle"
                      : environment.terminals.hibernated.contains(tab.id) ? "moon.zzz"
                      : tab.agent == "shell" ? "terminal" : "sparkles").webProfileSized(14)
                    .foregroundStyle(theme[disabled ? .statusDisabled : AgentTokens.accent(for: tab.agent)])
                    .saturation(disabled ? 0 : 1)
                    .help(environment.terminals.hibernated.contains(tab.id) ? Text("sidebar.hibernated") : Text(verbatim: ""))
            }
        }
        .modifier(SidebarLabelAppearance(isGroup: false))
        .modifier(SidebarWebRow(kind: .terminal,
            focused: actions.workspace.document.workspace.focusedPaneID == pane?.id, project: project.id))
        .onHover { hovering = $0 }
        .tag(SidebarItem.tab(tab.id))
        .modifier(SidebarWebClick(single: { selectWebPane(individually: false) },
                                  double: { selectWebPane(individually: true) }))
        .modifier(SidebarWebDragSource(payload: pane.map { SidebarDrag.payload($0.id) } ?? "",
                                        name: environment.terminals.displayName(of: tab)))
        .modifier(SidebarWebHelp(text: environment.terminals.displayName(of: tab)))
        .webContextMenu { TabContextMenu(tab: tab, project: project, actions: actions) }
        .accessibilityIdentifier("sidebar.tab.\(tab.agent)")
    }

    private func selectWebPane(individually: Bool) {
        guard let pane = actions.workspace.document.paneHolding(tab.id)?.pane else { return }
        actions.workspace.update {
            if individually { $0.openWebPane(pane.id) } else { $0.focusWebPane(pane.id) }
        }
        environment.terminals.markRead(tab.id)
        environment.showingHome = false
        if environment.inspectedPaneID != nil { environment.inspectedPaneID = pane.id }
        // Also refocus on repeated clicks: the focused pane ID may already be unchanged.
        DispatchQueue.main.async { environment.terminals.view(for: tab.id)?.focus() }
    }
}

/// File panes have no terminal sub-tabs, but occupy the same row in the web tree.
private struct SidebarFileRow: View {
    let pane: Pane
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    private var path: String { pane.content.filePath ?? "" }

    private var symbol: String {
        switch pane.content {
        case .orchestrator: "rectangle.3.group"
        case .graphify: "point.3.connected.trianglepath.dotted"
        case .web: "globe"
        case .diff: "plusminus"
        case .image: "photo"
        case .video: "film"
        default: "doc.text"
        }
    }

    private var title: Text {
        switch pane.content {
        case .orchestrator: Text("orchestrator.title")
        case .graphify: Text("graphify.title")
        case .web(let url, _): Text(verbatim: URL(string: url)?.host ?? url)
        case .diff(let diffPath, _): Text(verbatim: diffPath.map { URL(filePath: $0).lastPathComponent } ?? "Diff")
        default: Text(verbatim: URL(filePath: path).lastPathComponent)
        }
    }

    var body: some View {
        HStack(spacing: metrics.size(9)) {
            AletheSidebarItemIcon(symbol: symbol)
                .foregroundStyle(theme[.fgMuted])
            title
                .font(metrics.font(size: 12.5))
                .lineLimit(1)
            Spacer(minLength: 0)
            WebMenu {
                if metrics.isWebInterface {
                    SidebarMenuButton("terminalInspector.open", symbol: "info.circle") { environment.inspectedPaneID = pane.id }
                }
                if metrics.isWebInterface, ["md", "markdown"].contains(URL(filePath: path).pathExtension.lowercased()) {
                    SidebarMenuButton("rightSidebar.files.openMarkdown", symbol: "sidebar.right") {
                        NotificationCenter.default.post(name: .sidebarOpenMarkdown, object: URL(filePath: path))
                        environment.rightSidebarTab = DocsView.tabID
                        environment.rightSidebarVisible = true
                    }
                }
                if pane.content.filePath != nil {
                    SidebarMenuButton("sidebar.revealInFinder", symbol: "folder") { OpenInActions.revealInFinder(path) }
                }
                SidebarMenuButton("terminal.close", symbol: "xmark") { actions.workspace.update { $0.closePane(pane.id) } }
            } label: {
                Label { Text("sidebar.rowMenu") } icon: { Image(systemName: "ellipsis").webProfileSized(14) }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .modifier(SidebarMenuAppearance(size: 13))
            .fixedSize()
            .opacity(hovering ? 1 : 0)
            .animation(nil, value: hovering)
            .frame(width: metrics.size(hovering ? 20 : 0))
            .animation(Motion.SidebarEffect.rowSlot.animation(reduceMotion: metrics.reducesMotion), value: hovering)
            .help(Text("sidebar.rowMenu"))
        }
        .foregroundStyle(theme[.fg])
        .contentShape(Rectangle())
        .onTapGesture {
            if metrics.isWebInterface {
                // The orchestration board is worked on alone: one click shows only it, in its own tab.
                actions.workspace.update {
                    if pane.content == .orchestrator { $0.openWebPane(pane.id) } else { $0.focusWebPane(pane.id) }
                }
                environment.showingHome = false
            } else {
                actions.select(.project(project.id))
                actions.workspace.update {
                    $0.activateGrid(pane.gridID, in: project.id)
                    $0.workspace.focusedPaneID = pane.id
                }
            }
        }
        .modifier(SidebarWebRow(kind: .terminal,
            focused: actions.workspace.document.workspace.focusedPaneID == pane.id, project: project.id))
        .modifier(SidebarWebDragSource(payload: SidebarDrag.payload(pane.id), name: pane.content.filePath ?? project.name))
        .onHover { hovering = $0 }
        .help(Text(verbatim: path))
        .accessibilityIdentifier("sidebar.file.\(pane.id.rawValue)")
    }
}

private struct ProjectContextMenu: View {
    @AppStorage(SidebarProjectVisibility.archivedGroupsKey) private var archivedGroups = "[]"

    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    /// In the web interface related actions fold into a flyout so the menu stays short; `.mac` keeps them flat.
    @ViewBuilder
    private func projectGroup<C: View>(_ title: LocalizedStringKey, symbol: String, @ViewBuilder _ content: @escaping () -> C) -> some View {
        if metrics.isWebInterface { WebSubmenu(title, symbol: symbol, content: content) } else { content() }
    }

    var body: some View {
        let doc = actions.workspace.document
        if metrics.isWebInterface {
            SidebarMenuButton("sidebar.web.openIndividually", symbol: "folder") {
                actions.workspace.update { $0.openWebProject(project.id) }
                environment.showingHome = false
            }
            SidebarMenuButton("sidebar.web.addToCurrent", symbol: "plus") {
                actions.workspace.update { $0.addWebProject(project.id) }
                environment.showingHome = false
            }
            WebMenuDivider()
        }
        if metrics.isWebInterface {
            SidebarMenuButton("terminal.new", symbol: "plus") { environment.editorRequest = .newTerminal(project.id) }
                .accessibilityIdentifier("terminal.new")
        } else { NewTerminalButton(project: project) }
        WebMenuDivider()
        SidebarMenuButton("sidebar.rename", symbol: "pencil") {
            SidebarRenamePrompt.name(initial: project.name, width: metrics.size(280), height: metrics.size(24)) { name in
                actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "sidebar.rename")) {
                    $0.updateProject(project.id) { $0.name = name }
                }
            }
        }
        SidebarMenuButton("sidebar.editProject", symbol: "slider.horizontal.3") { environment.editorRequest = .editProject(project.id) }
        projectGroup("sidebar.web.group.openIn", symbol: "arrow.up.forward.app") {
            SidebarMenuButton("sidebar.revealInFinder", symbol: "folder") { actions.revealInFinder(project) }
            SidebarMenuButton("openIn.vscode", symbol: "chevron.left.forwardslash.chevron.right") { OpenInActions.vsCode(project.folder, launchers: environment.launchers) }
                .accessibilityIdentifier("openIn.vscode")
            if metrics.isWebInterface, environment.features.isOn(.browser) {
                SidebarMenuButton("menu.addBrowser", symbol: "globe") { environment.editorRequest = .addBrowser(project.id) }
            }
            SidebarMenuButton("openIn.browser", symbol: "globe") { OpenInActions.browser(project) }
                .accessibilityIdentifier("openIn.browser")
        }
        projectGroup("sidebar.web.group.layout", symbol: "rectangle.split.2x2") {
            SidebarMenuButton("sidebar.designLayout", symbol: "rectangle.split.2x2") { environment.editorRequest = .layoutDesigner(.project(project.id)) }
            WebSubmenu("sidebar.grids") {
                SidebarMenuButton("projectGrid.main", symbol: "square.grid.2x2") { actions.workspace.update { $0.activateGrid(nil, in: project.id) } }
                ForEach(project.namedGrids) { grid in
                    Button { actions.workspace.update { $0.activateGrid(grid.id, in: project.id) } } label: { Text(verbatim: grid.name) }
                }
                WebMenuDivider()
                SidebarMenuButton("projectGrid.newEllipsis", symbol: "plus") {
                    ProjectGridPrompts.createGrid(in: project.id, workspace: actions.workspace, undoManager: actions.undoManager)
                }
            }
        }
        projectGroup("sidebar.web.group.git", symbol: "arrow.triangle.branch") {
            if environment.hasPluginCommand(GitControlPlugin.openCommandID) {
                SidebarMenuButton("menu.git.control", symbol: "arrow.triangle.branch") { environment.openPluginSheet(GitControlPlugin.sheetID, project: project.id) }
            }
            SidebarMenuButton("menu.merge.center", symbol: "arrow.triangle.merge") { environment.editorRequest = .mergeCenter(project.id) }
            SidebarMenuButton("worktrees.manageEllipsis", symbol: "arrow.triangle.branch") { environment.editorRequest = .worktrees(project.id) }
            SidebarMenuButton("menu.merge.branchTesting", symbol: "testtube.2") { environment.editorRequest = .branchTesting(project.id) }
        }
        projectGroup("sidebar.web.group.content", symbol: "books.vertical") {
            SidebarMenuButton("menu.history.conversations", symbol: "clock") { environment.editorRequest = .conversations(project.id) }
            SidebarMenuButton("agentLibrary.openEllipsis", symbol: "books.vertical") { environment.editorRequest = .agentLibrary(project.id) }
            if environment.features.isOn(.graphify) {
                SidebarMenuButton("graphify.openInProject", symbol: "point.3.connected.trianglepath.dotted") {
                    environment.open(.graphify, in: project.id, actionName: String(localized: "undo.addContent"))
                }
                .accessibilityIdentifier("graphify.openInProject")
            }
            if environment.features.isOn(.orchestrator) {
                // Upstream `menu.addOrchestrator` always adds a board, like Add Content.
                SidebarMenuButton("orchestrator.addToProject", symbol: "rectangle.3.group") {
                    actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "undo.addContent")) {
                        $0.addPane(to: project.id, content: .orchestrator)
                    }
                }
                .accessibilityIdentifier("orchestrator.addToProject")
            }
        }
        projectGroup("sidebar.web.group.settings", symbol: "slider.horizontal.3") {
            SidebarMenuButton("projectSettings.exportEllipsis", symbol: metrics.isWebInterface ? "arrow.down.to.line" : "square.and.arrow.up") {
                if metrics.isWebInterface {
                    WebProjectTransfer.export(project, group: doc.groups.first { $0.projectIDs.contains(project.id) }?.id)
                } else { ProjectSettingsTransfer.export(project) }
            }
            SidebarMenuButton("projectSettings.importEllipsis", symbol: metrics.isWebInterface ? "arrow.up.to.line" : "square.and.arrow.down") {
                if metrics.isWebInterface {
                    WebProjectTransfer.importProject(nextTo: project.id, workspace: actions.workspace, undoManager: actions.undoManager)
                } else {
                    ProjectSettingsTransfer.importSettings(into: project.id, workspace: actions.workspace, undoManager: actions.undoManager)
                }
            }
            WebSubmenu("sidebar.moveToGroup") {
                SidebarMenuButton("sidebar.ungrouped", symbol: "folder") { actions.move(project.id, to: .ungrouped) }
                    .disabled(doc.location(of: project.id) == .ungrouped)
                if !doc.groups.isEmpty { WebMenuDivider() }
                ForEach(doc.groups) { group in
                    Button { actions.move(project.id, to: .group(group.id)) } label: { Text(verbatim: group.name) }
                        .disabled(doc.location(of: project.id) == .group(group.id))
                }
            }
        }
        WebMenuDivider()
        if metrics.isWebInterface {
            SidebarMenuButton("sidebar.web.archiveProject", symbol: "archivebox") {
                actions.workspace.update { $0.updateProject(project.id) { $0.archived = true } }
            }
            let hidden = project.hidden == true
            SidebarMenuButton(hidden ? "sidebar.web.unhideProject" : "sidebar.web.hideProject",
                              symbol: hidden ? "eye" : "eye.slash") {
                actions.workspace.update { $0.updateProject(project.id) { $0.hidden = !hidden } }
            }
        }
        if doc.isProjectDisabled(project.id) {
            SidebarMenuButton("sidebar.enableProject", symbol: metrics.isWebInterface ? "power" : "play") { actions.setProjectDisabled(project.id, false) }
        } else {
            SidebarMenuButton("sidebar.disableProject", symbol: metrics.isWebInterface ? "power" : "pause") { actions.setProjectDisabled(project.id, true) }
                .disabled(project.panes.isEmpty)
        }
        WebMenuDivider()
        SidebarMenuButton("sidebar.removeProject", symbol: "trash") { actions.remove(project.id) }
    }
}

private struct TabContextMenu: View {
    let tab: PaneTab
    let project: Project
    let actions: SidebarActions
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webMenu } else { nativeMenu }
    }

    @ViewBuilder private var webMenu: some View {
        if let pane = actions.workspace.document.paneHolding(tab.id)?.pane {
            if !project.namedGrids.isEmpty {
                WebSubmenu("pane.moveToGrid") {
                    Button("projectGrid.main") { move(pane.id, to: nil) }
                    ForEach(project.namedGrids) { grid in
                        Button { move(pane.id, to: grid.id) } label: { Text(verbatim: grid.name) }
                    }
                }
            }
            SidebarMenuButton("terminalInspector.open", symbol: "info.circle") {
                environment.inspectedPaneID = pane.id
            }
            SidebarMenuButton("sidebar.web.revealTerminal", symbol: "rectangle.topthird.inset.filled") {
                environment.inspectedPaneID = pane.id
                reveal(pane.id)
            }
            if environment.terminals.states[tab.id] != nil && !pane.isDisabled {
                SidebarMenuButton("pane.web.restart", symbol: "power") {
                    environment.terminals.restart(tab, in: project, environment: environment)
                }
            }
            SidebarMenuButton("pane.web.openInExplorer", symbol: "folder") {
                OpenInActions.revealInFinder(tab.workingDirectory ?? project.folder)
            }
            SidebarMenuButton("pane.web.openInVscode", symbol: "folder") {
                OpenInActions.vsCode(tab.workingDirectory ?? project.folder, launchers: environment.launchers)
            }
            SidebarMenuButton("pane.web.focusMode", symbol: "rectangle.topthird.inset.filled") {
                reveal(pane.id)
                environment.focusModePaneID = pane.id
            }
            if pane.tabs.count <= 1 {
                Button(pane.isLaneVisible ? LocalizedStringKey("pane.web.hideTabsLane") : "pane.web.showTabsLane") {
                    actions.setLaneVisible(!pane.isLaneVisible, for: pane.id)
                }
            }
            WebMenuDivider()
            Button("sidebar.web.openIndividually") {
                actions.workspace.update { $0.openWebPane(pane.id) }
                environment.showingHome = false
            }
            Button("pane.web.addToCurrent") {
                actions.workspace.update { $0.addWebProject(project.id); $0.focusWebPane(pane.id) }
                environment.showingHome = false
            }
            WebMenuDivider()
            SidebarMenuButton("sidebar.rename", symbol: "pencil") {
                SidebarRenamePrompt.name(initial: environment.terminals.displayName(of: tab),
                    width: metrics.size(280), height: metrics.size(24)) { name in
                    actions.workspace.update { $0.updateTab(tab.id) { $0.title = name.trimmingCharacters(in: .whitespacesAndNewlines) } }
                }
            }
            SidebarMenuButton(pane.isRemoteShared ? "pane.web.hideFromRemote" : "pane.web.shareWithRemote", symbol: "iphone") {
                environment.remoteControl.setShared(pane.id, !pane.isRemoteShared)
            }
            .accessibilityIdentifier("remote.share")
            SidebarMenuButton(pane.isDisabled ? "pane.web.reactivate" : "pane.web.disable", symbol: "power") {
                actions.setTabDisabled(tab.id, !pane.isDisabled)
            }
            SidebarMenuButton("pane.web.killTerminal", symbol: "power") {
                environment.terminals.view(for: tab.id)?.terminate()
            }
            WebMenuDivider()
            SidebarMenuButton("pane.web.deleteTerminal", symbol: "trash", role: .destructive) {
                Task {
                    guard await WebDialogCenter.shared.confirm(
                        format("pane.web.confirmDeleteTerminal", environment.terminals.displayName(of: tab)),
                        confirmTitle: String(localized: "pane.web.deleteTerminal"), destructive: true) else { return }
                    for entry in pane.tabs { actions.closeTab(entry.id) }
                }
            }
        }
    }

    private func reveal(_ pane: PaneID) {
        actions.workspace.update { $0.focusWebPane(pane) }
        environment.showingHome = false
        environment.terminals.markRead(tab.id)
        DispatchQueue.main.async { environment.terminals.view(for: tab.id)?.focus() }
    }

    @ViewBuilder private var nativeMenu: some View {
        if metrics.isWebInterface, let pane = actions.workspace.document.paneHolding(tab.id)?.pane {
            SidebarMenuButton("sidebar.web.revealTerminal", symbol: "rectangle.topthird.inset.filled") {
                actions.workspace.update { $0.focusWebPane(pane.id) }
                environment.showingHome = false
                environment.terminals.markRead(tab.id)
                DispatchQueue.main.async { environment.terminals.view(for: tab.id)?.focus() }
            }
            SidebarMenuButton("sidebar.web.openIndividually", symbol: "folder") {
                actions.workspace.update { $0.openWebPane(pane.id) }
                environment.showingHome = false
            }
            WebMenuDivider()
        }
        SidebarMenuButton("sidebar.rename", symbol: "pencil") {
            SidebarRenamePrompt.name(initial: tab.title ?? "", width: metrics.size(280), height: metrics.size(24)) { name in
                actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "sidebar.rename")) {
                    $0.updateTab(tab.id) { $0.title = name }
                }
            }
        }
        SidebarMenuButton("sidebar.killTerminal", symbol: "stop") { environment.terminals.view(for: tab.id)?.terminate() }
            .disabled(environment.terminals.view(for: tab.id) == nil)
        SidebarMenuButton("terminal.restart", symbol: "arrow.clockwise") { environment.terminals.restart(tab, in: project, environment: environment) }
        SidebarMenuButton("openIn.vscode", symbol: "chevron.left.forwardslash.chevron.right") {
            OpenInActions.vsCode(tab.workingDirectory ?? project.folder, launchers: environment.launchers)
        }
        SidebarMenuButton("sidebar.revealInFinder", symbol: "folder") { OpenInActions.revealInFinder(tab.workingDirectory ?? project.folder) }
        if let pane = actions.workspace.document.paneHolding(tab.id)?.pane {
            SidebarMenuButton(environment.focusModePaneID == pane.id ? LocalizedStringKey("focusMode.exit") : "focusMode.enter", symbol: "arrow.up.left.and.arrow.down.right") {
                if environment.focusModePaneID == pane.id {
                    environment.focusModePaneID = nil
                } else {
                    if metrics.isWebInterface {
                        actions.workspace.update { $0.focusWebPane(pane.id) }
                        environment.showingHome = false
                    } else { actions.select(.tab(tab.id)) }
                    environment.focusModePaneID = pane.id
                }
            }
            if !project.namedGrids.isEmpty {
                WebSubmenu("pane.moveToGrid") {
                    SidebarMenuButton("projectGrid.main", symbol: "square.grid.2x2") { move(pane.id, to: nil) }
                        .disabled(pane.gridID == nil)
                    ForEach(project.namedGrids) { grid in
                        Button { move(pane.id, to: grid.id) } label: { Text(verbatim: grid.name) }
                            .disabled(pane.gridID == grid.id)
                    }
                }
            }
            SidebarMenuButton(pane.isDisabled ? LocalizedStringKey("pane.enable") : "pane.disable", symbol: "power") {
                actions.setTabDisabled(tab.id, !pane.isDisabled)
            }
            WebMenuDivider()
            SidebarMenuButton("subtabs.newEllipsis", symbol: "plus") { environment.editorRequest = .newSubTab(pane.id) }
            SidebarMenuButton(pane.isLaneVisible ? LocalizedStringKey("subtabs.hideLane") : "subtabs.showLane", symbol: "rectangle.split.1x2") {
                actions.setLaneVisible(!pane.isLaneVisible, for: pane.id)
            }
            .disabled(pane.tabs.count > 1)
            if pane.content.isTerminal {
                WebMenuDivider()
                RemoteShareToggle(pane: pane)
            }
        }
        if let agentID = tab.worktreeAgentID {
            WebMenuDivider()
            SidebarMenuButton("worktree.commitEllipsis", symbol: "checkmark") { WorktreeActions.commit(agentID, project: project) }
            SidebarMenuButton("worktree.remove", symbol: "trash") {
                WorktreeActions.remove(agentID, tab: tab.id, project: project, workspace: actions.workspace)
            }
        }
        WebMenuDivider()
        SidebarMenuButton("terminal.close", symbol: "xmark") { actions.closeTab(tab.id) }
    }

    private func move(_ pane: PaneID, to grid: ProjectGridID?) {
        actions.workspace.update(undoManager: actions.undoManager, actionName: String(localized: "undo.move")) {
            $0.movePane(pane, toGrid: grid)
        }
    }
}

@MainActor
private enum SidebarRenamePrompt {
    /// Web `window.prompt("New name:", current)` in the themed dialog; the `.mac` path keeps its alert.
    static func name(initial: String, width: CGFloat, height: CGFloat, apply: @escaping (String) -> Void) {
        guard WebDialogCenter.shared.themed else {
            if let name = name(initial: initial, width: width, height: height) { apply(name) }
            return
        }
        Task {
            guard let answer = await WebDialogCenter.shared.prompt(String(localized: "dialog.newName"), initial: initial)
            else { return }
            let name = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { apply(name) }
        }
    }

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
        Image(systemName: "iphone.radiowaves.left.and.right").webProfileSized(14)
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
        if WebDialogCenter.shared.themed {
            let repo = URL(filePath: project.folder)
            Task {
                guard let info = try? await GitWorktrees().list(repo: repo).first(where: { $0.agentId == agentID }) else {
                    inform(String(localized: "worktree.failed"), text: "")
                    return
                }
                let outcome = await WebDialogCenter.shared.present(width: 520) { finish in
                    WorktreeCommitWebHost(folder: URL(filePath: info.path), branch: info.branch, finish: finish)
                }
                guard case .confirmed(let message) = outcome else { return }
                do {
                    let committed = try await GitWorktrees().commitPending(repo: repo, agentId: agentID, message: message)
                    if !committed { inform(String(localized: "worktree.nothingToCommit"), text: "") }
                } catch {
                    inform(String(localized: "worktree.failed"), text: NewTerminalSheet.describe(error))
                }
            }
            return
        }
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
        if WebDialogCenter.shared.themed {
            Task {
                guard await WebDialogCenter.shared.confirm(
                    String(localized: "worktree.remove.detail"), title: String(localized: "worktree.remove.title"),
                    confirmTitle: String(localized: "worktree.remove"), destructive: true) else { return }
                await removeConfirmed(agentID, tab: tab, project: project, workspace: workspace)
            }
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(localized: "worktree.remove.title")
        alert.informativeText = String(localized: "worktree.remove.detail")
        alert.addButton(withTitle: String(localized: "worktree.remove"))
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await removeConfirmed(agentID, tab: tab, project: project, workspace: workspace) }
    }

    private static func removeConfirmed(_ agentID: String, tab: TabID, project: Project, workspace: WorkspaceModel) async {
        let repo = URL(filePath: project.folder)
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

/// Hosts the pending-commit web modal for the sidebar's "Commit worktree changes…" action.
private struct WorktreeCommitWebHost: View {
    let folder: URL
    let branch: String
    let finish: (WebDialogCenter.Outcome) -> Void
    @State private var message = GitWorktrees.defaultCommitMessage

    var body: some View {
        ConfirmWorktreeCommitWebModal(folder: folder, branch: branch, message: $message) {
            finish(.confirmed(message))
        }
        .environment(\.gitModalClose, { finish(.cancelled) })
    }
}
