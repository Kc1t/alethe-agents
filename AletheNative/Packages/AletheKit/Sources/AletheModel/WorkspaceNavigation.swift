import Foundation

public enum WorkspaceTabTag {}
public enum WorkspaceHistoryTag {}

public typealias WorkspaceTabID = Identifier<WorkspaceTabTag>
public typealias WorkspaceHistoryID = Identifier<WorkspaceHistoryTag>

/// What the workspace shows: the part of `WorkspaceState` a workspace tab or a history entry
/// restores (upstream `WorkspaceViewSnapshot`).
public struct WorkspaceSnapshot: Codable, Hashable, Sendable {
    public var openProjectIDs: [ProjectID]
    public var containerWeights: [Double]
    public var focusedPaneID: PaneID?
    public var selectedProjectID: ProjectID?
    public var collapsedProjectIDs: [ProjectID]
    public var fullscreenProjectID: ProjectID?
    public var isolatedPaneID: PaneID?
    /// Flat workspace (P2-21; absent in snapshots saved before it).
    public var flat: Bool

    public init(openProjectIDs: [ProjectID] = [], containerWeights: [Double] = [], focusedPaneID: PaneID? = nil,
                selectedProjectID: ProjectID? = nil, collapsedProjectIDs: [ProjectID] = [],
                fullscreenProjectID: ProjectID? = nil, isolatedPaneID: PaneID? = nil, flat: Bool = false) {
        self.openProjectIDs = openProjectIDs
        self.containerWeights = containerWeights
        self.focusedPaneID = focusedPaneID
        self.selectedProjectID = selectedProjectID
        self.collapsedProjectIDs = collapsedProjectIDs
        self.fullscreenProjectID = fullscreenProjectID
        self.isolatedPaneID = isolatedPaneID
        self.flat = flat
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        openProjectIDs = try container.decode([ProjectID].self, forKey: .openProjectIDs)
        containerWeights = try container.decode([Double].self, forKey: .containerWeights)
        focusedPaneID = try container.decodeIfPresent(PaneID.self, forKey: .focusedPaneID)
        selectedProjectID = try container.decodeIfPresent(ProjectID.self, forKey: .selectedProjectID)
        collapsedProjectIDs = try container.decode([ProjectID].self, forKey: .collapsedProjectIDs)
        fullscreenProjectID = try container.decodeIfPresent(ProjectID.self, forKey: .fullscreenProjectID)
        isolatedPaneID = try container.decodeIfPresent(PaneID.self, forKey: .isolatedPaneID)
        flat = try container.decodeIfPresent(Bool.self, forKey: .flat) ?? false
    }
}

/// A saved workspace view, shown in the tab bar (upstream `WorkspaceTab`). A project tab follows one
/// project; a composition tab is any other mix.
public struct WorkspaceTab: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case project, composition
    }

    public var id: WorkspaceTabID
    public var kind: Kind
    /// The project a project tab follows.
    public var projectID: ProjectID?
    public var pinned: Bool
    public var snapshot: WorkspaceSnapshot
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: WorkspaceTabID = .make(), kind: Kind, projectID: ProjectID? = nil, pinned: Bool = false,
                snapshot: WorkspaceSnapshot, createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id
        self.kind = kind
        self.projectID = projectID
        self.pinned = pinned
        self.snapshot = snapshot
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One step of back/forward navigation (upstream `WorkspaceHistoryEntry`).
public struct WorkspaceHistoryEntry: Codable, Hashable, Sendable, Identifiable {
    public var id: WorkspaceHistoryID
    public var tabID: WorkspaceTabID
    public var snapshot: WorkspaceSnapshot
    public var visitedAt: Date

    public init(id: WorkspaceHistoryID = .make(), tabID: WorkspaceTabID, snapshot: WorkspaceSnapshot,
                visitedAt: Date = Date()) {
        self.id = id
        self.tabID = tabID
        self.snapshot = snapshot
        self.visitedAt = visitedAt
    }
}

/// Workspace tabs and history (upstream `lib/workspaceNavigation.ts` and the navigation slices of
/// `projectsStore.workspaceSlices.ts`). The active tab always mirrors the live view: every change of
/// what is shown is written back to it (`syncActiveTab`).
extension WorkspaceDocument {
    public static let maxWorkspaceTabs = 10
    public static let maxWorkspaceHistory = 50

    // MARK: - Snapshots

    public var currentSnapshot: WorkspaceSnapshot {
        WorkspaceSnapshot(openProjectIDs: workspace.openProjectIDs, containerWeights: workspace.containerWeights,
                          focusedPaneID: workspace.focusedPaneID, selectedProjectID: workspace.selectedProjectID,
                          collapsedProjectIDs: workspace.collapsedProjectIDs,
                          fullscreenProjectID: workspace.fullscreenProjectID, isolatedPaneID: workspace.isolatedPaneID,
                          flat: workspace.flat)
    }

    /// Drops projects and panes that no longer exist (upstream `sanitizeWorkspaceSnapshot`).
    public func sanitized(_ snapshot: WorkspaceSnapshot) -> WorkspaceSnapshot {
        let known = Set(projects.map(\.id))
        var result = snapshot
        result.openProjectIDs = snapshot.openProjectIDs.filter { known.contains($0) }
        if result.openProjectIDs.count != snapshot.openProjectIDs.count { result.containerWeights = [] }
        let open = Set(result.openProjectIDs)
        result.collapsedProjectIDs = snapshot.collapsedProjectIDs.filter { open.contains($0) }
        if let selected = snapshot.selectedProjectID, !open.contains(selected) {
            result.selectedProjectID = result.openProjectIDs.first
        }
        if let focused = snapshot.focusedPaneID, pane(focused).map({ !open.contains($0.project.id) }) ?? true {
            result.focusedPaneID = nil
        }
        if let fullscreen = snapshot.fullscreenProjectID, !open.contains(fullscreen) { result.fullscreenProjectID = nil }
        if let isolated = snapshot.isolatedPaneID,
           result.fullscreenProjectID == nil || pane(isolated)?.project.id != result.fullscreenProjectID {
            result.isolatedPaneID = nil
        }
        return result
    }

    /// Shows a snapshot (sanitized first).
    public mutating func apply(_ snapshot: WorkspaceSnapshot) {
        let clean = sanitized(snapshot)
        workspace.openProjectIDs = clean.openProjectIDs
        workspace.containerWeights = clean.containerWeights
        workspace.focusedPaneID = clean.focusedPaneID
        workspace.selectedProjectID = clean.selectedProjectID
        workspace.collapsedProjectIDs = clean.collapsedProjectIDs
        workspace.fullscreenProjectID = clean.fullscreenProjectID
        workspace.isolatedPaneID = clean.isolatedPaneID
        workspace.flat = clean.flat
    }

    // MARK: - Labels

    /// The tab's title: its project's name, or the composition's first project plus how many more
    /// (upstream `compositionLabel`). Nil for an empty view.
    public func label(of tab: WorkspaceTab) -> (name: String, more: Int)? {
        if let group = tab.webGroupID.flatMap({ id in groups.first { $0.id == id } }) { return (group.name, 0) }
        if let pane = tab.webPaneID.flatMap(pane)?.pane {
            return (pane.activeTab?.title ?? pane.activeTab?.agent ?? "", 0)
        }
        if tab.kind == .project, let project = tab.projectID.flatMap(project) { return (project.name, 0) }
        let names = tab.snapshot.openProjectIDs.compactMap { project($0)?.name }
        guard let first = names.first else { return nil }
        return (first, names.count - 1)
    }

    /// The color of a tab: its project's, or the first open project's.
    public func color(of tab: WorkspaceTab) -> ProjectColor? {
        if let id = tab.webGroupID { return groups.first { $0.id == id }?.color }
        return (tab.kind == .project ? tab.projectID : tab.snapshot.openProjectIDs.first).flatMap(project)?.color
    }

    public var activeWorkspaceTab: WorkspaceTab? {
        workspace.activeTabID.flatMap { id in workspace.tabs.first { $0.id == id } }
    }

    // MARK: - Navigation

    /// Opens a project in its own tab (reusing the tab that already follows it), showing only that
    /// project (upstream `openProjectWorkspace`). A project already shown in the view is only
    /// selected.
    public mutating func openInTab(_ id: ProjectID) {
        guard project(id) != nil else { return }
        if workspace.openProjectIDs.contains(id) {
            workspace.selectedProjectID = id
            syncActiveTab()
            return
        }
        var snapshot = WorkspaceSnapshot(openProjectIDs: [id], selectedProjectID: id)
        snapshot.focusedPaneID = project(id)?.panes.first?.id
        if var existing = workspace.tabs.first(where: { $0.kind == .project && $0.projectID == id }) {
            existing.snapshot = snapshot
            existing.updatedAt = Date()
            navigate(to: existing, adding: true)
        } else {
            navigate(to: WorkspaceTab(kind: .project, projectID: id, snapshot: snapshot), adding: true)
        }
    }

    /// Shows a tab of the bar.
    public mutating func activateWorkspaceTab(_ id: WorkspaceTabID) {
        guard id != workspace.activeTabID, let tab = workspace.tabs.first(where: { $0.id == id }) else { return }
        navigate(to: tab, adding: false)
    }

    /// The tab `offset` places after the active one, wrapping around (⌃Tab / ⌃⇧Tab).
    public func workspaceTab(_ offset: Int) -> WorkspaceTabID? {
        let tabs = workspace.tabs
        guard tabs.count > 1 else { return nil }
        let current = tabs.firstIndex { $0.id == workspace.activeTabID } ?? 0
        return tabs[((current + offset) % tabs.count + tabs.count) % tabs.count].id
    }

    /// Pinned tabs come first and are the last ones dropped when the bar is full.
    public mutating func togglePinned(_ id: WorkspaceTabID) {
        guard let index = workspace.tabs.firstIndex(where: { $0.id == id }) else { return }
        workspace.tabs[index].pinned.toggle()
        workspace.tabs[index].updatedAt = Date()
        workspace.tabs = workspace.tabs.filter(\.pinned) + workspace.tabs.filter { !$0.pinned }
    }

    /// Moves a tab to `index` in the bar (pinned tabs stay ahead of the others).
    public mutating func moveWorkspaceTab(_ id: WorkspaceTabID, to index: Int) {
        guard let from = workspace.tabs.firstIndex(where: { $0.id == id }) else { return }
        let tab = workspace.tabs.remove(at: from)
        workspace.tabs.insert(tab, at: max(0, min(index, workspace.tabs.count)))
        workspace.tabs = workspace.tabs.filter(\.pinned) + workspace.tabs.filter { !$0.pinned }
    }

    /// Closes a tab (upstream `closeSavedWorkspaceTab`); it goes to the reopen list (⇧⌘T). Closing the
    /// active tab shows the next one, or the previous one when it was last; closing the only tab
    /// empties the workspace.
    public mutating func closeWorkspaceTab(_ id: WorkspaceTabID) {
        guard let index = workspace.tabs.firstIndex(where: { $0.id == id }) else { return }
        let closing = workspace.tabs.remove(at: index)
        workspace.closedTabs = Array(([closing] + workspace.closedTabs.filter { $0.id != id }).prefix(Self.maxWorkspaceTabs))
        let currentEntry = workspace.history.indices.contains(workspace.historyIndex)
            ? workspace.history[workspace.historyIndex].id : nil
        workspace.history.removeAll { $0.tabID == id }
        workspace.historyIndex = currentEntry.flatMap { entry in workspace.history.firstIndex { $0.id == entry } }
            ?? workspace.history.count - 1
        guard workspace.activeTabID == id else { return }
        guard !workspace.tabs.isEmpty else {
            workspace.activeTabID = nil
            workspace.history = []
            workspace.historyIndex = -1
            apply(WorkspaceSnapshot())
            return
        }
        navigate(to: workspace.tabs[min(index, workspace.tabs.count - 1)], adding: false)
    }

    /// Reopens the most recently closed tab (upstream `reopenClosedWorkspaceTab`).
    public mutating func reopenClosedWorkspaceTab() {
        guard !workspace.closedTabs.isEmpty else { return }
        var tab = workspace.closedTabs.removeFirst()
        tab.snapshot = sanitized(tab.snapshot)
        tab.updatedAt = Date()
        navigate(to: tab, adding: true)
    }

    public var canGoBack: Bool { workspace.historyIndex > 0 }
    public var canGoForward: Bool { workspace.historyIndex + 1 < workspace.history.count }

    /// Back (-1) or forward (+1) through the visited views (upstream `navigateWorkspaceHistory`).
    public mutating func navigateHistory(_ direction: Int) {
        let target = workspace.historyIndex + direction
        guard workspace.history.indices.contains(target) else { return }
        let entry = workspace.history[target]
        guard let tabIndex = workspace.tabs.firstIndex(where: { $0.id == entry.tabID }) else { return }
        let snapshot = sanitized(entry.snapshot)
        apply(snapshot)
        workspace.activeTabID = entry.tabID
        workspace.tabs[tabIndex].snapshot = snapshot
        workspace.historyIndex = target
    }

    /// Writes the live view back to the active tab and the current history entry. With no active tab,
    /// a non-empty view becomes the first tab (files from before tabs, and the first project opened).
    public mutating func syncActiveTab() {
        let snapshot = currentSnapshot
        guard let id = workspace.activeTabID, let index = workspace.tabs.firstIndex(where: { $0.id == id }) else {
            guard !snapshot.openProjectIDs.isEmpty else { return }
            let tab = snapshot.openProjectIDs.count == 1
                ? WorkspaceTab(kind: .project, projectID: snapshot.openProjectIDs[0], snapshot: snapshot)
                : WorkspaceTab(kind: .composition, snapshot: snapshot)
            navigate(to: tab, adding: true)
            return
        }
        var tab = workspace.tabs[index]
        guard tab.snapshot != snapshot else { return }
        tab.snapshot = snapshot
        tab.updatedAt = Date()
        // A project tab that now shows something else becomes a composition.
        if tab.kind == .project, snapshot.openProjectIDs != tab.projectID.map({ [$0] }) {
            tab.kind = .composition
            tab.projectID = nil
        }
        workspace.tabs[index] = tab
        if workspace.history.indices.contains(workspace.historyIndex),
           workspace.history[workspace.historyIndex].tabID == id {
            workspace.history[workspace.historyIndex].snapshot = snapshot
        }
    }

    /// Launch without the last view: nothing open, no active tab; the tab bar stays to pick from.
    public mutating func startClean() {
        workspace.activeTabID = nil
        apply(WorkspaceSnapshot())
    }

    /// Drops references to deleted projects from tabs, closed tabs and history.
    mutating func repairNavigation() {
        let known = Set(projects.map(\.id))
        func valid(_ tab: WorkspaceTab) -> Bool {
            tab.kind == .composition || tab.projectID.map(known.contains) == true
        }
        workspace.tabs = workspace.tabs.filter(valid).map { tab in
            var tab = tab
            tab.snapshot = sanitized(tab.snapshot)
            return tab
        }
        workspace.closedTabs = workspace.closedTabs.filter(valid)
        let tabIDs = Set(workspace.tabs.map(\.id))
        if let active = workspace.activeTabID, !tabIDs.contains(active) { workspace.activeTabID = nil }
        workspace.history = workspace.history.filter { tabIDs.contains($0.tabID) }
        workspace.historyIndex = min(workspace.historyIndex, workspace.history.count - 1)
        if workspace.historyIndex < 0, !workspace.history.isEmpty { workspace.historyIndex = workspace.history.count - 1 }
    }

    // MARK: - Helpers

    /// Shows `tab`, adding it to the bar when asked (dropping the oldest unpinned tab past the
    /// limit), and records the visit (upstream `applyTabNavigation`).
    mutating func navigate(to tab: WorkspaceTab, adding: Bool) {
        var tab = tab
        tab.snapshot = sanitized(tab.snapshot)
        if adding {
            if let index = workspace.tabs.firstIndex(where: { $0.id == tab.id }) {
                workspace.tabs[index] = tab
            } else {
                workspace.tabs.append(tab)
            }
            if workspace.tabs.count > Self.maxWorkspaceTabs,
               let removable = workspace.tabs.first(where: { $0.id != tab.id && !$0.pinned })
                ?? workspace.tabs.first(where: { $0.id != tab.id }) {
                let currentEntry = workspace.history.indices.contains(workspace.historyIndex)
                    ? workspace.history[workspace.historyIndex].id : nil
                workspace.tabs.removeAll { $0.id == removable.id }
                workspace.history.removeAll { $0.tabID == removable.id }
                workspace.historyIndex = currentEntry.flatMap { entry in workspace.history.firstIndex { $0.id == entry } }
                    ?? workspace.history.count - 1
            }
        }
        apply(tab.snapshot)
        workspace.activeTabID = tab.id
        pushHistory(WorkspaceHistoryEntry(tabID: tab.id, snapshot: tab.snapshot))
    }

    /// Appends a visit, dropping the forward branch and the oldest entries past the limit (upstream
    /// `pushWorkspaceHistory`).
    mutating func pushHistory(_ entry: WorkspaceHistoryEntry) {
        let branch = workspace.historyIndex >= 0 ? Array(workspace.history.prefix(workspace.historyIndex + 1)) : []
        workspace.history = Array((branch + [entry]).suffix(Self.maxWorkspaceHistory))
        workspace.historyIndex = workspace.history.count - 1
    }
}
