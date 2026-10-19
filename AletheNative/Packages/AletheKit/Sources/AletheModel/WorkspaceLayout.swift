import CoreGraphics

/// How a project arranges its panes (upstream `LayoutMode`).
public enum PaneLayoutMode: String, Codable, CaseIterable, Sendable {
    /// Rows of two (`AutoLayout`).
    case auto
    /// The first pane large on the left, the others stacked on the right.
    case spotlight
    /// The others stacked in a narrow list on the left, the first pane large on the right.
    case sidebar
    /// The project's custom grid (`Project.gridLayout`, P2-19).
    case grid

    /// Default column shares of the two tracks (upstream panel `defaultSize`).
    var defaultColumns: [Double] {
        switch self {
        case .auto, .grid: []
        case .spotlight: [0.65, 0.35]
        case .sidebar: [0.22, 0.78]
        }
    }
}

/// Upstream's "Auto" layout (`PaneArea.tsx` `AutoLayout`): one pane fills the area, two sit side by
/// side, three or more go in rows of two with an odd last pane spanning its row.
public enum AutoLayout {
    public static func rows(for count: Int) -> [Int] {
        guard count > 0 else { return [] }
        if count <= 2 { return [count] }
        return stride(from: 0, to: count, by: 2).map { min(2, count - $0) }
    }

    public static let columns = 2
}

/// Weighted tracks (columns, rows or containers) separated by fixed gaps.
public enum TrackMath {
    /// Track sizes for `count` tracks sharing `total` minus the gaps. Missing or mismatched weights
    /// mean equal tracks.
    public static func sizes(count: Int, weights: [Double], total: CGFloat, gap: CGFloat) -> [CGFloat] {
        guard count > 0 else { return [] }
        let available = max(0, total - gap * CGFloat(count - 1))
        let usable = weights.count == count && weights.allSatisfy { $0 > 0 && $0.isFinite }
        let effective = usable ? weights : Array(repeating: 1, count: count)
        let sum = effective.reduce(0, +)
        return effective.map { CGFloat($0 / sum) * available }
    }

    /// Where each track starts.
    public static func offsets(_ sizes: [CGFloat], gap: CGFloat, origin: CGFloat = 0) -> [CGFloat] {
        var offsets: [CGFloat] = []
        var position = origin
        for size in sizes {
            offsets.append(position)
            position += size + gap
        }
        return offsets
    }

    /// Moves the boundary after track `divider` by `delta`. Tracks never go below `minimum`; with a
    /// `rubberBand` function (`Motion.rubberBand`), a drag past it gives with progressive resistance
    /// instead of stopping dead, and the caller settles back by calling again without it on release.
    public static func drag(_ sizes: [CGFloat], divider: Int, delta: CGFloat, minimum: CGFloat,
                            rubberBand: ((_ overshoot: CGFloat, _ dimension: CGFloat) -> CGFloat)? = nil) -> [CGFloat] {
        guard sizes.indices.contains(divider), sizes.indices.contains(divider + 1) else { return sizes }
        let pair = sizes[divider] + sizes[divider + 1]
        let floor = min(minimum, pair / 2)
        func resisted(_ size: CGFloat) -> CGFloat {
            guard size < floor else { return size }
            return rubberBand.map { floor - $0(floor - size, floor) } ?? floor
        }
        var leading = sizes[divider] + delta
        if leading < floor {
            leading = resisted(leading)
        } else if pair - leading < floor {
            leading = pair - resisted(pair - leading)
        }
        var result = sizes
        result[divider] = leading
        result[divider + 1] = pair - leading
        return result
    }

    /// Sizes as persisted weights (fractions that sum to 1).
    public static func weights(_ sizes: [CGFloat]) -> [Double] {
        let sum = sizes.reduce(0, +)
        guard sum > 0 else { return [] }
        return sizes.map { Double($0 / sum) }
    }
}

/// Pane frames and resize handles of one project's pane area.
public struct PaneGridGeometry: Equatable, Sendable {
    public enum Divider: Hashable, Sendable {
        /// Between the two columns of `row` (all two-pane rows share the column weights). Spotlight
        /// and Sidebar have one, `row: 0`, between the main pane and the stack.
        case column(row: Int)
        /// Between row `index` and the next one (in Spotlight and Sidebar: of the stack).
        case row(Int)
        /// A custom grid's boundary after column `boundary` (0-based), one piece per run of rows it
        /// separates.
        case gridColumn(boundary: Int, segment: Int)
        /// A custom grid's boundary after row `boundary` (0-based), one piece per run of columns.
        case gridRow(boundary: Int, segment: Int)
    }

    /// A free slot of a custom grid (1-based), where a pane can be dropped.
    public struct Slot: Equatable, Sendable {
        public var col: Int
        public var row: Int
        public var frame: CGRect
    }

    public var paneFrames: [CGRect]
    public var dividers: [Divider: CGRect]
    public var columnSizes: [CGFloat]
    public var rowSizes: [CGFloat]
    public var freeSlots: [Slot] = []

    /// - Parameter handle: thickness of a divider's hit area, centered on its gap.
    /// - Parameter handlesInsideLeadingCell: places custom-grid handles inside right/bottom cell edges.
    public init(count: Int, in rect: CGRect, weights: GridWeights, gap: CGFloat, handle: CGFloat,
                mode: PaneLayoutMode = .auto, grid: CustomGrid? = nil, ids: [String] = [],
                handlesInsideLeadingCell: Bool = false) {
        if mode == .grid, let grid, count > 1 {
            self = Self.custom(grid: grid, ids: ids, in: rect, weights: weights, gap: gap, handle: handle)
            if handlesInsideLeadingCell {
                // Web GridCellHandles lives inside the right/bottom edge of the leading cell.
                for (divider, frame) in dividers {
                    switch divider {
                    case .gridColumn: dividers[divider] = frame.offsetBy(dx: -(handle + gap) / 2, dy: 0)
                    case .gridRow: dividers[divider] = frame.offsetBy(dx: 0, dy: -(handle + gap) / 2)
                    default: break
                    }
                }
            }
            return
        }
        paneFrames = []
        dividers = [:]
        if mode == .spotlight || mode == .sidebar, count > 1 {
            // Two columns: the main pane and a stack of the others (upstream Spotlight/Sidebar).
            let columnWeights = weights.columns.count == 2 ? weights.columns : mode.defaultColumns
            columnSizes = TrackMath.sizes(count: 2, weights: columnWeights, total: rect.width, gap: gap)
            let columnX = TrackMath.offsets(columnSizes, gap: gap, origin: rect.minX)
            let (main, stack) = mode == .spotlight ? (0, 1) : (1, 0)
            rowSizes = TrackMath.sizes(count: count - 1, weights: weights.rows, total: rect.height, gap: gap)
            let rowY = TrackMath.offsets(rowSizes, gap: gap, origin: rect.minY)
            paneFrames.append(CGRect(x: columnX[main], y: rect.minY, width: columnSizes[main], height: rect.height))
            for row in rowSizes.indices {
                paneFrames.append(CGRect(x: columnX[stack], y: rowY[row], width: columnSizes[stack], height: rowSizes[row]))
                if row < rowSizes.count - 1 {
                    let center = rowY[row + 1] - gap / 2
                    dividers[.row(row)] = CGRect(x: columnX[stack], y: center - handle / 2,
                                                 width: columnSizes[stack], height: handle)
                }
            }
            let center = columnX[1] - gap / 2
            dividers[.column(row: 0)] = CGRect(x: center - handle / 2, y: rect.minY, width: handle, height: rect.height)
            return
        }
        let rows = AutoLayout.rows(for: count)
        let twoColumns = rows.contains(2)
        columnSizes = TrackMath.sizes(count: twoColumns ? AutoLayout.columns : 1, weights: weights.columns,
                                      total: rect.width, gap: gap)
        rowSizes = TrackMath.sizes(count: rows.count, weights: weights.rows, total: rect.height, gap: gap)
        let columnX = TrackMath.offsets(columnSizes, gap: gap, origin: rect.minX)
        let rowY = TrackMath.offsets(rowSizes, gap: gap, origin: rect.minY)

        for (row, panes) in rows.enumerated() {
            let y = rowY[row], height = rowSizes[row]
            if panes == 2 {
                paneFrames.append(CGRect(x: columnX[0], y: y, width: columnSizes[0], height: height))
                paneFrames.append(CGRect(x: columnX[1], y: y, width: columnSizes[1], height: height))
                let center = columnX[1] - gap / 2
                dividers[.column(row: row)] = CGRect(x: center - handle / 2, y: y, width: handle, height: height)
            } else {
                paneFrames.append(CGRect(x: rect.minX, y: y, width: rect.width, height: height))
            }
            if row < rows.count - 1 {
                let center = rowY[row + 1] - gap / 2
                dividers[.row(row)] = CGRect(x: rect.minX, y: center - handle / 2, width: rect.width, height: handle)
            }
        }
    }

    /// A custom grid: cells span tracks; dividers only where a boundary separates two different
    /// cells (or a cell and a free slot), so a spanning pane is never crossed by a handle.
    private static func custom(grid: CustomGrid, ids: [String], in rect: CGRect, weights: GridWeights, gap: CGFloat,
                               handle: CGFloat) -> PaneGridGeometry {
        var result = PaneGridGeometry(count: 0, in: rect, weights: GridWeights(), gap: gap, handle: handle)
        let columnSizes = TrackMath.sizes(count: grid.cols, weights: weights.columns.count == grid.cols ? weights.columns : grid.colSizes ?? [],
                                      total: rect.width, gap: gap)
        let rowSizes = TrackMath.sizes(count: grid.rows, weights: weights.rows.count == grid.rows ? weights.rows : grid.rowSizes ?? [],
                                   total: rect.height, gap: gap)
        let columnX = TrackMath.offsets(columnSizes, gap: gap, origin: rect.minX)
        let rowY = TrackMath.offsets(rowSizes, gap: gap, origin: rect.minY)
        func frame(col: Int, row: Int, colSpan: Int, rowSpan: Int) -> CGRect {
            let lastCol = min(grid.cols, col + colSpan - 1), lastRow = min(grid.rows, row + rowSpan - 1)
            return CGRect(x: columnX[col - 1], y: rowY[row - 1],
                          width: columnX[lastCol - 1] + columnSizes[lastCol - 1] - columnX[col - 1],
                          height: rowY[lastRow - 1] + rowSizes[lastRow - 1] - rowY[row - 1])
        }
        result.columnSizes = columnSizes
        result.rowSizes = rowSizes
        result.paneFrames = ids.map { id in
            grid.cells[id].map { frame(col: $0.col, row: $0.row, colSpan: $0.colSpan, rowSpan: $0.rowSpan) } ?? .zero
        }
        let occupancy = grid.occupancy(ids)
        result.freeSlots = grid.freeCells(ids).map { Slot(col: $0.col, row: $0.row, frame: frame(col: $0.col, row: $0.row, colSpan: 1, rowSpan: 1)) }
        func separates(_ a: String?, _ b: String?) -> Bool { a != b && (a != nil || b != nil) }
        for boundary in 0..<max(0, grid.cols - 1) {
            let center = columnX[boundary + 1] - gap / 2
            var segment = 0, start: Int?
            for row in 0...grid.rows {
                let split = row < grid.rows && separates(occupancy[row][boundary], occupancy[row][boundary + 1])
                if split, start == nil { start = row }
                if !split, let first = start {
                    let top = rowY[first], bottom = rowY[row - 1] + rowSizes[row - 1]
                    result.dividers[.gridColumn(boundary: boundary, segment: segment)] =
                        CGRect(x: center - handle / 2, y: top, width: handle, height: bottom - top)
                    segment += 1
                    start = nil
                }
            }
        }
        for boundary in 0..<max(0, grid.rows - 1) {
            let center = rowY[boundary + 1] - gap / 2
            var segment = 0, start: Int?
            for col in 0...grid.cols {
                let split = col < grid.cols && separates(occupancy[boundary][col], occupancy[boundary + 1][col])
                if split, start == nil { start = col }
                if !split, let first = start {
                    let left = columnX[first], right = columnX[col - 1] + columnSizes[col - 1]
                    result.dividers[.gridRow(boundary: boundary, segment: segment)] =
                        CGRect(x: left, y: center - handle / 2, width: right - left, height: handle)
                    segment += 1
                    start = nil
                }
            }
        }
        return result
    }
}
