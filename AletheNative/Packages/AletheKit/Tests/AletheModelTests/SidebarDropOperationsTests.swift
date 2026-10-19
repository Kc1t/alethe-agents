import Foundation
import Testing
@testable import AletheModel

@Suite struct SidebarDropOperationsTests {
    @Test func projectEdgesAccountForSourceRemovalInBothDirections() {
        for grouped in [false, true] {
            for (source, target, edge, expected) in [
                (0, 2, SidebarDropEdge.before, [1, 0, 2]),
                (0, 2, .after, [1, 2, 0]),
                (2, 0, .before, [2, 0, 1]),
                (2, 0, .after, [0, 2, 1]),
                (0, 0, .after, [0, 1, 2])
            ] {
                var doc = WorkspaceDocument()
                let group = doc.addGroup(name: "Group")
                let ids = (0..<3).map { doc.addProject(name: "P\($0)", folder: "/\($0)",
                    in: grouped ? .group(group) : .ungrouped) }
                doc.dropProject(ids[source], beside: ids[target], edge: edge)
                let actual = grouped ? doc.group(group)?.projectIDs : doc.ungroupedProjectIDs
                #expect(actual == expected.map { ids[$0] })
            }
        }
    }

    @Test func projectsMoveAcrossGroupsAndOutToUngrouped() {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A")
        let b = doc.addGroup(name: "B")
        let first = doc.addProject(name: "First", folder: "/first", in: .group(a))
        let second = doc.addProject(name: "Second", folder: "/second", in: .group(b))
        let root = doc.addProject(name: "Root", folder: "/root")
        doc.dropProject(first, beside: second, edge: .after)
        #expect(doc.group(a)?.projectIDs.isEmpty == true)
        #expect(doc.group(b)?.projectIDs == [second, first])
        doc.dropProject(first, beside: root, edge: .before)
        #expect(doc.ungroupedProjectIDs == [first, root])
        #expect(doc.group(b)?.projectIDs == [second])
        doc.moveProject(second, to: .ungrouped, at: Int.max)
        #expect(doc.ungroupedProjectIDs == [first, root, second])
        let placed = doc.ungroupedProjectIDs + doc.groups.flatMap(\.projectIDs)
        #expect(placed.count == Set(placed).count)
        #expect(Set(placed) == Set(doc.projects.map(\.id)))
    }

    @Test func groupEdgesReorderWithoutDoubleSubtracting() {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A")
        let b = doc.addGroup(name: "B")
        let c = doc.addGroup(name: "C")
        doc.dropGroup(a, beside: c, edge: .before)
        #expect(doc.childGroups(of: nil).map(\.id) == [b, a, c])
        doc.dropGroup(b, beside: c, edge: .after)
        #expect(doc.childGroups(of: nil).map(\.id) == [a, c, b])
        doc.dropGroup(b, beside: a, edge: .before)
        #expect(doc.childGroups(of: nil).map(\.id) == [b, a, c])
    }

    @Test func nestingUnnestingAndCycleRejectionPreserveSubtrees() throws {
        var doc = WorkspaceDocument()
        let root = doc.addGroup(name: "Root")
        let child = doc.addGroup(name: "Child", parent: root)
        let grandchild = doc.addGroup(name: "Grandchild", parent: child)
        let other = doc.addGroup(name: "Other")
        let project = doc.addProject(name: "Project", folder: "/project", in: .group(grandchild))
        let original = doc
        doc.dropGroup(root, beside: root, edge: .inside)
        doc.dropGroup(root, beside: grandchild, edge: .inside)
        doc.dropGroup(root, beside: grandchild, edge: .before)
        #expect(doc == original)
        doc.dropGroup(child, beside: other, edge: .inside)
        #expect(doc.group(child)?.parentID == other)
        #expect(doc.group(grandchild)?.parentID == child)
        #expect(doc.location(of: project) == .group(grandchild))
        doc.dropGroup(child, beside: root, edge: .after)
        #expect(doc.childGroups(of: nil).map(\.id) == [root, child, other])
        #expect(doc.group(grandchild)?.parentID == child)
        let roundTrip = try JSONDecoder().decode(WorkspaceDocument.self, from: JSONEncoder().encode(doc))
        #expect(roundTrip.groups == doc.groups)
        #expect(roundTrip.ungroupedProjectIDs == doc.ungroupedProjectIDs)
    }

    @Test func invalidTargetsDoNotDetachItems() {
        var doc = WorkspaceDocument()
        let project = doc.addProject(name: "Project", folder: "/project")
        let group = doc.addGroup(name: "Group")
        let original = doc
        doc.dropProject(project, beside: .make(), edge: .after)
        doc.dropGroup(group, beside: .make(), edge: .inside)
        doc.moveProject(project, to: .group(.make()), at: 0)
        #expect(doc == original)
    }

    @Test func movingPanePreservesAllTabsAndRejectsSameProject() throws {
        var doc = WorkspaceDocument()
        let a = doc.addProject(name: "A", folder: "/a")
        let b = doc.addProject(name: "B", folder: "/b")
        let tab = PaneTab(agent: "shell", sessionID: "session")
        let added = doc.addPane(to: a, tab: tab)
        let pane = try #require(added)
        doc.addTab(PaneTab(agent: "codex", sessionID: "agent-session"), to: pane)
        let original = try #require(doc.pane(pane)?.pane)
        doc.moveWebPane(pane, to: a)
        #expect(doc.pane(pane)?.pane == original)
        doc.moveWebPane(pane, to: b)
        #expect(doc.project(a)?.panes.isEmpty == true)
        #expect(doc.pane(pane)?.project.id == b)
        #expect(doc.pane(pane)?.pane.tabs == original.tabs)
        #expect(doc.pane(pane)?.pane.activeTabID == original.activeTabID)
        doc.moveWebPane(pane, to: .make())
        #expect(doc.pane(pane)?.project.id == b)
    }
}
