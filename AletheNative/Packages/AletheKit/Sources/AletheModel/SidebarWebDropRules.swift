import Foundation

/// A sidebar item that can be picked up: the web's `proj:` / `grp:` / `term:` drag ids.
public enum SidebarDragPayload: Equatable, Sendable {
    case project(ProjectID), group(GroupID), pane(PaneID)
}

/// What a registered row stands for in the drag surface.
public enum SidebarWebDropTarget: Hashable, Sendable {
    case project(ProjectID)
    /// The terminal / pane rows under a project: part of that project's node, not a target of their own.
    case terminals(ProjectID)
    case groupHeader(GroupID)
    /// The placeholder row of an expanded group that has no children.
    case groupBody(GroupID)
    /// The "drop here to ungroup" row.
    case ungrouped
}

/// A row's live frame in the drag surface. `hit` is the whole cell (a project row includes the gap above it,
/// a group header the margin above it); `visual` is the element the user sees, used for the zones and marks.
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

/// What dropping would do and how to show it.
public struct SidebarDropPlan: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        /// Put a project or group into `container` (nil = top level) right before `before` (nil = at the end).
        case place(SidebarChild, container: GroupID?, before: SidebarChild?)
        /// Move a terminal into another project.
        case movePane(PaneID, to: ProjectID)
        /// Finder folders become projects in `container` (nil = ungrouped).
        case addFolders(container: GroupID?)
    }

    public enum Mark: Equatable, Sendable {
        /// Web `.dropBefore` / `.dropAfter`: a line above (`.before`) or below (`.after`) `rect`, indented by `indent`.
        case line(rect: CGRect, edge: SidebarDropEdge, indent: CGFloat)
        /// Web `.dropInside`: a bordered fill around `rect`.
        case box(CGRect)
    }

    public let action: Action
    public let mark: Mark
    /// The row that paints its own panel-hover fill behind its content for a `.box`.
    public let fill: SidebarWebDropTarget?

    public init(action: Action, mark: Mark, fill: SidebarWebDropTarget? = nil) {
        self.action = action
        self.mark = mark
        self.fill = fill
    }
}

/// Where a dragged item lands, from the pointer position over the live rows.
///
/// Every row is a drop target and its halves (or thirds, for a group header) are insertion points:
/// - A project dragged over a project row goes before or after it, in that row's group (or the ungrouped list);
///   over the terminals under a project it goes after that project; over a group header it goes into the group
///   (a header nested in another group also has a "before this group" zone).
/// - A group dragged over a project row goes before or after it inside the project's group (a group may sit
///   between projects); over a group header it goes before it, into it, or after it; over the margin between
///   two groups it goes before the one below.
/// - A terminal only lands on another project, and Finder folders on any container.
/// The web's `sidebarCollisionDetection` (`NormalProjectSidebar.tsx`) is the starting point; the extra zones
/// make reordering work from anywhere inside a group's area.
public enum SidebarWebDropRules {
    public enum Source: Equatable, Sendable {
        case item(SidebarDragPayload)
        /// Folders dragged in from Finder.
        case files
    }

    /// The plan for the pointer at `point` (surface coordinates), or nil when nothing can be dropped there.
    /// `width` is the surface width: rows span all of it, as List insets and group indentation belong to a row.
    public static func plan(_ source: Source, regions: [SidebarDropRegion], at point: CGPoint, width: CGFloat,
                            in document: WorkspaceDocument) -> SidebarDropPlan? {
        guard point.x >= 0, point.x <= width else { return nil }
        let rows = regions.filter { $0.hit.height > 0 }.sorted { $0.hit.minY < $1.hit.minY }
        guard let first = rows.first, let lowest = rows.map(\.hit.maxY).max() else { return nil }
        let layout = Layout(rows: rows, document: document)
        let y = max(point.y, first.hit.minY)
        if y >= lowest { return layout.blank(source) }
        let containing = rows.filter { $0.hit.minY <= y && y < $0.hit.maxY }.min { $0.hit.height < $1.hit.height }
        guard let row = containing ?? rows.min(by: { layout.distance(from: y, to: $0) < layout.distance(from: y, to: $1) })
        else { return nil }
        switch source {
        case .files: return layout.files(row)
        case .item(.pane(let id)): return layout.pane(id, row)
        case .item(.project(let id)): return layout.project(id, row, y: y)
        case .item(.group(let id)): return layout.group(id, row, y: y)
        }
    }

    // MARK: - Layout

    private struct Layout {
        let rows: [SidebarDropRegion]
        let document: WorkspaceDocument
        var projects: [ProjectID: SidebarDropRegion] = [:]
        var terminals: [ProjectID: [SidebarDropRegion]] = [:]
        var headers: [GroupID: SidebarDropRegion] = [:]
        var placeholders: [GroupID: SidebarDropRegion] = [:]

        init(rows: [SidebarDropRegion], document: WorkspaceDocument) {
            self.rows = rows
            self.document = document
            for row in rows {
                switch row.target {
                case .project(let id): projects[id] = row
                case .terminals(let id): terminals[id, default: []].append(row)
                case .groupHeader(let id): headers[id] = row
                case .groupBody(let id): placeholders[id] = row
                case .ungrouped: break
                }
            }
        }

        func distance(from y: CGFloat, to row: SidebarDropRegion) -> CGFloat {
            y < row.hit.minY ? row.hit.minY - y : y >= row.hit.maxY ? y - row.hit.maxY : 0
        }

        func container(of project: ProjectID) -> GroupID? {
            if case .group(let id)? = document.location(of: project) { return id }
            return nil
        }

        /// A project's row plus the terminal rows under it.
        func node(of project: ProjectID) -> CGRect? {
            var rect = projects[project]?.visual
            for terminal in terminals[project] ?? [] { rect = rect.map { $0.union(terminal.visual) } ?? terminal.visual }
            return rect
        }

        func region(of child: SidebarChild) -> SidebarDropRegion? {
            switch child {
            case .project(let id): projects[id]
            case .group(let id): headers[id]
            }
        }

        /// The sibling displayed right after `child` in `container`, ignoring the item being moved.
        func next(after child: SidebarChild, in container: GroupID?, skipping item: SidebarChild) -> SidebarChild? {
            let list = document.sidebarChildren(of: container).filter { $0 != item }
            guard let index = list.firstIndex(of: child), index + 1 < list.count else { return nil }
            return list[index + 1]
        }

        /// 0 at the top of the visible element, 1 at its bottom; the margin above counts as the top.
        func fraction(_ y: CGFloat, in row: SidebarDropRegion) -> CGFloat {
            guard row.visual.height > 0 else { return 0 }
            return min(max((y - row.visual.minY) / row.visual.height, 0), 1)
        }

        func line(_ rect: CGRect, _ edge: SidebarDropEdge, indent: CGFloat = 0) -> SidebarDropPlan.Mark {
            .line(rect: rect, edge: edge, indent: indent)
        }

        func place(_ item: SidebarChild, in container: GroupID?, before: SidebarChild?) -> SidebarDropPlan.Action {
            .place(item, container: container, before: before)
        }

        /// The top level: a group goes after the last top-level group, a project at the end of the ungrouped list.
        func topLevelEnd(_ item: SidebarChild) -> SidebarDropPlan {
            let ungrouped = projects.filter { container(of: $0.key) == nil }.values.min { $0.visual.minY < $1.visual.minY }
            let mark: SidebarDropPlan.Mark
            if case .group = item, let ungrouped {
                mark = line(ungrouped.visual, .before)
            } else if let last = rows.max(by: { $0.hit.maxY < $1.hit.maxY }) {
                mark = line(last.visual, .after)
            } else {
                mark = .box(.zero)
            }
            return SidebarDropPlan(action: place(item, in: nil, before: nil), mark: mark)
        }

        /// Before or after a sibling row, by the pointer's side of its midpoint.
        func beside(_ row: SidebarDropRegion, child: SidebarChild, container: GroupID?, item: SidebarChild, y: CGFloat)
            -> SidebarDropPlan {
            if y < row.visual.midY {
                return SidebarDropPlan(action: place(item, in: container, before: child), mark: line(row.visual, .before))
            }
            // "After a project" is after its whole node, so the line goes under its terminals too.
            var rect = row.visual
            if case .project(let id) = child, let node = node(of: id) { rect = node }
            return SidebarDropPlan(action: place(item, in: container, before: next(after: child, in: container, skipping: item)),
                                   mark: line(rect, .after))
        }

        /// After a project's whole node (its terminals included).
        func afterNode(of project: ProjectID, item: SidebarChild, fallback: CGRect) -> SidebarDropPlan {
            let container = container(of: project)
            return SidebarDropPlan(
                action: place(item, in: container, before: next(after: .project(project), in: container, skipping: item)),
                mark: line(node(of: project) ?? fallback, .after))
        }

        func into(group id: GroupID, item: SidebarChild, row: SidebarDropRegion, fill: SidebarWebDropTarget) -> SidebarDropPlan {
            SidebarDropPlan(action: place(item, in: id, before: nil), mark: .box(row.visual), fill: fill)
        }

        // MARK: Past the last row

        func blank(_ source: Source) -> SidebarDropPlan? {
            switch source {
            case .item(.project(let id)): return topLevelEnd(.project(id))
            case .item(.group(let id)): return topLevelEnd(.group(id))
            case .item(.pane): return nil
            case .files:
                guard let last = rows.max(by: { $0.hit.maxY < $1.hit.maxY }) else { return nil }
                return SidebarDropPlan(action: .addFolders(container: nil), mark: line(last.visual, .after))
            }
        }

        // MARK: A project is dragged

        func project(_ id: ProjectID, _ row: SidebarDropRegion, y: CGFloat) -> SidebarDropPlan? {
            let item = SidebarChild.project(id)
            switch row.target {
            case .project(let other):
                guard other != id else { return nil }
                return beside(row, child: .project(other), container: container(of: other), item: item, y: y)
            case .terminals(let other):
                guard other != id else { return nil }
                return afterNode(of: other, item: item, fallback: row.visual)
            case .groupHeader(let target):
                guard let parent = document.group(target)?.parentID else {
                    // A top-level group: the header means "into the group"; the gap above it is between groups.
                    return y >= row.visual.minY ? into(group: target, item: item, row: row, fill: .groupHeader(target)) : nil
                }
                if fraction(y, in: row) < 0.3 {
                    return SidebarDropPlan(action: place(item, in: parent, before: .group(target)), mark: line(row.visual, .before))
                }
                return into(group: target, item: item, row: row, fill: .groupHeader(target))
            case .groupBody(let target):
                return SidebarDropPlan(action: place(item, in: target, before: nil), mark: .box(row.hit), fill: .groupBody(target))
            case .ungrouped:
                return SidebarDropPlan(action: place(item, in: nil, before: nil), mark: .box(row.hit), fill: .ungrouped)
            }
        }

        // MARK: A group is dragged

        func group(_ id: GroupID, _ row: SidebarDropRegion, y: CGFloat) -> SidebarDropPlan? {
            let item = SidebarChild.group(id)
            switch row.target {
            case .project(let other):
                if let parent = container(of: other), document.isGroup(parent, inside: id) { return nil }
                guard let parent = container(of: other) else { return topLevelEnd(item) }
                return beside(row, child: .project(other), container: parent, item: item, y: y)
            case .terminals(let other):
                if let parent = container(of: other), document.isGroup(parent, inside: id) { return nil }
                guard container(of: other) != nil else { return topLevelEnd(item) }
                return afterNode(of: other, item: item, fallback: row.visual)
            case .groupHeader(let target):
                guard !document.isGroup(target, inside: id), let group = document.group(target) else { return nil }
                return header(group, row, item: item, y: y)
            case .groupBody(let target):
                guard !document.isGroup(target, inside: id) else { return nil }
                return SidebarDropPlan(action: place(item, in: target, before: nil), mark: .box(row.hit), fill: .groupBody(target))
            case .ungrouped:
                return SidebarDropPlan(action: place(item, in: nil, before: nil), mark: .box(row.hit), fill: .ungrouped)
            }
        }

        /// A group over a group header: before it, into it or after it. An expanded group has no "after" zone on
        /// its header (that spot is the top of its children, so the bottom half means "first child"); to land after
        /// it, aim at the gap above the next group or below the last child.
        func header(_ target: ProjectGroup, _ row: SidebarDropRegion, item: SidebarChild, y: CGFloat) -> SidebarDropPlan {
            let parent = target.parentID
            let t = fraction(y, in: row)
            let before = SidebarDropPlan(action: place(item, in: parent, before: .group(target.id)), mark: line(row.visual, .before))
            if target.isCollapsed {
                if t < 0.3 { return before }
                if t > 0.7 {
                    return SidebarDropPlan(
                        action: place(item, in: parent, before: next(after: .group(target.id), in: parent, skipping: item)),
                        mark: line(row.visual, .after))
                }
                return into(group: target.id, item: item, row: row, fill: .groupHeader(target.id))
            }
            if t < 0.5 { return before }
            let first = document.sidebarChildren(of: target.id).first { $0 != item }
            let childX = first.flatMap { region(of: $0) }?.visual.minX ?? placeholders[target.id]?.visual.minX ?? row.visual.minX
            return SidebarDropPlan(action: place(item, in: target.id, before: first),
                                   mark: line(row.visual, .after, indent: max(0, childX - row.visual.minX)))
        }

        // MARK: A terminal or Finder folders are dragged

        func pane(_ id: PaneID, _ row: SidebarDropRegion) -> SidebarDropPlan? {
            switch row.target {
            case .project(let other), .terminals(let other):
                guard document.pane(id)?.project.id != other else { return nil }
                let rect = node(of: other) ?? row.visual
                return SidebarDropPlan(action: .movePane(id, to: other), mark: .box(rect), fill: .project(other))
            default:
                return nil
            }
        }

        func files(_ row: SidebarDropRegion) -> SidebarDropPlan? {
            switch row.target {
            case .project(let other), .terminals(let other):
                return SidebarDropPlan(action: .addFolders(container: container(of: other)),
                                       mark: .box(node(of: other) ?? row.visual), fill: .project(other))
            case .groupHeader(let target):
                return SidebarDropPlan(action: .addFolders(container: target), mark: .box(row.visual), fill: .groupHeader(target))
            case .groupBody(let target):
                return SidebarDropPlan(action: .addFolders(container: target), mark: .box(row.hit), fill: .groupBody(target))
            case .ungrouped:
                return SidebarDropPlan(action: .addFolders(container: nil), mark: .box(row.hit), fill: .ungrouped)
            }
        }
    }
}
