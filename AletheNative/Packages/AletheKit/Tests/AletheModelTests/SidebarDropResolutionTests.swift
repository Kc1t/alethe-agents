import Foundation
import Testing
@testable import AletheModel

@Suite struct SidebarDropResolutionTests {
    @Test func specificRowsBeatOverlappingContainersRegardlessOfArea() {
        let pointer = CGPoint(x: 40, y: 45)
        let candidates = [
            SidebarDropCandidate(bounds: CGRect(x: 20, y: 40, width: 80, height: 10), rank: 1),
            SidebarDropCandidate(bounds: CGRect(x: 0, y: 20, width: 200, height: 34), rank: 0)
        ]
        #expect(SidebarDropResolution.winner(at: pointer, candidates: candidates) == 1)
    }

    @Test func innermostGroupBodyWinsAndTiesAreStable() {
        let outer = SidebarDropCandidate(bounds: CGRect(x: 0, y: 0, width: 200, height: 200), rank: 1)
        let inner = SidebarDropCandidate(bounds: CGRect(x: 10, y: 40, width: 190, height: 70), rank: 1)
        #expect(SidebarDropResolution.winner(at: CGPoint(x: 30, y: 60), candidates: [outer, inner, inner]) == 1)
        #expect(SidebarDropResolution.winner(at: CGPoint(x: 30, y: 150), candidates: [outer, inner]) == 0)
    }

    @Test func fullRowPaddingAndAdjacentRowsHaveNoDeadZone() {
        let rows = [
            SidebarDropCandidate(bounds: CGRect(x: 0, y: 0, width: 240, height: 34), rank: 0),
            SidebarDropCandidate(bounds: CGRect(x: 0, y: 34, width: 240, height: 34), rank: 0)
        ]
        for y in 0..<68 {
            #expect(SidebarDropResolution.winner(at: CGPoint(x: 1, y: y), candidates: rows) == (y < 34 ? 0 : 1))
        }
        #expect(SidebarDropResolution.winner(at: CGPoint(x: 1, y: 68), candidates: rows) == nil)
    }

    @Test func edgeUsesVisibleRowRatherThanMarginOrExpandedProjectHeight() {
        let row = CGRect(x: 18, y: 6, width: 220, height: 28)
        #expect(SidebarDropResolution.edge(at: 0, row: row) == .before)
        #expect(SidebarDropResolution.edge(at: 19, row: row) == .before)
        #expect(SidebarDropResolution.edge(at: 20, row: row) == .after)
        #expect(SidebarDropResolution.edge(at: 33, row: row) == .after)
        let header = CGRect(x: 8, y: 22, width: 230, height: 24)
        #expect(SidebarDropResolution.edge(at: 30, row: header) == .before)
        #expect(SidebarDropResolution.edge(at: 34, row: header) == .after)
    }

    @Test func endOfListOnlyWinsBelowTheLastRow() {
        let row = SidebarDropCandidate(bounds: CGRect(x: 0, y: 0, width: 240, height: 34), rank: 0)
        let end = SidebarDropCandidate(bounds: CGRect(x: 0, y: 34, width: 240, height: 300), rank: 1)
        #expect(SidebarDropResolution.winner(at: CGPoint(x: 20, y: 33), candidates: [end, row]) == 1)
        #expect(SidebarDropResolution.winner(at: CGPoint(x: 20, y: 34), candidates: [end, row]) == 0)
        #expect(SidebarDropResolution.winner(at: CGPoint(x: 20, y: 335), candidates: [end, row]) == nil)
        #expect(SidebarDropResolution.winner(at: .zero, candidates: []) == nil)
    }

    @Test func droppingAtRootEndAppendsAlreadyUngroupedItems() {
        var doc = WorkspaceDocument()
        let a = doc.addProject(name: "A", folder: "/a")
        let b = doc.addProject(name: "B", folder: "/b")
        doc.moveProject(a, to: .ungrouped, at: Int.max)
        #expect(doc.ungroupedProjectIDs == [b, a])
        let first = doc.addGroup(name: "First")
        let last = doc.addGroup(name: "Last")
        doc.moveGroup(first, toParent: nil, at: Int.max)
        #expect(doc.childGroups(of: nil).map(\.id) == [last, first])
    }

}
