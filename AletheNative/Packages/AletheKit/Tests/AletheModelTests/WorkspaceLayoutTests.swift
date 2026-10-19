import CoreGraphics
import Testing
@testable import AletheModel

@Suite struct AutoLayoutTests {
    @Test func matchesUpstreamAutoRule() {
        #expect(AutoLayout.rows(for: 0) == [])
        #expect(AutoLayout.rows(for: 1) == [1])
        #expect(AutoLayout.rows(for: 2) == [2])
        #expect(AutoLayout.rows(for: 3) == [2, 1])
        #expect(AutoLayout.rows(for: 4) == [2, 2])
        #expect(AutoLayout.rows(for: 5) == [2, 2, 1])
    }
}

@Suite struct TrackMathTests {
    @Test func equalTracksWhenWeightsAreMissingOrWrong() {
        #expect(TrackMath.sizes(count: 2, weights: [], total: 210, gap: 10) == [100, 100])
        #expect(TrackMath.sizes(count: 2, weights: [1, 2, 3], total: 210, gap: 10) == [100, 100])
        #expect(TrackMath.sizes(count: 2, weights: [0, 1], total: 210, gap: 10) == [100, 100])
    }

    @Test func weightsSplitTheSpaceLeftByGaps() {
        #expect(TrackMath.sizes(count: 2, weights: [0.25, 0.75], total: 410, gap: 10) == [100, 300])
        #expect(TrackMath.offsets([100, 300], gap: 10, origin: 5) == [5, 115])
    }

    @Test func dragMovesTheSharedBoundary() {
        #expect(TrackMath.drag([100, 300], divider: 0, delta: 50, minimum: 40) == [150, 250])
        #expect(TrackMath.drag([100, 100, 100], divider: 1, delta: -30, minimum: 40) == [100, 70, 130])
    }

    @Test func dragStopsAtTheMinimumWithoutRubberBand() {
        #expect(TrackMath.drag([100, 300], divider: 0, delta: -90, minimum: 40) == [40, 360])
        #expect(TrackMath.drag([100, 300], divider: 0, delta: 290, minimum: 40) == [360, 40])
    }

    @Test func rubberBandGivesPastTheMinimumWithResistance() {
        let band: (CGFloat, CGFloat) -> CGFloat = { overshoot, dimension in
            (overshoot * dimension * 0.55) / (dimension + 0.55 * abs(overshoot))
        }
        let sizes = TrackMath.drag([100, 300], divider: 0, delta: -90, minimum: 40, rubberBand: band)
        #expect(sizes[0] < 40 && sizes[0] > 10, "gives, but less than the pointer moved")
        #expect(sizes[0] + sizes[1] == 400)
        let further = TrackMath.drag([100, 300], divider: 0, delta: -200, minimum: 40, rubberBand: band)
        #expect(further[0] < sizes[0] && further[0] > 0, "keeps giving, never collapses")
    }

    @Test func weightsAreFractions() {
        #expect(TrackMath.weights([100, 300]) == [0.25, 0.75])
        #expect(TrackMath.weights([]) == [])
    }
}

@Suite struct PaneGridGeometryTests {
    let rect = CGRect(x: 0, y: 0, width: 410, height: 310)

    @Test func onePaneFillsTheArea() {
        let geometry = PaneGridGeometry(count: 1, in: rect, weights: GridWeights(), gap: 10, handle: 6)
        #expect(geometry.paneFrames == [rect])
        #expect(geometry.dividers.isEmpty)
    }

    @Test func twoPanesSitSideBySide() {
        let geometry = PaneGridGeometry(count: 2, in: rect, weights: GridWeights(), gap: 10, handle: 6)
        #expect(geometry.paneFrames == [CGRect(x: 0, y: 0, width: 200, height: 310),
                                        CGRect(x: 210, y: 0, width: 200, height: 310)])
        #expect(geometry.dividers[.column(row: 0)] == CGRect(x: 202, y: 0, width: 6, height: 310))
    }

    @Test func anOddLastPaneSpansItsRow() {
        let geometry = PaneGridGeometry(count: 3, in: rect,
                                        weights: GridWeights(columns: [0.25, 0.75], rows: [2, 1]), gap: 10, handle: 6)
        #expect(geometry.paneFrames == [CGRect(x: 0, y: 0, width: 100, height: 200),
                                        CGRect(x: 110, y: 0, width: 300, height: 200),
                                        CGRect(x: 0, y: 210, width: 410, height: 100)])
        #expect(Set(geometry.dividers.keys) == [.column(row: 0), .row(0)])
        #expect(geometry.dividers[.row(0)] == CGRect(x: 0, y: 202, width: 410, height: 6))
    }
}

/// Spotlight and Sidebar (P2-18, upstream `SpotlightLayout` / `SidebarLayout`).
@Suite struct PaneLayoutModeTests {
    let rect = CGRect(x: 0, y: 0, width: 410, height: 310)

    @Test func spotlightPutsTheFirstPaneLargeOnTheLeft() {
        let geometry = PaneGridGeometry(count: 3, in: rect, weights: GridWeights(), gap: 10, handle: 6, mode: .spotlight)
        #expect(geometry.paneFrames.count == 3)
        #expect(geometry.paneFrames[0] == CGRect(x: 0, y: 0, width: 260, height: 310))
        #expect(geometry.paneFrames[1] == CGRect(x: 270, y: 0, width: 140, height: 150))
        #expect(geometry.paneFrames[2] == CGRect(x: 270, y: 160, width: 140, height: 150))
        #expect(Set(geometry.dividers.keys) == [.column(row: 0), .row(0)])
        #expect(geometry.dividers[.row(0)]?.minX == 270, "stack dividers span only the stack")
    }

    @Test func sidebarPutsTheFirstPaneLargeOnTheRight() {
        let geometry = PaneGridGeometry(count: 2, in: rect, weights: GridWeights(), gap: 10, handle: 6, mode: .sidebar)
        #expect(geometry.paneFrames[0].minX > geometry.paneFrames[1].minX)
        #expect(geometry.paneFrames[1].width < geometry.paneFrames[0].width)
        #expect(geometry.paneFrames[1].height == 310)
        #expect(Set(geometry.dividers.keys) == [.column(row: 0)])
    }

    @Test func onePaneFillsTheAreaInEveryMode() {
        for mode in PaneLayoutMode.allCases {
            let geometry = PaneGridGeometry(count: 1, in: rect, weights: GridWeights(), gap: 10, handle: 6, mode: mode)
            #expect(geometry.paneFrames == [rect])
        }
    }

    @Test func customColumnWeightsWin() {
        let weights = GridWeights(columns: [0.5, 0.5])
        let geometry = PaneGridGeometry(count: 2, in: rect, weights: weights, gap: 10, handle: 6, mode: .spotlight)
        #expect(geometry.paneFrames[0].width == 200)
    }

    @Test func changingTheModeResetsTrackSizes() {
        var doc = WorkspaceDocument()
        let id = doc.addProject(name: "a", folder: "/a")
        doc.workspace.gridWeights[id.rawValue] = GridWeights(columns: [0.3, 0.7])
        doc.setLayoutMode(.spotlight, for: id)
        #expect(doc.project(id)?.layout == .spotlight)
        #expect(doc.workspace.gridWeights[id.rawValue] == nil)
        doc.setLayoutMode(.auto, for: id)
        #expect(doc.project(id)?.layoutMode == nil, "Auto is stored as absent")
    }
}

@Suite struct FlushPaneGeometryTests {
    @Test func cleanSplitHandlesOverlapOnlyFourPointsOnEachSide() {
        let rect = CGRect(x: 0, y: 0, width: 411, height: 311)
        for mode in [PaneLayoutMode.auto, .spotlight, .sidebar] {
            let geometry = PaneGridGeometry(count: 4, in: rect, weights: GridWeights(), gap: 0, handle: 8, mode: mode)
            let column = geometry.dividers[.column(row: 0)]!
            #expect(column.width == 8)
            for frame in geometry.paneFrames {
                #expect(rect.contains(frame))
                #expect(frame.width > 0 && frame.height > 0)
            }
            let left = geometry.paneFrames.filter { $0.maxX <= column.midX }.map(\.maxX).max()!
            let right = geometry.paneFrames.filter { $0.minX >= column.midX }.map(\.minX).min()!
            #expect(abs(left - right) < 0.000001)
            #expect(abs(column.minX - (left - 4)) < 0.000001)
        }
    }

    @Test func webGridHandlesStayInsideLeadingCellsAndRespectSpans() {
        let grid = CustomGrid(cols: 2, rows: 2, cells: [
            "a": GridCell(col: 1, row: 1, colSpan: 2),
            "b": GridCell(col: 1, row: 2),
        ])
        let geometry = PaneGridGeometry(count: 2, in: CGRect(x: 0, y: 0, width: 400, height: 300),
                                        weights: GridWeights(), gap: 0, handle: 8, mode: .grid,
                                        grid: grid, ids: ["a", "b"], handlesInsideLeadingCell: true)
        #expect(geometry.paneFrames[0] == CGRect(x: 0, y: 0, width: 400, height: 150))
        #expect(geometry.paneFrames[1] == CGRect(x: 0, y: 150, width: 200, height: 150))
        #expect(geometry.dividers[.gridColumn(boundary: 0, segment: 0)] == CGRect(x: 192, y: 150, width: 8, height: 150))
        #expect(geometry.dividers[.gridRow(boundary: 0, segment: 0)] == CGRect(x: 0, y: 142, width: 400, height: 8))
        #expect(geometry.freeSlots.first?.frame == CGRect(x: 200, y: 150, width: 200, height: 150))
    }
}
