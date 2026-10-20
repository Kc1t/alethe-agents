import Foundation

/// Where a project sits in the sidebar: in a group, or ungrouped.
public enum ProjectLocation: Hashable, Sendable {
    case ungrouped
    case group(GroupID)
}

/// Mutations of the workspace document. Pure (no I/O) so every rule is unit-tested; the store applies
/// them and schedules the save. Invariant kept by every operation: each project id appears exactly
/// once, either in one group's `projectIDs` or in `ungroupedProjectIDs`.
extension WorkspaceDocument {
    // MARK: - Lookup

    public func project(_ id: ProjectID) -> Project? {
        projects.first { $0.id == id }
    }

    public func group(_ id: GroupID) -> ProjectGroup? {
        groups.first { $0.id == id }
    }

    public func location(of project: ProjectID) -> ProjectLocation? {
        if ungroupedProjectIDs.contains(project) { return .ungrouped }
        return groups.first { $0.projectIDs.contains(project) }.map { .group($0.id) }
    }

    /// Child groups of `parent` (nil: top level), in sibling order.
    public func childGroups(of parent: GroupID?) -> [ProjectGroup] {
        groups.filter { $0.parentID == parent }
    }

    /// `ancestor` itself or any group above `group`.
    public func isGroup(_ group: GroupID, inside ancestor: GroupID) -> Bool {
        var current: GroupID? = group
        var visited = Set<GroupID>()
        while let id = current, visited.insert(id).inserted {
            if id == ancestor { return true }
            current = self.group(id)?.parentID
        }
        return false
    }

    public func pane(_ id: PaneID) -> (project: Project, pane: Pane)? {
        for project in projects {
            if let pane = project.panes.first(where: { $0.id == id }) { return (project, pane) }
        }
        return nil
    }

    // MARK: - Groups

    @discardableResult
    public mutating func addGroup(name: String, color: ProjectColor? = nil, parent: GroupID? = nil) -> GroupID {
        let group = ProjectGroup(name: name, color: color, parentID: parent.flatMap { self.group($0)?.id })
        groups.append(group)
        return group.id
    }

    public mutating func updateGroup(_ id: GroupID, _ body: (inout ProjectGroup) -> Void) {
        guard let index = groups.firstIndex(where: { $0.id == id }) else { return }
        let parent = groups[index].parentID
        body(&groups[index])
        groups[index].id = id
        groups[index].parentID = parent
    }

    /// Deletes a group; its projects and child groups move up to its parent (or the top level).
    public mutating func deleteGroup(_ id: GroupID) {
        guard let removed = group(id) else { return }
        let formerChildren = sidebarChildren(of: id)
        if let parent = removed.parentID, let index = groups.firstIndex(where: { $0.id == parent }),
           let tokens = groups[index].childOrder {
            groups[index].childOrder = tokens.flatMap { token in
                token == SidebarChild.group(id).orderToken ? formerChildren.map(\.orderToken) : [token]
            }
        }
        for index in groups.indices where groups[index].parentID == id {
            groups[index].parentID = removed.parentID
        }
        if let parent = removed.parentID, let parentIndex = groups.firstIndex(where: { $0.id == parent }) {
            groups[parentIndex].projectIDs.append(contentsOf: removed.projectIDs)
        } else {
            ungroupedProjectIDs.append(contentsOf: removed.projectIDs)
        }
        groups.removeAll { $0.id == id }
        if let parent = removed.parentID { normalizeSidebarChildOrder(of: parent) }
    }

    /// Removes the entire group subtree and its projects through the normal cleanup path.
    public mutating func deleteGroupAndProjects(_ id: GroupID) {
        let subtree = groups.filter { isGroup($0.id, inside: id) }
        for project in subtree.flatMap(\.projectIDs) { removeProject(project) }
        let ids = Set(subtree.map(\.id))
        groups.removeAll { ids.contains($0.id) }
    }

    /// Moves a group under `parent` (nil: top level) at `index` among its new siblings. Moving a group
    /// into itself or into one of its descendants is ignored.
    public mutating func moveGroup(_ id: GroupID, toParent parent: GroupID?, at index: Int) {
        guard var moving = group(id) else { return }
        if let parent, isGroup(parent, inside: id) { return }
        if let parent, group(parent) == nil { return }
        groups.removeAll { $0.id == id }
        moving.parentID = parent
        let siblings = groups.enumerated().filter { $0.element.parentID == parent }.map(\.offset)
        let clamped = max(0, min(index, siblings.count))
        let insertAt = clamped < siblings.count ? siblings[clamped] : (siblings.last.map { $0 + 1 } ?? groups.count)
        groups.insert(moving, at: insertAt)
    }

    // MARK: - Projects

    @discardableResult
    public mutating func addProject(name: String, folder: String, color: ProjectColor = .blue,
                                    in location: ProjectLocation = .ungrouped) -> ProjectID {
        let project = Project(name: name, color: color, folder: folder)
        projects.append(project)
        insert(project.id, into: location, at: Int.max)
        return project.id
    }

    public mutating func updateProject(_ id: ProjectID, _ body: (inout Project) -> Void) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        body(&projects[index])
        projects[index].id = id
    }

    public mutating func removeProject(_ id: ProjectID) {
        detach(id)
        projects.removeAll { $0.id == id }
        forgetContainer(id)
        workspace.openProjectIDs.removeAll { $0 == id }
        workspace.gridWeights = workspace.gridWeights.filter { $0.key != id.rawValue && !$0.key.hasPrefix(id.rawValue + ":") }
        if workspace.selectedProjectID == id { workspace.selectedProjectID = nil }
        normalizeContainerWeights()
        repairNavigation()
    }

    /// Moves a project to `location` at `index` (clamped). Moving within the same list accounts for
    /// the removal, so dropping an item "after itself" is a no-op.
    public mutating func moveProject(_ id: ProjectID, to location: ProjectLocation, at index: Int) {
        guard project(id) != nil else { return }
        if case .group(let group) = location, self.group(group) == nil { return }
        let source = self.location(of: id)
        var target = index
        if source == location, let current = ids(in: location).firstIndex(of: id), current < index {
            target -= 1
        }
        detach(id)
        insert(id, into: location, at: target)
    }

    // MARK: - Panes and tabs

    /// Adds a pane with one tab to a project and opens/focuses it.
    @discardableResult
    public mutating func addPane(to projectID: ProjectID, tab: PaneTab) -> PaneID? {
        guard let project = project(projectID) else { return nil }
        var pane = Pane(tabs: [tab])
        pane.gridID = project.shownGridID
        updateProject(projectID) { $0.panes.append(pane) }
        workspace.gridWeights.removeValue(forKey: project.weightsKey)
        open(projectID)
        workspace.focusedPaneID = pane.id
        return pane.id
    }

    /// Adds a pane showing a file or page (not a terminal) and opens/focuses it.
    @discardableResult
    public mutating func addPane(to projectID: ProjectID, content: PaneContent) -> PaneID? {
        guard !content.isTerminal, let project = project(projectID) else { return nil }
        var pane = Pane(content: content)
        pane.gridID = project.shownGridID
        updateProject(projectID) { $0.panes.append(pane) }
        workspace.gridWeights.removeValue(forKey: project.weightsKey)
        open(projectID)
        workspace.focusedPaneID = pane.id
        return pane.id
    }

    public mutating func closePane(_ paneID: PaneID) {
        guard let (project, _) = pane(paneID) else { return }
        if workspace.isolatedPaneID == paneID { workspace.isolatedPaneID = nil }
        updateProject(project.id) { $0.panes.removeAll { $0.id == paneID }; $0.reconcilePaneGroups() }
        workspace.gridWeights.removeValue(forKey: project.weightsKey)
        if workspace.focusedPaneID == paneID {
            workspace.focusedPaneID = self.project(project.id)?.visiblePanes.last?.id
        }
    }

    /// The pane holding a tab.
    public func paneHolding(_ tabID: TabID) -> (project: Project, pane: Pane)? {
        for project in projects {
            if let pane = project.panes.first(where: { $0.tabs.contains { $0.id == tabID } }) { return (project, pane) }
        }
        return nil
    }

    /// Removes a tab; a pane left without tabs is closed. Closing the active tab shows the next one,
    /// or the previous one when it was last (upstream `closeSubTab`).
    public mutating func closeTab(_ tabID: TabID) {
        guard let (_, pane) = paneHolding(tabID) else { return }
        if pane.tabs.count == 1 { return closePane(pane.id) }
        updatePane(pane.id) { pane in
            guard let index = pane.tabs.firstIndex(where: { $0.id == tabID }) else { return }
            let wasActive = pane.activeTab?.id == tabID
            pane.tabs.remove(at: index)
            if wasActive { pane.activeTabID = pane.tabs[min(index, pane.tabs.count - 1)].id }
        }
    }

    /// Adds a sub-tab to a pane, shows it and focuses the pane.
    @discardableResult
    public mutating func addTab(_ tab: PaneTab, to paneID: PaneID) -> Bool {
        guard let (project, pane) = pane(paneID), pane.content.isTerminal else { return false }
        reveal(paneID)
        updatePane(paneID) { pane in
            pane.tabs.append(tab)
            pane.activeTabID = tab.id
        }
        open(project.id)
        workspace.focusedPaneID = paneID
        return true
    }

    /// Shows a sub-tab in its pane and focuses the pane.
    public mutating func activateTab(_ tabID: TabID) {
        guard let (project, pane) = paneHolding(tabID) else { return }
        reveal(pane.id)
        if pane.activeTab?.id != tabID { updatePane(pane.id) { $0.activeTabID = tabID } }
        workspace.focusedPaneID = pane.id
        workspace.selectedProjectID = project.id
    }

    /// The tab `offset` places after the active one, wrapping around.
    public func tab(_ offset: Int, from paneID: PaneID) -> TabID? {
        guard let (_, pane) = pane(paneID), !pane.tabs.isEmpty else { return nil }
        let current = pane.tabs.firstIndex { $0.id == pane.activeTab?.id } ?? 0
        let count = pane.tabs.count
        return pane.tabs[((current + offset) % count + count) % count].id
    }

    public mutating func setLaneVisible(_ visible: Bool, for paneID: PaneID) {
        updatePane(paneID) { $0.laneVisible = visible ? true : nil }
    }

    public mutating func updatePane(_ paneID: PaneID, _ body: (inout Pane) -> Void) {
        for p in projects.indices {
            if let q = projects[p].panes.firstIndex(where: { $0.id == paneID }) {
                body(&projects[p].panes[q])
                projects[p].panes[q].id = paneID
                return
            }
        }
    }

    /// Swaps two panes of the same project (drag-to-reorder).
    public mutating func swapPanes(_ first: PaneID, _ second: PaneID) {
        guard let (project, _) = pane(first), pane(second)?.project.id == project.id else { return }
        updateProject(project.id) { project in
            guard let a = project.panes.firstIndex(where: { $0.id == first }),
                  let b = project.panes.firstIndex(where: { $0.id == second }) else { return }
            project.panes.swapAt(a, b)
        }
    }

    public mutating func updateTab(_ tabID: TabID, _ body: (inout PaneTab) -> Void) {
        for p in projects.indices {
            for q in projects[p].panes.indices {
                if let t = projects[p].panes[q].tabs.firstIndex(where: { $0.id == tabID }) {
                    body(&projects[p].panes[q].tabs[t])
                    projects[p].panes[q].tabs[t].id = tabID
                    return
                }
            }
        }
    }

    // MARK: - Workspace

    /// Shows a project as a container (appended to the right) and selects it.
    public mutating func open(_ id: ProjectID) {
        guard project(id) != nil else { return }
        if !workspace.openProjectIDs.contains(id) {
            workspace.openProjectIDs.append(id)
            normalizeContainerWeights()
        }
        workspace.selectedProjectID = id
    }

    public mutating func close(_ id: ProjectID) {
        forgetContainer(id)
        workspace.openProjectIDs.removeAll { $0 == id }
        normalizeContainerWeights()
        if workspace.selectedProjectID == id { workspace.selectedProjectID = workspace.openProjectIDs.last }
    }

    /// Drops stale references (deleted projects/panes) — run after loading or importing.
    public mutating func repair() {
        let known = Set(projects.map(\.id))
        var seen = Set<ProjectID>()
        for index in groups.indices {
            groups[index].projectIDs = groups[index].projectIDs.filter { known.contains($0) && seen.insert($0).inserted }
        }
        ungroupedProjectIDs = ungroupedProjectIDs.filter { known.contains($0) && seen.insert($0).inserted }
        ungroupedProjectIDs.append(contentsOf: projects.map(\.id).filter { !seen.contains($0) })
        let groupIDs = Set(groups.map(\.id))
        for index in groups.indices where groups[index].parentID.map({ !groupIDs.contains($0) }) ?? false {
            groups[index].parentID = nil
        }
        workspace.openProjectIDs = workspace.openProjectIDs.filter { known.contains($0) }
        if let selected = workspace.selectedProjectID, !known.contains(selected) { workspace.selectedProjectID = nil }
        if let focused = workspace.focusedPaneID, pane(focused) == nil { workspace.focusedPaneID = nil }
        let open = Set(workspace.openProjectIDs)
        workspace.collapsedProjectIDs = workspace.collapsedProjectIDs.filter { open.contains($0) }
        if let fullscreen = workspace.fullscreenProjectID, !open.contains(fullscreen) { workspace.fullscreenProjectID = nil }
        if let isolated = workspace.isolatedPaneID,
           pane(isolated)?.project.id != workspace.fullscreenProjectID || workspace.fullscreenProjectID == nil {
            workspace.isolatedPaneID = nil
        }
        normalizeContainerWeights()
        repairNavigation()
        syncActiveTab()
    }

    // MARK: - Containers

    /// Changes how a project arranges its panes; custom track sizes belong to one mode, so they reset.
    public mutating func setLayoutMode(_ mode: PaneLayoutMode, for id: ProjectID) {
        guard let project = project(id), project.layout != mode else { return }
        updateProject(id) { $0.activeArrangement.layoutMode = mode == .auto ? nil : mode }
        workspace.gridWeights.removeValue(forKey: project.weightsKey)
    }

    /// Moves an open container to `index` among the open ones; its width moves with it.
    public mutating func moveContainer(_ id: ProjectID, to index: Int) {
        guard let from = workspace.openProjectIDs.firstIndex(of: id) else { return }
        let to = max(0, min(index, workspace.openProjectIDs.count - 1))
        guard from != to else { return }
        workspace.openProjectIDs.insert(workspace.openProjectIDs.remove(at: from), at: to)
        if workspace.containerWeights.count == workspace.openProjectIDs.count {
            workspace.containerWeights.insert(workspace.containerWeights.remove(at: from), at: to)
        }
    }

    public mutating func setCollapsed(_ id: ProjectID, _ collapsed: Bool) {
        workspace.collapsedProjectIDs.removeAll { $0 == id }
        guard collapsed, workspace.openProjectIDs.contains(id) else { return }
        workspace.collapsedProjectIDs.append(id)
        if workspace.fullscreenProjectID == id {
            workspace.fullscreenProjectID = nil
            workspace.isolatedPaneID = nil
        }
    }

    /// Shows one container alone (nil: all again).
    public mutating func setFullscreen(_ id: ProjectID?) {
        workspace.isolatedPaneID = nil
        guard let id, workspace.openProjectIDs.contains(id) else {
            workspace.fullscreenProjectID = nil
            return
        }
        workspace.fullscreenProjectID = id
        workspace.collapsedProjectIDs.removeAll { $0 == id }
        workspace.selectedProjectID = id
    }

    /// Shows one pane alone, its container alone too (nil: everything again).
    public mutating func isolate(_ paneID: PaneID?) {
        guard let paneID, let (project, _) = pane(paneID) else {
            workspace.isolatedPaneID = nil
            workspace.fullscreenProjectID = nil
            return
        }
        reveal(paneID)
        open(project.id)
        setFullscreen(project.id)
        workspace.isolatedPaneID = paneID
        workspace.focusedPaneID = paneID
    }

    private mutating func forgetContainer(_ id: ProjectID) {
        workspace.collapsedProjectIDs.removeAll { $0 == id }
        if workspace.fullscreenProjectID == id {
            workspace.fullscreenProjectID = nil
            workspace.isolatedPaneID = nil
        }
    }

    // MARK: - Helpers

    private func ids(in location: ProjectLocation) -> [ProjectID] {
        switch location {
        case .ungrouped: ungroupedProjectIDs
        case .group(let id): group(id)?.projectIDs ?? []
        }
    }

    private mutating func detach(_ id: ProjectID) {
        ungroupedProjectIDs.removeAll { $0 == id }
        for index in groups.indices { groups[index].projectIDs.removeAll { $0 == id } }
    }

    private mutating func insert(_ id: ProjectID, into location: ProjectLocation, at index: Int) {
        switch location {
        case .ungrouped:
            ungroupedProjectIDs.insert(id, at: max(0, min(index, ungroupedProjectIDs.count)))
        case .group(let groupID):
            guard let g = groups.firstIndex(where: { $0.id == groupID }) else {
                ungroupedProjectIDs.append(id)
                return
            }
            groups[g].projectIDs.insert(id, at: max(0, min(index, groups[g].projectIDs.count)))
        }
    }

    private mutating func normalizeContainerWeights() {
        if workspace.containerWeights.count != workspace.openProjectIDs.count {
            workspace.containerWeights = []
        }
    }
}
