import Foundation
import Testing
@testable import AletheModel

/// Where a dragged item lands for each spot under the pointer (the web's collision rules plus the extra
/// insertion zones that make reordering work from anywhere inside a group's area).
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
            doc.updateGroup(inner) { $0.isCollapsed = true }
        }
    }

    // Column as logged from the app (257 wide); y values are the top of each row's cell.
    //   0 header Outer   43 header Inner (collapsed, child of Outer)   86 First   117 First's 2 terminals
    // 173 Second        204 header Other                              247 Foreign   278 Loose (ungrouped)
    private func header(_ group: GroupID, y: CGFloat, x: CGFloat = 15, width: CGFloat = 213) -> SidebarDropRegion {
        SidebarDropRegion(target: .groupHeader(group), hit: CGRect(x: x, y: y, width: width, height: 43),
                          visual: CGRect(x: x, y: y + 20, width: width, height: 21))
    }

    private func project(_ id: ProjectID, y: CGFloat) -> SidebarDropRegion {
        SidebarDropRegion(target: .project(id), hit: CGRect(x: 24, y: y, width: 204, height: 31),
                          visual: CGRect(x: 24, y: y + 5, width: 204, height: 25))
    }

    private func column(_ f: Fixture) -> [SidebarDropRegion] {
        let terminals = CGRect(x: 24, y: 117, width: 204, height: 56)
        return [header(f.outer, y: 0), header(f.inner, y: 43, x: 24, width: 204), project(f.first, y: 86),
                SidebarDropRegion(target: .terminals(f.first), hit: terminals, visual: terminals),
                project(f.second, y: 173), header(f.other, y: 204), project(f.foreign, y: 247),
                project(f.loose, y: 278)]
    }

    private func plan(_ source: SidebarWebDropRules.Source, _ f: Fixture, x: CGFloat = 90, y: CGFloat) -> SidebarDropPlan? {
        SidebarWebDropRules.plan(source, regions: column(f), at: CGPoint(x: x, y: y), width: 257, in: f.doc)
    }

    private func place(_ plan: SidebarDropPlan?) -> (SidebarChild, GroupID?, SidebarChild?)? {
        guard case .place(let item, let container, let before)? = plan?.action else { return nil }
        return (item, container, before)
    }

    private func isLine(_ plan: SidebarDropPlan?, _ edge: SidebarDropEdge) -> Bool {
        if case .line(_, let found, _)? = plan?.mark { return found == edge }
        return false
    }

    // MARK: - A project is dragged

    @Test func aProjectGoesBeforeOrAfterARowInThatRowsGroup() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.loose))
        let upper = plan(source, f, y: 92)
        let target = try #require(place(upper))
        #expect(target.0 == .project(f.loose) && target.1 == f.outer && target.2 == .project(f.first))
        #expect(isLine(upper, .before))
        // The lower half goes before whatever follows: First is followed by Second (its terminals are not siblings),
        // and the line sits under First's terminals because that is where the item will be.
        let lowerPlan = plan(source, f, y: 112)
        let lower = place(lowerPlan)
        #expect(lower?.1 == f.outer && lower?.2 == .project(f.second))
        if case .line(let rect, .after, _)? = lowerPlan?.mark { #expect(rect.maxY == 173) } else { Issue.record("expected a line") }
        // Last row of the group: after it means the end of the group.
        let last = place(plan(source, f, y: 200))
        #expect(last?.1 == f.outer && last?.2 == nil)
    }

    @Test func overTheTerminalsOfAProjectMeansAfterItsWholeNode() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.loose))
        let result = plan(source, f, y: 140)
        let target = try #require(place(result))
        #expect(target.1 == f.outer && target.2 == .project(f.second))
        guard case .line(let rect, .after, _)? = result?.mark else { Issue.record("expected a line"); return }
        // The line sits under the last terminal, not under the project row.
        #expect(rect.maxY == 173 && rect.minY == 91)
    }

    @Test func aProjectIntoAHeaderOnlyFromTheHeaderBand() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.loose))
        let into = try #require(place(plan(source, f, y: 230)))
        #expect(into.1 == f.other && into.2 == nil)
        // The margin above a top-level header lies between two groups: the web leaves it without a target.
        #expect(plan(source, f, y: 210) == nil)
    }

    @Test func aHeaderNestedInAGroupAlsoHasABeforeZone() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.project(f.loose))
        let before = try #require(place(plan(source, f, y: 64)))
        #expect(before.1 == f.outer && before.2 == .group(f.inner))
        let inside = try #require(place(plan(source, f, y: 78)))
        #expect(inside.1 == f.inner && inside.2 == nil)
    }

    @Test func aProjectIgnoresItself() {
        let f = Fixture()
        #expect(plan(.item(.project(f.first)), f, y: 100) == nil)
        #expect(plan(.item(.project(f.first)), f, y: 140) == nil)
    }

    // MARK: - A group is dragged

    @Test func aGroupCanSitBetweenAndAfterTheProjectsOfItsParent() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.group(f.inner))
        let between = try #require(place(plan(source, f, y: 92)))
        #expect(between.0 == .group(f.inner) && between.1 == f.outer && between.2 == .project(f.first))
        let afterLast = try #require(place(plan(source, f, y: 200)))
        #expect(afterLast.1 == f.outer && afterLast.2 == nil)
    }

    @Test func aGroupOverAProjectRowOfAnotherGroupGoesIntoThatGroup() throws {
        let f = Fixture()
        let target = try #require(place(plan(.item(.group(f.other)), f, y: 92)))
        #expect(target.0 == .group(f.other) && target.1 == f.outer && target.2 == .project(f.first))
        // Its own area is off limits.
        #expect(plan(.item(.group(f.other)), f, y: 260) == nil)
    }

    @Test func aGroupOverAnExpandedHeaderGoesBeforeItOrBecomesItsFirstChild() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.group(f.other))
        let before = try #require(place(plan(source, f, y: 28)))
        #expect(before.1 == nil && before.2 == .group(f.outer))
        let firstChild = plan(source, f, y: 38)
        let into = try #require(place(firstChild))
        #expect(into.1 == f.outer && into.2 == .group(f.inner))
        guard case .line(_, .after, let indent)? = firstChild?.mark else { Issue.record("expected a line"); return }
        #expect(indent == 9)   // the child rows start 9pt to the right of the header
    }

    @Test func theMarginBetweenTwoGroupsMeansBeforeTheLowerOne() throws {
        let f = Fixture()
        let result = try #require(place(plan(.item(.group(f.outer)), f, y: 210)))
        #expect(result.1 == nil && result.2 == .group(f.other))
    }

    @Test func aCollapsedHeaderHasBeforeIntoAndAfterZones() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.group(f.other))
        let before = try #require(place(plan(source, f, y: 64)))
        #expect(before.1 == f.outer && before.2 == .group(f.inner))
        let into = try #require(place(plan(source, f, y: 74)))
        #expect(into.1 == f.inner && into.2 == nil)
        let after = try #require(place(plan(source, f, y: 82)))
        #expect(after.1 == f.outer && after.2 == .project(f.first))
    }

    @Test func aGroupOverAnUngroupedProjectGoesToTheEndOfTheTopLevelGroups() throws {
        let f = Fixture()
        let result = plan(.item(.group(f.inner)), f, y: 290)
        let target = try #require(place(result))
        #expect(target.1 == nil && target.2 == nil)
        #expect(isLine(result, .before))
    }

    @Test func aGroupNeverLandsInsideItself() {
        let f = Fixture()
        // Outer's own header, its descendants and its projects.
        for y in [10, 38, 64, 100, 140, 190] as [CGFloat] { #expect(plan(.item(.group(f.outer)), f, y: y) == nil) }
    }

    // MARK: - Terminals, Finder folders, edges of the surface

    @Test func aTerminalOnlyLandsOnAnotherProject() throws {
        let f = Fixture()
        let source = SidebarWebDropRules.Source.item(.pane(f.pane))
        let over = try #require(plan(source, f, y: 262))
        #expect(over.action == .movePane(f.pane, to: f.foreign) && over.fill == .project(f.foreign))
        #expect(plan(source, f, y: 100) == nil)
        #expect(plan(source, f, y: 140) == nil)
        #expect(plan(source, f, y: 230) == nil)
    }

    @Test func finderFoldersGoToTheContainerUnderThePointer() throws {
        let f = Fixture()
        #expect(plan(.files, f, y: 100)?.action == .addFolders(container: f.outer))
        #expect(plan(.files, f, y: 230)?.action == .addFolders(container: f.other))
        #expect(plan(.files, f, y: 290)?.action == .addFolders(container: nil))
        #expect(plan(.files, f, y: 400)?.action == .addFolders(container: nil))
    }

    @Test func belowTheLastRowMeansTheEndOfTheTopLevel() throws {
        let f = Fixture()
        let project = try #require(place(plan(.item(.project(f.first)), f, y: 500)))
        #expect(project.1 == nil && project.2 == nil)
        #expect(plan(.item(.pane(f.pane)), f, y: 500) == nil)
    }

    @Test func outsideTheListNothingHappens() {
        let f = Fixture()
        #expect(plan(.item(.project(f.loose)), f, x: -4, y: 100) == nil)
        #expect(plan(.item(.project(f.loose)), f, x: 300, y: 100) == nil)
    }

    @Test func rowsAreHitAcrossTheWholeWidth() throws {
        let f = Fixture()
        let target = try #require(place(plan(.item(.project(f.loose)), f, x: 2, y: 100)))
        #expect(target.2 == .project(f.first))
    }

    // MARK: - Plans applied to the document

    private func apply(_ plan: SidebarDropPlan?, to doc: inout WorkspaceDocument) {
        guard case .place(let item, let container, let before)? = plan?.action else {
            Issue.record("expected a placement")
            return
        }
        doc.place(item, in: container, before: before)
    }

    @Test func droppingAGroupBelowTheProjectsOfItsParentKeepsItThere() {
        var f = Fixture()
        apply(plan(.item(.group(f.inner)), f, y: 200), to: &f.doc)
        #expect(f.doc.sidebarChildren(of: f.outer) == [.project(f.first), .project(f.second), .group(f.inner)])
        #expect(f.doc.group(f.inner)?.parentID == f.outer)
        #expect(f.doc.group(f.outer)?.projectIDs == [f.first, f.second])
    }

    @Test func droppingAProjectBetweenSubgroupsAndProjects() {
        var f = Fixture()
        apply(plan(.item(.project(f.loose)), f, y: 64), to: &f.doc)   // before the collapsed Inner header
        #expect(f.doc.sidebarChildren(of: f.outer) == [.project(f.loose), .group(f.inner), .project(f.first), .project(f.second)])
        #expect(f.doc.ungroupedProjectIDs.isEmpty)
    }

    @Test func droppingAProjectUnderTheTerminalsOfAnother() {
        var f = Fixture()
        apply(plan(.item(.project(f.loose)), f, y: 140), to: &f.doc)
        #expect(f.doc.sidebarChildren(of: f.outer) == [.group(f.inner), .project(f.first), .project(f.loose), .project(f.second)])
    }

    @Test func droppingAGroupBetweenProjectsOfAnotherGroup() {
        var f = Fixture()
        apply(plan(.item(.group(f.other)), f, y: 120 - 20), to: &f.doc)   // upper half of First's row
        #expect(f.doc.sidebarChildren(of: f.outer) == [.group(f.inner), .group(f.other), .project(f.first), .project(f.second)])
        #expect(f.doc.group(f.other)?.parentID == f.outer)
        #expect(f.doc.group(f.other)?.projectIDs == [f.foreign])
    }

    @Test func aGroupMovedAboveAnotherTopLevelGroupBecomesItsSibling() {
        var f = Fixture()
        apply(plan(.item(.group(f.other)), f, y: 28), to: &f.doc)   // upper half of the Outer header
        #expect(f.doc.sidebarChildren(of: nil).prefix(2) == [.group(f.other), .group(f.outer)])
    }
}
