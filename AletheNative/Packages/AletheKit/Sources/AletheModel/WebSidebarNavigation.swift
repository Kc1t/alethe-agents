import Foundation

/// Web navigation uses the existing composition source slot for groups and individual panes.
/// No persisted fields or enum cases are added; native navigation keeps its original entry points.
extension WorkspaceTab {
    public var webGroupID: GroupID? {
        guard kind == .composition, let source = projectID?.rawValue,
              source.hasPrefix("web-group:") else { return nil }
        return GroupID(rawValue: String(source.dropFirst("web-group:".count)))
    }

    public var webPaneID: PaneID? {
        guard kind == .composition, let source = projectID?.rawValue,
              source.hasPrefix("web-pane:") else { return nil }
        return PaneID(rawValue: String(source.dropFirst("web-pane:".count)))
    }
}

extension WorkspaceDocument {
    /// Upstream `applyTabNavigation` moves an explicitly opened saved tab to the end of the bar.
    private mutating func navigateWeb(to tab: WorkspaceTab, adding: Bool) {
        navigate(to: tab, adding: adding)
        if adding, let index = workspace.tabs.firstIndex(where: { $0.id == tab.id }) {
            let opened = workspace.tabs.remove(at: index)
            workspace.tabs.append(opened)
        }
    }

    /// `openProjectGrid`: always navigate to the project's own tab, even from a group view.
    public mutating func openWebProject(_ id: ProjectID) {
        guard project(id) != nil else { return }
        if workspace.activeTabID != nil { syncActiveTab() }
        var tab = workspace.tabs.first { $0.kind == .project && $0.projectID == id }
            ?? WorkspaceTab(kind: .project, projectID: id, snapshot: WorkspaceSnapshot())
        tab.snapshot = WorkspaceSnapshot(openProjectIDs: [id], selectedProjectID: id)
        tab.updatedAt = Date()
        navigateWeb(to: tab, adding: true)
    }

    /// `openGroupWorkspace`: only projects with panes participate, in document order, recursively.
    /// Hidden/archived sidebar flags do not filter this action in the web store.
    public mutating func openWebGroup(_ id: GroupID, adding: Bool) {
        guard groups.contains(where: { $0.id == id }) else { return }
        if workspace.activeTabID != nil { syncActiveTab() }
        let members = Set(groups.filter { isGroup($0.id, inside: id) }.flatMap(\.projectIDs))
        let openable = projects.filter { members.contains($0.id) && !$0.panes.isEmpty }.map(\.id)
        if adding, let active = workspace.activeTabID,
           let index = workspace.tabs.firstIndex(where: { $0.id == active }) {
            guard let first = openable.first else { return }
            for project in openable where !workspace.openProjectIDs.contains(project) {
                workspace.openProjectIDs.append(project)
            }
            workspace.containerWeights = []
            workspace.selectedProjectID = first
            workspace.fullscreenProjectID = nil
            workspace.isolatedPaneID = nil
            workspace.flat = false
            workspace.tabs[index].kind = .composition
            workspace.tabs[index].projectID = nil
            syncActiveTab()
            return
        }
        if let tab = workspace.tabs.first(where: { $0.webGroupID == id }) {
            navigateWeb(to: tab, adding: true)
            return
        }
        let snapshot = WorkspaceSnapshot(openProjectIDs: openable, selectedProjectID: openable.first)
        let tab = WorkspaceTab(kind: .composition,
                               projectID: ProjectID(rawValue: "web-group:" + id.rawValue), snapshot: snapshot)
        navigateWeb(to: tab, adding: true)
    }

    /// `focusWorkspaceTerminal`: keep the composition if visible; otherwise open its own grid.
    public mutating func focusWebPane(_ id: PaneID) {
        guard let (project, pane) = pane(id) else { return }
        if !webPaneIsVisible(id) {
            updateProject(project.id) { $0.activeGridID = pane.gridID }
            openWebProject(project.id)
        }
        workspace.selectedProjectID = project.id
        workspace.focusedPaneID = id
        syncActiveTab()
    }

    /// `openTerminalWorkspace`: a separate, reusable tab displaying only this pane.
    public mutating func openWebPane(_ id: PaneID) {
        guard let (project, _) = pane(id) else { return }
        if workspace.activeTabID != nil { syncActiveTab() }
        if let tab = workspace.tabs.first(where: { $0.webPaneID == id }) {
            navigateWeb(to: tab, adding: false)
            return
        }
        let snapshot = WorkspaceSnapshot(openProjectIDs: [project.id], focusedPaneID: id,
                                         selectedProjectID: project.id,
                                         fullscreenProjectID: project.id, isolatedPaneID: id)
        let tab = WorkspaceTab(kind: .composition,
                               projectID: ProjectID(rawValue: "web-pane:" + id.rawValue), snapshot: snapshot)
        navigateWeb(to: tab, adding: true)
    }

    public func webPaneIsVisible(_ id: PaneID) -> Bool {
        guard let (project, _) = pane(id), workspace.openProjectIDs.contains(project.id) else { return false }
        if let isolated = activeWorkspaceTab?.webPaneID { return isolated == id }
        return project.visiblePanes.contains { $0.id == id }
    }

    /// `addProjectToWorkspace`: append explicitly, never through an Option-click shortcut.
    public mutating func addWebProject(_ id: ProjectID) {
        guard project(id) != nil else { return }
        guard workspace.activeTabID != nil else { openWebProject(id); return }
        open(id)
        if let index = workspace.tabs.firstIndex(where: { $0.id == workspace.activeTabID }) {
            workspace.tabs[index].kind = .composition
            workspace.tabs[index].projectID = nil
        }
        workspace.flat = false
        workspace.fullscreenProjectID = nil
        workspace.isolatedPaneID = nil
        workspace.focusedPaneID = nil
        syncActiveTab()
    }

    /// `moveTerminal`: preserve the pane and its sessions when moving between projects.
    public mutating func moveWebPane(_ id: PaneID, to target: ProjectID) {
        guard let (source, original) = pane(id), source.id != target, project(target) != nil else { return }
        var moved = original
        moved.gridID = project(target)?.shownGridID
        updateProject(source.id) {
            $0.panes.removeAll { $0.id == id }
            $0.gridLayout?.cells.removeValue(forKey: id.rawValue)
            if var grids = $0.grids {
                for index in grids.indices { grids[index].gridLayout?.cells.removeValue(forKey: id.rawValue) }
                $0.grids = grids
            }
        }
        updateProject(target) { $0.panes.append(moved) }
        if self.project(source.id)?.visiblePanes.isEmpty == true { close(source.id) }
        syncActiveTab()
    }
}
