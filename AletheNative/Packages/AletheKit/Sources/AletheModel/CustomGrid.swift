import Foundation

/// Where one child sits in a custom grid: 1-based column and row plus spans (upstream `GridCell`).
public struct GridCell: Codable, Hashable, Sendable {
    public var col: Int
    public var row: Int
    public var colSpan: Int
    public var rowSpan: Int

    public init(col: Int, row: Int, colSpan: Int = 1, rowSpan: Int = 1) {
        self.col = col
        self.row = row
        self.colSpan = colSpan
        self.rowSpan = rowSpan
    }

    func overlaps(_ other: GridCell) -> Bool {
        col < other.col + other.colSpan && col + colSpan > other.col
            && row < other.row + other.rowSpan && row + rowSpan > other.row
    }
}

/// A custom grid (upstream `CustomGrid`): tracks, one cell per child id, optional relative track
/// sizes. Children are keyed by id string so the same grid serves panes today and containers later.
public struct CustomGrid: Codable, Hashable, Sendable {
    public enum Edge: String, CaseIterable, Sendable {
        case left, right, top, bottom
    }

    public var cols: Int
    public var rows: Int
    public var cells: [String: GridCell]
    public var colSizes: [Double]?
    public var rowSizes: [Double]?

    public init(cols: Int, rows: Int, cells: [String: GridCell] = [:], colSizes: [Double]? = nil,
                rowSizes: [Double]? = nil) {
        self.cols = cols
        self.rows = rows
        self.cells = cells
        self.colSizes = colSizes
        self.rowSizes = rowSizes
    }

    /// Children row by row in `cols` columns (upstream `autoGridLayout`).
    public static func auto(_ ids: [String], cols: Int = 2) -> CustomGrid {
        let cols = max(1, cols)
        var cells: [String: GridCell] = [:]
        for (index, id) in ids.enumerated() {
            cells[id] = GridCell(col: index % cols + 1, row: index / cols + 1)
        }
        return CustomGrid(cols: cols, rows: max(1, (ids.count + cols - 1) / cols), cells: cells)
    }

    private var safeCols: Int { max(1, cols) }
    private var safeRows: Int { max(1, rows) }

    private func clamped(_ cell: GridCell) -> GridCell {
        let colSpan = max(1, min(safeCols, cell.colSpan))
        let rowSpan = max(1, min(safeRows, cell.rowSpan))
        return GridCell(col: max(1, min(safeCols - colSpan + 1, cell.col)),
                        row: max(1, min(safeRows - rowSpan + 1, cell.row)), colSpan: colSpan, rowSpan: rowSpan)
    }

    /// Every child gets a valid, non-overlapping cell: missing or colliding ones move to the first
    /// free spot, adding rows when needed; stale track sizes are dropped (upstream
    /// `reconcileGridLayout`).
    public func reconciled(_ ids: [String]) -> CustomGrid {
        var result = CustomGrid(cols: safeCols, rows: safeRows)
        var occupied: [GridCell] = []
        func free(_ cell: GridCell) -> Bool { !occupied.contains { $0.overlaps(cell) } }
        for id in ids {
            let preferred = result.clamped(cells[id] ?? GridCell(col: 1, row: 1))
            var cell = preferred
            if !free(cell) {
                search: while true {
                    for row in 1...max(1, result.rows - preferred.rowSpan + 1) {
                        for col in 1...max(1, result.cols - preferred.colSpan + 1) {
                            let candidate = GridCell(col: col, row: row, colSpan: preferred.colSpan, rowSpan: preferred.rowSpan)
                            if free(candidate) {
                                cell = candidate
                                break search
                            }
                        }
                    }
                    result.rows += 1
                }
            }
            result.cells[id] = cell
            occupied.append(cell)
        }
        if let colSizes, colSizes.count == result.cols {
            result.colSizes = colSizes.map { max(0.1, $0.isFinite ? $0 : 1) }
        }
        if let rowSizes {
            var sizes = Array(rowSizes.prefix(result.rows)).map { max(0.1, $0.isFinite ? $0 : 1) }
            while sizes.count < result.rows { sizes.append(1) }
            result.rowSizes = sizes
        }
        return result
    }

    /// `[row][col]` (0-based) holding the id in that slot, nil when free (upstream `occupancyGrid`).
    public func occupancy(_ ids: [String]) -> [[String?]] {
        var grid = Array(repeating: Array(repeating: String?.none, count: safeCols), count: safeRows)
        for id in ids {
            guard let raw = cells[id] else { continue }
            let cell = clamped(raw)
            for row in cell.row..<(cell.row + cell.rowSpan) where row <= safeRows {
                for col in cell.col..<(cell.col + cell.colSpan) where col <= safeCols {
                    grid[row - 1][col - 1] = id
                }
            }
        }
        return grid
    }

    /// Free slots, row by row (1-based).
    public func freeCells(_ ids: [String]) -> [(col: Int, row: Int)] {
        occupancy(ids).enumerated().flatMap { row, line in
            line.enumerated().compactMap { col, occupant in occupant == nil ? (col + 1, row + 1) : nil }
        }
    }

    public func hasFreeCells(_ ids: [String]) -> Bool {
        occupancy(ids).contains { $0.contains(nil) }
    }

    /// Whole free lines past `edge` of a child; a line counts only when free along the whole side
    /// (upstream `freeSpanFor`).
    public func freeSpan(_ ids: [String], _ id: String, _ edge: Edge) -> Int {
        guard let raw = cells[id] else { return 0 }
        let cell = clamped(raw)
        let grid = occupancy(ids)
        func columnFree(_ col: Int) -> Bool {
            guard (1...safeCols).contains(col) else { return false }
            return (cell.row..<(cell.row + cell.rowSpan)).allSatisfy { $0 <= safeRows && grid[$0 - 1][col - 1] == nil }
        }
        func rowFree(_ row: Int) -> Bool {
            guard (1...safeRows).contains(row) else { return false }
            return (cell.col..<(cell.col + cell.colSpan)).allSatisfy { $0 <= safeCols && grid[row - 1][$0 - 1] == nil }
        }
        var span = 0
        for step in 1... {
            let free = switch edge {
            case .right: columnFree(cell.col + cell.colSpan - 1 + step)
            case .left: columnFree(cell.col - step)
            case .bottom: rowFree(cell.row + cell.rowSpan - 1 + step)
            case .top: rowFree(cell.row - step)
            }
            guard free else { break }
            span = step
        }
        return span
    }

    /// Grows (`steps > 0`, capped by free space) or shrinks (never below one slot) a child towards
    /// an edge (upstream `expandCell`).
    public func expanding(_ ids: [String], _ id: String, _ edge: Edge, by steps: Int) -> CustomGrid {
        guard let raw = cells[id], steps != 0 else { return self }
        let cell = clamped(raw)
        let horizontal = edge == .left || edge == .right
        let span = horizontal ? cell.colSpan : cell.rowSpan
        let amount = steps > 0 ? min(steps, freeSpan(ids, id, edge)) : -min(-steps, span - 1)
        guard amount != 0 else { return self }
        var next = cell
        switch edge {
        case .right: next.colSpan += amount
        case .bottom: next.rowSpan += amount
        case .left:
            next.col -= amount
            next.colSpan += amount
        case .top:
            next.row -= amount
            next.rowSpan += amount
        }
        var result = self
        result.cells[id] = next
        return result
    }

    /// Grows a child over every free slot reachable from it (upstream `fillFreeSpace`).
    public func fillingFreeSpace(_ ids: [String], _ id: String) -> CustomGrid {
        guard cells[id] != nil else { return self }
        var current = self
        for _ in 0..<max(1, cols * rows) {
            var changed = false
            for edge in [Edge.right, .bottom, .left, .top] {
                let span = current.freeSpan(ids, id, edge)
                guard span > 0 else { continue }
                current = current.expanding(ids, id, edge, by: span)
                changed = true
            }
            if !changed { break }
        }
        return current
    }

    /// Moves a child's top-left to (`col`, `row`); landing on another child swaps them (upstream
    /// `moveCellTo`).
    public func moving(_ ids: [String], _ id: String, toCol col: Int, row: Int) -> CustomGrid {
        guard let raw = cells[id] else { return self }
        let source = clamped(raw)
        let targetCol = max(1, min(safeCols, col)), targetRow = max(1, min(safeRows, row))
        guard targetCol != source.col || targetRow != source.row else { return self }
        func occupants(_ cell: GridCell) -> [String] {
            ids.filter { $0 != id && cells[$0].map { clamped($0).overlaps(cell) } == true }
        }
        var target = GridCell(col: targetCol, row: targetRow,
                              colSpan: max(1, min(source.colSpan, safeCols - targetCol + 1)),
                              rowSpan: max(1, min(source.rowSpan, safeRows - targetRow + 1)))
        var found = occupants(target)
        if found.count > 1 {
            target.colSpan = 1
            target.rowSpan = 1
            found = occupants(target)
        }
        var result = self
        result.cells[id] = target
        if found.count == 1, let other = cells[found[0]].map(clamped) {
            result.cells[found[0]] = clamped(GridCell(col: source.col, row: source.row,
                                                      colSpan: min(other.colSpan, safeCols - source.col + 1),
                                                      rowSpan: min(other.rowSpan, safeRows - source.row + 1)))
        }
        return result
    }

    /// Sets the track counts, keeping the sizes of the tracks that remain (designer steppers).
    public func resized(cols: Int, rows: Int, _ ids: [String]) -> CustomGrid {
        func tracks(_ sizes: [Double]?, _ count: Int) -> [Double] {
            let current = sizes ?? []
            return current.count >= count ? Array(current.prefix(count)) : current + Array(repeating: 1, count: count - current.count)
        }
        var result = self
        result.cols = max(1, cols)
        result.rows = max(1, rows)
        result.colSizes = tracks(colSizes, result.cols)
        result.rowSizes = tracks(rowSizes, result.rows)
        return result.reconciled(ids)
    }
}

/// A saved custom grid, most recent first (upstream `CustomGridHistoryEntry`).
public struct CustomGridHistoryEntry: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var savedAt: Date
    public var layout: CustomGrid

    public init(id: String = UUID().uuidString, savedAt: Date = Date(), layout: CustomGrid) {
        self.id = id
        self.savedAt = savedAt
        self.layout = layout
    }

    private enum CodingKeys: String, CodingKey { case id, savedAt, layout }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        layout = try values.decode(CustomGrid.self, forKey: .layout)
        // Web stores Date.now() milliseconds; retain decoding of older native Date values.
        if let timestamp = try? values.decode(Double.self, forKey: .savedAt), timestamp > 100_000_000_000 {
            savedAt = Date(timeIntervalSince1970: timestamp / 1000)
        } else {
            savedAt = try values.decode(Date.self, forKey: .savedAt)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(layout, forKey: .layout)
        try values.encode(savedAt.timeIntervalSince1970 * 1000, forKey: .savedAt)
    }

}

/// Ready-made grids offered by the designer (upstream `createLayoutPresets`).
public enum CustomGridPreset: String, CaseIterable, Sendable {
    case balanced, columns, rows, focusLeft, focusTop

    public func layout(_ ids: [String]) -> CustomGrid {
        let count = max(1, ids.count)
        let focusRows = max(1, ids.count - 1)
        switch self {
        case .balanced:
            return .auto(ids, cols: max(1, min(4, Int(Double(count).squareRoot().rounded(.up)))))
        case .columns:
            return .auto(ids, cols: count)
        case .rows:
            return .auto(ids, cols: 1)
        case .focusLeft, .focusTop:
            var cells: [String: GridCell] = [:]
            let left = self == .focusLeft
            for (index, id) in ids.enumerated() {
                if index == 0 {
                    let lead = ids.count > 1 ? 1 : 2
                    cells[id] = left ? GridCell(col: 1, row: 1, colSpan: lead, rowSpan: focusRows)
                        : GridCell(col: 1, row: 1, colSpan: focusRows, rowSpan: lead)
                } else {
                    cells[id] = left ? GridCell(col: 2, row: index) : GridCell(col: index, row: 2)
                }
            }
            let two = ids.count > 1 ? 2 : 1
            return left ? CustomGrid(cols: two, rows: focusRows, cells: cells)
                : CustomGrid(cols: focusRows, rows: two, cells: cells)
        }
    }
}

extension WorkspaceDocument {
    public static let maxGridLayoutHistory = 8

    /// Saves a project's custom grid and switches it to the Grid layout; with `recordHistory`, the
    /// grid also goes to the front of its recent grids (upstream `setProjectGridLayout`).
    public mutating func setGridLayout(_ layout: CustomGrid, for id: ProjectID, recordHistory: Bool = false) {
        guard let project = project(id) else { return }
        let clean = layout.reconciled(project.visiblePanes.map(\.id.rawValue))
        updateProject(id) { project in
            var arrangement = project.activeArrangement
            arrangement.gridLayout = clean
            arrangement.layoutMode = .grid
            if recordHistory {
                var history = arrangement.gridLayoutHistory ?? []
                if history.first?.layout != clean {
                    history.insert(CustomGridHistoryEntry(layout: clean), at: 0)
                }
                arrangement.gridLayoutHistory = Array(history.prefix(Self.maxGridLayoutHistory))
            }
            project.activeArrangement = arrangement
        }
    }

    public func effectiveGrid(of project: Project) -> CustomGrid { project.effectiveGrid }

    /// Track sizes committed by a resize: a grid project keeps them in its grid; the other layouts
    /// in the workspace's per-project weights.
    public mutating func setTrackWeights(_ weights: GridWeights, for id: ProjectID) {
        guard let project = project(id) else { return }
        guard project.layout == .grid else {
            workspace.gridWeights[project.weightsKey] = weights
            return
        }
        var grid = effectiveGrid(of: project)
        if weights.columns.count == grid.cols { grid.colSizes = weights.columns }
        if weights.rows.count == grid.rows { grid.rowSizes = weights.rows }
        updateProject(id) { $0.activeArrangement.gridLayout = grid }
    }

    /// Moves a pane of a grid project to a slot (dragging a pane onto another pane or a free slot).
    public mutating func moveGridCell(_ pane: PaneID, toCol col: Int, row: Int) {
        guard let (project, _) = self.pane(pane), project.layout == .grid else { return }
        let ids = project.visiblePanes.map(\.id.rawValue)
        let grid = effectiveGrid(of: project).moving(ids, pane.rawValue, toCol: col, row: row)
        updateProject(project.id) { $0.activeArrangement.gridLayout = grid }
    }

    /// Grows a grid pane over the free slots next to it.
    public mutating func fillFreeSpace(_ pane: PaneID) {
        guard let (project, _) = self.pane(pane), project.layout == .grid else { return }
        let ids = project.visiblePanes.map(\.id.rawValue)
        let grid = effectiveGrid(of: project).fillingFreeSpace(ids, pane.rawValue)
        updateProject(project.id) { $0.activeArrangement.gridLayout = grid }
    }
}

extension Project {
    /// The grid the shown panes sit in: the saved grid fitted to them, or rows of two.
    public var effectiveGrid: CustomGrid {
        let ids = visiblePanes.map(\.id.rawValue)
        return activeArrangement.gridLayout?.reconciled(ids) ?? .auto(ids)
    }
}
