import Foundation
import Testing
@testable import AletheModel

/// The web sidebar's collision rules (`sidebarCollisionDetection`, `dropIndicatorForEvent`).
@Suite struct SidebarWebDropRulesTests {
    private struct Fixture {
        var doc = WorkspaceDocument()
        let outer: GroupID
        let inner: GroupID
        let other: GroupID
        let first: ProjectID
        let second: ProjectID
        let foreign: ProjectID
        let loose: ProjectID
        let pane: PaneID

        init() {
            outer = doc.addGroup(name: "Outer")
            inner = doc.addGroup(name: "Inner", parent: outer)
            other = doc.addGroup(name: "Other")
            first = doc.addProject(name: "First", folder: "/first", in: .group(outer))
            second = doc.addProject(name: "Second", folder: "/second", in: .group(outer))
            foreign = doc.addProject(name: "Foreign", folder: "/foreign", in: .group(other))
            loose = doc.addProject(name: "Loose", folder: "/loose")
            pane = doc.addPane(to: first, tab: PaneTab(agent: "shell"))!
        }
    }

    private func rank(_ source: SidebarWebDropRules.Source, _ target: SidebarWebDropTarget, _ doc: WorkspaceDocument) -> Int? {
        SidebarWebDropRules.rank(source, over: target, in: doc)
    }

    @Test func projectsLandOnRowsAndGroupHeadersButNeverOnGroupBodies() {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.first))
        #expect(rank(source, .project(f.second), f.doc) == 0)
        #expect(rank(source, .project(f.first), f.doc) == nil)
        #expect(rank(source, .groupHeader(f.other), f.doc) == 1)
        #expect(rank(source, .groupHeader(f.outer), f.doc) == 1)
        #expect(rank(source, .ungrouped, f.doc) == 1)
        #expect(rank(source, .groupBody(f.other), f.doc) == nil)
    }

    @Test func groupsReorderOnHeadersAndNestInBodiesButNeverIntoThemselves() {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.group(f.outer))
        #expect(rank(source, .groupHeader(f.other), f.doc) == 0)
        #expect(rank(source, .groupBody(f.other), f.doc) == 1)
        #expect(rank(source, .ungrouped, f.doc) == 1)
        #expect(rank(source, .groupHeader(f.outer), f.doc) == nil)
        #expect(rank(source, .groupBody(f.outer), f.doc) == nil)
        #expect(rank(source, .groupHeader(f.inner), f.doc) == nil)
        #expect(rank(source, .groupBody(f.inner), f.doc) == nil)
        #expect(rank(source, .project(f.loose), f.doc) == nil)
        // A nested group may still move out next to its parent's siblings or into another group.
        let nested = SidebarWebDropRules.Source.item(.group(f.inner))
        #expect(rank(nested, .groupHeader(f.outer), f.doc) == 0)
        #expect(rank(nested, .groupBody(f.outer), f.doc) == 1)
    }

    @Test func aTerminalOnlyLandsOnAnotherProject() {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.pane(f.pane))
        #expect(rank(source, .project(f.foreign), f.doc) == 0)
        #expect(rank(source, .project(f.first), f.doc) == nil)
        #expect(rank(source, .groupHeader(f.other), f.doc) == nil)
        #expect(rank(source, .ungrouped, f.doc) == nil)
    }

    @Test func finderFoldersAcceptEveryContainer() {
        let f = Fixture()
        #expect(rank(.files, .project(f.first), f.doc) == 0)
        #expect(rank(.files, .groupHeader(f.other), f.doc) == 0)
        #expect(rank(.files, .groupBody(f.other), f.doc) == 1)
        #expect(rank(.files, .ungrouped, f.doc) == 1)
    }

    private let row = SidebarDropRegion(target: .ungrouped, hit: CGRect(x: 24, y: 100, width: 204, height: 31),
                                        visual: CGRect(x: 24, y: 105, width: 204, height: 25))

    @Test func edgesFollowTheElementMidpointOnlyWhereTheWebDoes() {
        let f = Fixture()
        let project = SidebarDropRegion(target: .project(f.second), hit: row.hit, visual: row.visual)
        let header = SidebarDropRegion(target: .groupHeader(f.other), hit: row.hit, visual: row.visual)
        let body = SidebarDropRegion(target: .groupBody(f.other), hit: row.hit, visual: row.visual)
        let midY = row.visual.midY
        for (source, region, above, below) in [
            (SidebarWebDropRules.Source.item(.project(f.first)), project, SidebarDropEdge.before, SidebarDropEdge.after),
            (.item(.group(f.outer)), header, .before, .after),
            (.item(.project(f.first)), header, .inside, .inside),
            (.item(.group(f.outer)), body, .inside, .inside),
            (.item(.pane(f.pane)), project, .inside, .inside),
            (.files, project, .inside, .inside),
        ] {
            #expect(SidebarWebDropRules.edge(source, over: region, pointerY: midY - 1) == above)
            #expect(SidebarWebDropRules.edge(source, over: region, pointerY: midY + 1) == below)
        }
    }

    // MARK: - Resolution on a realistic column (257 wide, as logged from the app)

    private func header(_ group: GroupID, y: CGFloat) -> SidebarDropRegion {
        SidebarDropRegion(target: .groupHeader(group), hit: CGRect(x: 15, y: y, width: 213, height: 43),
                          visual: CGRect(x: 15, y: y + 20, width: 213, height: 21))
    }

    private func project(_ id: ProjectID, y: CGFloat) -> SidebarDropRegion {
        SidebarDropRegion(target: .project(id), hit: CGRect(x: 24, y: y, width: 204, height: 31),
                          visual: CGRect(x: 24, y: y + 5, width: 204, height: 25))
    }

    private func body(_ group: GroupID, y: CGFloat, height: CGFloat) -> SidebarDropRegion {
        let rect = CGRect(x: 17, y: y, width: 210, height: height)
        return SidebarDropRegion(target: .groupBody(group), hit: rect, visual: rect)
    }

    private func column(_ f: Fixture) -> [SidebarDropRegion] {
        [header(f.outer, y: 0), header(f.inner, y: 43), project(f.first, y: 86), project(f.second, y: 117),
         body(f.outer, y: 43, height: 105), header(f.other, y: 160), project(f.foreign, y: 203),
         body(f.other, y: 203, height: 31)]
    }

    private func resolve(_ source: SidebarWebDropRules.Source, _ f: Fixture, x: CGFloat = 90, y: CGFloat)
        -> (SidebarWebDropTarget, SidebarDropEdge)? {
        SidebarWebDropRules.resolve(source, regions: column(f), at: CGPoint(x: x, y: y), width: 257, in: f.doc)
            .map { ($0.region.target, $0.edge) }
    }

    @Test func aProjectOverARowReordersAndOverAHeaderMovesInside() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.loose))
        let upper = try #require(resolve(source, f, y: 90))
        #expect(upper.0 == .project(f.first) && upper.1 == .before)
        let lower = try #require(resolve(source, f, y: 112))
        #expect(lower.0 == .project(f.first) && lower.1 == .after)
        let onHeader = try #require(resolve(source, f, y: 185))
        #expect(onHeader.0 == .groupHeader(f.other) && onHeader.1 == .inside)
    }

    @Test func aProjectIsNotDroppedInTheMarginAboveAHeaderOrInsideABodyGap() {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.loose))
        // y 165 is the 20pt margin above the "Other" header: between groups, no target in the web.
        #expect(resolve(source, f, y: 165) == nil)
        #expect(resolve(source, f, x: 3, y: 500) == nil)
    }

    @Test func aGroupOverARowNestsIntoTheRowsGroup() throws {
        let f = Fixture()
        let hit = try #require(resolve(.item(.group(f.other)), f, y: 100))
        #expect(hit.0 == .groupBody(f.outer) && hit.1 == .inside)
    }

    @Test func aGroupOverAHeaderReordersAndTheMarginAboveItCountsAsBefore() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.group(f.other))
        let after = try #require(resolve(source, f, y: 40))
        #expect(after.0 == .groupHeader(f.outer) && after.1 == .after)
        let marginAbove = try #require(resolve(source, f, y: 5))
        #expect(marginAbove.0 == .groupHeader(f.outer) && marginAbove.1 == .before)
    }

    @Test func theHeaderBeatsTheBodyItSitsIn() throws {
        let f = Fixture()
        // The nested header lies inside the outer body (rank 1) but has rank 0 for a group.
        let hit = try #require(resolve(.item(.group(f.other)), f, y: 70))
        #expect(hit.0 == .groupHeader(f.inner))
    }

    @Test func rowsAreHitAcrossTheWholeWidth() throws {
        let f = Fixture()
        let hit = try #require(resolve(.item(.project(f.loose)), f, x: 2, y: 100))
        #expect(hit.0 == .project(f.first))
        #expect(resolve(.item(.project(f.loose)), f, x: 300, y: 100) == nil)
    }

    @Test func aTerminalOnlyHighlightsOtherProjects() throws {
        let f = Fixture()
        let over = try #require(resolve(.item(.pane(f.pane)), f, y: 210))
        #expect(over.0 == .project(f.foreign) && over.1 == .inside)
        #expect(resolve(.item(.pane(f.pane)), f, y: 100) == nil)
    }
}
