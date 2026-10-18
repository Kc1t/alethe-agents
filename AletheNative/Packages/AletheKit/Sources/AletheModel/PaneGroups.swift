import Foundation

/// Matches the web PaneGroup JSON, including orchestration metadata.
public struct PaneGroup: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var paneIds: [PaneID]
    public var kind: String?
    public var plannerId: PaneID?

    public init(id: String = "pane-group-" + UUID().uuidString, paneIds: [PaneID],
                kind: String? = nil, plannerId: PaneID? = nil) {
        self.id = id
        self.paneIds = paneIds
        self.kind = kind
        self.plannerId = plannerId
    }
}

extension Project {
    /// Discard dangling members and singleton stacks after close, move or import.
    public mutating func reconcilePaneGroups() {
        let known = Set(panes.map(\.id))
        var used = Set<PaneID>()
        paneGroups = paneGroups?.compactMap { group in
            var next = group
            var members = used
            next.paneIds = group.paneIds.filter { known.contains($0) && members.insert($0).inserted }
            guard next.paneIds.count >= 2 else { return nil }
            used = members
            return next
        }
    }

    /// Absorb intersecting stacks, preserving their order and orchestration metadata like the web.
    public mutating func groupPanes(_ ids: [PaneID], kind: String? = nil, plannerId: PaneID? = nil) {
        var seen = Set<PaneID>()
        let valid = ids.filter { id in panes.contains { $0.id == id } && seen.insert(id).inserted }
        guard valid.count >= 2 else { return }
        let selected = Set(valid)
        let absorbed = (paneGroups ?? []).filter { !$0.paneIds.allSatisfy { !selected.contains($0) } }
        seen = []
        let expanded = (absorbed.flatMap(\.paneIds) + valid).filter { seen.insert($0).inserted }
        var remaining = (paneGroups ?? []).filter { group in !absorbed.contains { $0.id == group.id } }
        remaining.append(PaneGroup(paneIds: expanded, kind: kind ?? absorbed.compactMap(\.kind).first,
                                   plannerId: plannerId ?? absorbed.compactMap(\.plannerId).first))
        paneGroups = remaining
        let grid = panes.first { $0.id == valid[0] }?.gridID
        for index in panes.indices where seen.contains(panes[index].id) { panes[index].gridID = grid }
    }

    public mutating func ungroupPanes(_ id: String) {
        paneGroups?.removeAll { $0.id == id }
    }
}
