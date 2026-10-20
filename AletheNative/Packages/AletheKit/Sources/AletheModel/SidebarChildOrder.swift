/// A direct child in the sidebar's mixed group/project order.
public enum SidebarChild: Hashable, Sendable {
    case group(GroupID)
    case project(ProjectID)

    var orderToken: String {
        switch self {
        case .group(let id): "g:\(id.rawValue)"
        case .project(let id): "p:\(id.rawValue)"
        }
    }
}

extension WorkspaceDocument {
    private func defaultSidebarChildren(of container: GroupID?) -> [SidebarChild] {
        childGroups(of: container).map { SidebarChild.group($0.id) }
            + (container.map { group($0)?.projectIDs ?? [] } ?? ungroupedProjectIDs).map { .project($0) }
    }

    /// Display order of direct children; the root always groups groups before projects.
    public func sidebarChildren(of container: GroupID?) -> [SidebarChild] {
        let members = defaultSidebarChildren(of: container)
        guard let container, let tokens = group(container)?.childOrder else { return members }
        let byToken = Dictionary(uniqueKeysWithValues: members.map { ($0.orderToken, $0) })
        var seen = Set<SidebarChild>()
        let ordered = tokens.compactMap { token -> SidebarChild? in
            guard let member = byToken[token], seen.insert(member).inserted else { return nil }
            return member
        }
        return ordered + members.filter { seen.insert($0).inserted }
    }

    /// Moves a child into a container, before a sibling or at the end if none matches.
    public mutating func place(_ item: SidebarChild, in container: GroupID?, before sibling: SidebarChild?) {
        guard sibling != item else { return }
        if let container, group(container) == nil { return }
        let oldContainer: GroupID?
        var movingGroup: ProjectGroup?
        switch item {
        case .project(let id):
            guard project(id) != nil else { return }
            oldContainer = groups.first { $0.projectIDs.contains(id) }?.id
            ungroupedProjectIDs.removeAll { $0 == id }
            for index in groups.indices { groups[index].projectIDs.removeAll { $0 == id } }
        case .group(let id):
            guard let moving = group(id) else { return }
            if let container, isGroup(container, inside: id) { return }
            oldContainer = moving.parentID
            movingGroup = moving
            groups.removeAll { $0.id == id }
            movingGroup?.parentID = container
        }

        var list = sidebarChildren(of: container)
        let insertion = sibling.flatMap { list.firstIndex(of: $0) } ?? list.count
        list.insert(item, at: insertion)
        // Restore the group only after computing membership without the moving item.
        if let movingGroup { groups.append(movingGroup) }
        let projectIDs = list.compactMap { child -> ProjectID? in
            if case .project(let id) = child { return id }
            return nil
        }
        let groupIDs = list.compactMap { child -> GroupID? in
            if case .group(let id) = child { return id }
            return nil
        }
        let siblings = groups.filter { $0.parentID == container }
        let first = groups.firstIndex { $0.parentID == container } ?? groups.count
        let byID = Dictionary(uniqueKeysWithValues: siblings.map { ($0.id, $0) })
        groups.removeAll { $0.parentID == container }
        groups.insert(contentsOf: groupIDs.compactMap { byID[$0] }, at: first)
        if let container, let index = groups.firstIndex(where: { $0.id == container }) {
            groups[index].projectIDs = projectIDs
            groups[index].childOrder = list == defaultSidebarChildren(of: container) ? nil : list.map(\.orderToken)
        } else {
            ungroupedProjectIDs = projectIDs
        }
        if let oldContainer, oldContainer != container,
           let index = groups.firstIndex(where: { $0.id == oldContainer }), groups[index].childOrder != nil {
            groups[index].childOrder?.removeAll { $0 == item.orderToken }
            normalizeSidebarChildOrder(of: oldContainer)
        }
    }

    /// Canonicalizes an explicitly stored order after membership changes.
    mutating func normalizeSidebarChildOrder(of container: GroupID) {
        guard let index = groups.firstIndex(where: { $0.id == container }), groups[index].childOrder != nil else { return }
        let list = sidebarChildren(of: container)
        groups[index].childOrder = list == defaultSidebarChildren(of: container) ? nil : list.map(\.orderToken)
    }
}
