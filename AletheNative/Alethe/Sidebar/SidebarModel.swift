import AletheModel
import AppKit
import Foundation
import UniformTypeIdentifiers

/// A row the sidebar can select.
enum SidebarItem: Hashable {
    case group(GroupID)
    case project(ProjectID)
    case tab(TabID)
}

/// What a sidebar drag carries: a prefixed id as plain text (kept in-app; no custom UTType needed).
enum SidebarDrag {
    static let projectPrefix = "alethe-project:"
    static let groupPrefix = "alethe-group:"
    static let panePrefix = "alethe-pane:"
    static let projectType = UTType(exportedAs: "com.kc1t.alethe.sidebar-project")
    static let groupType = UTType(exportedAs: "com.kc1t.alethe.sidebar-group")
    static var webTypes: [UTType] { [projectType, groupType, paneType, .fileURL] }

    static func provider(_ payload: String) -> NSItemProvider {
        let type = payload.hasPrefix(projectPrefix) ? projectType : payload.hasPrefix(groupPrefix) ? groupType : paneType
        let provider = NSItemProvider()
        provider.suggestedName = payload
        let data = Data(payload.utf8)
        provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .ownProcess) { completion in
            completion(data, nil)
            return nil
        }
        return provider
    }

    static let paneType = UTType(exportedAs: "com.kc1t.alethe.sidebar-pane")
    static func payload(_ pane: PaneID) -> String { panePrefix + pane.rawValue }

    static func payload(_ project: ProjectID) -> String { projectPrefix + project.rawValue }
    static func payload(_ group: GroupID) -> String { groupPrefix + group.rawValue }

    typealias Dropped = SidebarDragPayload

    /// Reads dragged sidebar payloads and hands each one to `apply` on the main actor.
    static func load(_ providers: [NSItemProvider], apply: @escaping @MainActor (Dropped) -> Void) {
        for provider in providers {
            if let type = [projectType, groupType, paneType].first(where: {
                provider.hasItemConformingToTypeIdentifier($0.identifier)
            }) {
                provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                    guard let data, let text = String(data: data, encoding: .utf8), let dropped = parse(text) else { return }
                    Task { @MainActor in apply(dropped) }
                }
                continue
            }
            guard provider.canLoadObject(ofClass: NSString.self) else { continue }
            _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                guard let text = object as? String, let dropped = parse(text) else { return }
                Task { @MainActor in apply(dropped) }
            }
        }
    }

    static func parse(_ text: String) -> Dropped? {
        if text.hasPrefix(panePrefix) { return .pane(PaneID(rawValue: String(text.dropFirst(panePrefix.count)))) }
        if text.hasPrefix(projectPrefix) { return .project(ProjectID(rawValue: String(text.dropFirst(projectPrefix.count)))) }
        if text.hasPrefix(groupPrefix) { return .group(GroupID(rawValue: String(text.dropFirst(groupPrefix.count)))) }
        return nil
    }
}

/// Sidebar actions that touch the workspace document (undoable) or the system.
@MainActor
struct SidebarActions {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?

    /// Adds each folder as a project (skipping folders already added); returns the new ids.
    @discardableResult
    func addProjects(folders: [URL], in location: ProjectLocation = .ungrouped) -> [ProjectID] {
        let known = Set(workspace.document.projects.map { URL(filePath: $0.folder).standardizedFileURL.path })
        let folders = folders.filter { url in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
                && !known.contains(url.standardizedFileURL.path)
        }
        guard !folders.isEmpty else { return [] }
        var added: [ProjectID] = []
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addProject")) { doc in
            for url in folders {
                let id = doc.addProject(
                    name: url.lastPathComponent,
                    folder: url.standardizedFileURL.path,
                    color: ProjectColor.next(after: doc.projects.count),
                    in: location
                )
                added.append(id)
            }
            if let first = added.first { doc.open(first) }
        }
        return added
    }

    func chooseFolders() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = String(localized: "sidebar.addProject.prompt")
        guard panel.runModal() == .OK else { return }
        addProjects(folders: panel.urls)
    }

    func drop(_ dropped: SidebarDrag.Dropped, onGroup target: GroupID) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) { doc in
            switch dropped {
            case .project(let project):
                doc.moveProject(project, to: .group(target), at: Int.max)
            case .pane:
                break
            case .group(let group):
                doc.moveGroup(group, toParent: target, at: Int.max)
            }
        }
    }

    /// A drop between rows of a list: projects are inserted at `index` of that list; groups dropped
    /// between projects land inside the list's group.
    func insert(_ dropped: SidebarDrag.Dropped, into location: ProjectLocation, at index: Int) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) { doc in
            switch dropped {
            case .project(let project):
                doc.moveProject(project, to: location, at: index)
            case .pane:
                break
            case .group(let group):
                if case .group(let parent) = location { doc.moveGroup(group, toParent: parent, at: Int.max) }
            }
        }
    }

    /// Reordering inside one list (the outline view's own drag).
    func reorder(in location: ProjectLocation, from source: IndexSet, to destination: Int, visibleIDs: [ProjectID]? = nil) {
        let ids = location == .ungrouped
            ? workspace.document.ungroupedProjectIDs
            : (workspace.document.groups.first { .group($0.id) == location }?.projectIDs ?? [])
        let visible = visibleIDs ?? ids
        guard let first = source.first, source.count == 1, visible.indices.contains(first) else { return }
        let target = visibleIDs.map { insertionIndex(destination, in: location, visibleIDs: $0) } ?? destination
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) {
            $0.moveProject(visible[first], to: location, at: target)
        }
    }

    /// Translate an insertion among visible rows to the persisted list, including hidden projects.
    func insertionIndex(_ index: Int, in location: ProjectLocation, visibleIDs: [ProjectID]) -> Int {
        let ids = location == .ungrouped
            ? workspace.document.ungroupedProjectIDs
            : (workspace.document.groups.first { .group($0.id) == location }?.projectIDs ?? [])
        guard visibleIDs.indices.contains(index) else { return ids.count }
        return ids.firstIndex(of: visibleIDs[index]) ?? ids.count
    }

    /// A drop between group rows: groups are reordered among the children of `parent`.
    func insertGroup(_ dropped: SidebarDrag.Dropped, under parent: GroupID?, at index: Int) {
        guard case .group(let group) = dropped else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) {
            $0.moveGroup(group, toParent: parent, at: index)
        }
    }

    /// Dropping on a project row places the dragged project before it, in the target's list.
    func drop(_ dropped: SidebarDrag.Dropped, onProject target: ProjectID) {
        if case .pane(let pane) = dropped {
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) {
                $0.moveWebPane(pane, to: target)
            }
            return
        }
        guard case .project(let project) = dropped, project != target,
              let location = workspace.document.location(of: target) else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) { doc in
            let ids = location == .ungrouped ? doc.ungroupedProjectIDs : (doc.groups.first { .group($0.id) == location }?.projectIDs ?? [])
            doc.moveProject(project, to: location, at: ids.firstIndex(of: target) ?? Int.max)
        }
    }

    func move(_ project: ProjectID, to location: ProjectLocation) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) {
            $0.moveProject(project, to: location, at: Int.max)
        }
    }

    func remove(_ project: ProjectID) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.removeProject")) {
            $0.removeProject(project)
        }
    }

    func deleteGroup(_ group: GroupID) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.deleteGroup")) {
            $0.deleteGroup(group)
        }
    }

    func openGroup(_ group: GroupID, adding: Bool, web: Bool = false) {
        if web {
            workspace.update { $0.openWebGroup(group, adding: adding) }
            return
        }
        workspace.update { doc in
            let projects = doc.groups.filter { doc.isGroup($0.id, inside: group) }.flatMap(\.projectIDs)
            guard let first = projects.first else { return }
            if !adding {
                doc.openInTab(first)
                for id in doc.workspace.openProjectIDs where !projects.contains(id) { doc.close(id) }
            }
            for id in projects { doc.open(id) }
        }
    }

    func deleteGroupAndProjects(_ group: ProjectGroup) {
        if WebDialogCenter.shared.themed {
            let count = workspace.document.projectIDs(inGroupTree: group.id).count
            Task {
                guard await WebDialogCenter.shared.confirm(
                    format("dialog.confirmDeleteGroupCascade", group.name, count),
                    confirmTitle: String(localized: "sidebar.deleteGroupAndProjects"), destructive: true) else { return }
                workspace.update(undoManager: undoManager, actionName: String(localized: "sidebar.deleteGroupAndProjects")) {
                    $0.deleteGroupAndProjects(group.id)
                }
            }
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(localized: "sidebar.deleteGroupAndProjects")
        alert.informativeText = String(localized: "sidebar.deleteGroupAndProjects.detail")
        alert.addButton(withTitle: String(localized: "sidebar.deleteGroupAndProjects"))
        alert.buttons.first?.hasDestructiveAction = true
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "sidebar.deleteGroupAndProjects")) {
            $0.deleteGroupAndProjects(group.id)
        }
    }

    func setProjectDisabled(_ project: ProjectID, _ disabled: Bool) {
        workspace.update(undoManager: undoManager,
                         actionName: String(localized: disabled ? "undo.disableProject" : "undo.enableProject")) {
            $0.setProjectDisabled(project, disabled)
        }
    }

    func setTabDisabled(_ tab: TabID, _ disabled: Bool) {
        guard let pane = workspace.document.paneHolding(tab)?.pane else { return }
        workspace.update(undoManager: undoManager,
                         actionName: String(localized: disabled ? "undo.disableTerminal" : "undo.enableTerminal")) {
            $0.setDisabled(pane.id, disabled)
        }
    }

    /// Suspending asks first: it ends every terminal of the group's projects (upstream
    /// `SuspendGroupModal`).
    func suspendGroup(_ group: ProjectGroup) {
        if WebDialogCenter.shared.themed {
            Task {
                guard await WebDialogCenter.shared.confirm(
                    String(localized: "suspendGroup.message"),
                    title: String(format: String(localized: "suspendGroup.title"), group.name),
                    confirmTitle: String(localized: "suspendGroup.confirm")) else { return }
                workspace.update(undoManager: undoManager, actionName: String(localized: "undo.suspendGroup")) {
                    $0.suspendGroup(group.id)
                }
            }
            return
        }
        let alert = NSAlert()
        alert.messageText = String(format: String(localized: "suspendGroup.title"), group.name)
        alert.informativeText = String(localized: "suspendGroup.message")
        alert.addButton(withTitle: String(localized: "suspendGroup.confirm"))
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.suspendGroup")) {
            $0.suspendGroup(group.id)
        }
    }

    func resumeGroup(_ group: GroupID) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.resumeGroup")) {
            $0.resumeGroup(group)
        }
    }

    func setCollapsed(_ group: GroupID, _ collapsed: Bool) {
        workspace.update { $0.updateGroup(group) { $0.isCollapsed = collapsed } }
    }

    func revealInFinder(_ project: Project) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: project.folder)])
    }

    func closeTab(_ tab: TabID) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.closeTerminal")) {
            $0.closeTab(tab)
        }
    }

    func setLaneVisible(_ visible: Bool, for pane: PaneID) {
        workspace.update { $0.setLaneVisible(visible, for: pane) }
    }

    /// Selecting a project shows it in its own workspace tab; with ⌥ it joins the current tab instead
    /// (upstream `openProjectWorkspace` / `addProjectToWorkspace`).
    func select(_ item: SidebarItem?) {
        let adding = NSEvent.modifierFlags.contains(.option)
        workspace.update { doc in
            func show(_ id: ProjectID) {
                if adding { doc.open(id) } else { doc.openInTab(id) }
            }
            switch item {
            case .project(let id):
                show(id)
            case .tab(let tabID):
                if let project = doc.paneHolding(tabID)?.project {
                    show(project.id)
                    doc.activateTab(tabID)
                }
            case .group, .none:
                break
            }
        }
    }
}
