import Foundation

/// A sidebar item that can be picked up: the web's `proj:` / `grp:` / `term:` drag ids.
public enum SidebarDragPayload: Equatable, Sendable {
    case project(ProjectID), group(GroupID), pane(PaneID)
}

/// Separate row/header and body targets mirror dnd-kit's ranked collision targets.
public enum SidebarWebDropTarget: Hashable, Sendable {
    case project(ProjectID), groupHeader(GroupID), groupBody(GroupID), ungrouped
}

/// A droppable's live frame in the drop surface. `hit` is the forgiving area (a project row includes the gap
/// above it); `visual` is the element the web would measure, used for the edge midpoint and the indicator.
public struct SidebarDropRegion: Equatable, Sendable {
    public let target: SidebarWebDropTarget
    public let hit: CGRect
    public let visual: CGRect

    public init(target: SidebarWebDropTarget, hit: CGRect, visual: CGRect) {
        self.target = target
        self.hit = hit
        self.visual = visual
    }
}

/// Which droppables accept what, and where the pointer lands, exactly as `sidebarCollisionDetection` and
/// `dropIndicatorForEvent` do in the web sidebar (`NormalProjectSidebar.tsx` / `index.tsx`).
public enum SidebarWebDropRules {
    public enum Source: Equatable, Sendable {
        case item(SidebarDragPayload)
        /// Folders dragged in from Finder.
        case files
    }

    /// Collision rank (lower wins, then the smaller area); nil when the source cannot be dropped there.
    ///
    /// Web: a project may land on project rows (rank 0) and group headers or the ungrouped zone (rank 1), never
    /// on a group body. A group may land on group headers (rank 0, reorder) and group bodies or the ungrouped
    /// zone (rank 1, nest), never on a project row, itself or one of its descendants. A terminal only lands on a
    /// project row of another project.
    public static func rank(_ source: Source, over target: SidebarWebDropTarget, in document: WorkspaceDocument) -> Int? {
        switch (source, target) {
        case (.item(.project(let id)), .project(let destination)):
            return id == destination ? nil : 0
        case (.item(.project), .groupHeader), (.item(.project), .ungrouped):
            return 1
        case (.item(.pane(let id)), .project(let destination)):
            return document.pane(id)?.project.id == destination ? nil : 0
        case (.item(.group(let id)), .groupHeader(let destination)):
            return document.isGroup(destination, inside: id) ? nil : 0
        case (.item(.group(let id)), .groupBody(let destination)):
            return document.isGroup(destination, inside: id) ? nil : 1
        case (.item(.group), .ungrouped):
            return 1
        case (.files, .project), (.files, .groupHeader):
            return 0
        case (.files, .groupBody), (.files, .ungrouped):
            return 1
        default:
            return nil
        }
    }

    /// Rows and headers reorder by the pointer's side of the element midpoint; everything else drops inside.
    public static func edge(_ source: Source, over region: SidebarDropRegion, pointerY: CGFloat) -> SidebarDropEdge {
        switch (source, region.target) {
        case (.files, _), (.item(.pane), _):
            return .inside
        case (_, .project), (.item(.group), .groupHeader):
            return SidebarDropResolution.edge(at: pointerY, row: region.visual)
        default:
            return .inside
        }
    }

    /// The winning droppable under `point` (surface coordinates) and where inside it the item lands.
    /// `width` is the surface width: rows and headers are hit across the whole width, as List insets and group
    /// indentation belong to the same row.
    public static func resolve(_ source: Source, regions: [SidebarDropRegion], at point: CGPoint, width: CGFloat,
                               in document: WorkspaceDocument) -> (region: SidebarDropRegion, edge: SidebarDropEdge)? {
        var ranked: [(region: SidebarDropRegion, rank: Int)] = []
        for region in regions {
            if let rank = rank(source, over: region.target, in: document) { ranked.append((region, rank)) }
        }
        let candidates = ranked.map { entry -> SidebarDropCandidate in
            let region = entry.region
            let bounds: CGRect
            switch region.target {
            case .project:
                bounds = CGRect(x: 0, y: region.hit.minY, width: width, height: region.hit.height)
            case .groupHeader:
                // A group dragged over the gap above a header means "before it"; a project there is between
                // groups, which the web leaves without a target.
                let area = isGroupSource(source) ? region.hit : region.visual
                bounds = CGRect(x: 0, y: area.minY, width: width, height: area.height)
            default:
                bounds = region.hit
            }
            return SidebarDropCandidate(bounds: bounds, rank: entry.rank)
        }
        guard let index = SidebarDropResolution.winner(at: point, candidates: candidates) else { return nil }
        let region = ranked[index].region
        return (region, edge(source, over: region, pointerY: point.y))
    }

    private static func isGroupSource(_ source: Source) -> Bool {
        if case .item(.group) = source { return true }
        return false
    }
}
