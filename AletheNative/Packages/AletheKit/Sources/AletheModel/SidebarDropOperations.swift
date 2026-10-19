import Foundation

/// Pointer-facing edges use the persisted order, including rows hidden by sidebar filters.
public enum SidebarDropEdge: Equatable, Sendable { case before, after, inside }

extension WorkspaceDocument {
    public mutating func dropProject(_ id: ProjectID, beside target: ProjectID, edge: SidebarDropEdge) {
        guard id != target, let location = location(of: target) else { return }
        let ids: [ProjectID]
        switch location {
        case .ungrouped: ids = ungroupedProjectIDs
        case .group(let group): ids = self.group(group)?.projectIDs ?? []
        }
        guard let index = ids.firstIndex(of: target) else { return }
        // moveProject already compensates for removing the source from the same list.
        moveProject(id, to: location, at: index + (edge == .after ? 1 : 0))
    }

    public mutating func dropGroup(_ id: GroupID, beside target: GroupID, edge: SidebarDropEdge) {
        guard id != target, let destination = group(target) else { return }
        if edge == .inside {
            guard group(id)?.parentID != target else { return }
            moveGroup(id, toParent: target, at: Int.max)
            return
        }
        let siblings = childGroups(of: destination.parentID)
        guard let targetIndex = siblings.firstIndex(where: { $0.id == target }) else { return }
        var index = targetIndex + (edge == .after ? 1 : 0)
        // moveGroup accepts an index AFTER removal, matching the web store.
        if let source = siblings.firstIndex(where: { $0.id == id }), source < index { index -= 1 }
        moveGroup(id, toParent: destination.parentID, at: index)
    }
}
