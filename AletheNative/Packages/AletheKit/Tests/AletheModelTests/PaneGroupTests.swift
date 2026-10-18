import Foundation
import Testing
@testable import AletheModel

@Suite struct PaneGroupTests {
    @Test func webJSONRoundTripsIncludingOrchestrationMetadata() throws {
        let data = Data(#"{"id":"stack","paneIds":["terminal","board"],"kind":"orchestration","plannerId":"terminal"}"#.utf8)
        let group = try JSONDecoder().decode(PaneGroup.self, from: data)
        #expect(group.paneIds.map(\.rawValue) == ["terminal", "board"])
        #expect(group.plannerId?.rawValue == "terminal")
        #expect(try JSONDecoder().decode(PaneGroup.self, from: JSONEncoder().encode(group)) == group)
        var project = Project(name: "Work", folder: "/work")
        project.paneGroups = [group]
        let encoded = try JSONEncoder().encode(project)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let groups = try #require(json["paneGroups"] as? [[String: Any]])
        #expect(groups.first?["paneIds"] as? [String] == ["terminal", "board"])
        #expect(try JSONDecoder().decode(Project.self, from: encoded) == project)
    }

    @Test func absentGroupsRemainCompatibleWithOldProjects() throws {
        let project = Project(name: "Work", folder: "/work")
        let encoded = try JSONEncoder().encode(project)
        #expect(try JSONDecoder().decode(Project.self, from: encoded).paneGroups == nil)
    }

    @Test func groupingAbsorbsExistingStacksAndMovesMembersToFirstSelectedGrid() throws {
        let a = Pane(), b = Pane(), c = Pane()
        var project = Project(name: "Work", folder: "/work", panes: [a, b, c])
        let grid = ProjectGridID(rawValue: "other")
        project.panes[2].gridID = grid
        project.groupPanes([a.id, b.id], kind: "orchestration", plannerId: b.id)
        project.groupPanes([c.id, b.id, c.id, PaneID(rawValue: "missing")])
        let group = try #require(project.paneGroups?.first)
        #expect(project.paneGroups?.count == 1)
        #expect(group.paneIds == [a.id, b.id, c.id])
        #expect(group.kind == "orchestration")
        #expect(group.plannerId == b.id)
        #expect(project.panes.allSatisfy { $0.gridID == grid })
        project.ungroupPanes(group.id)
        #expect(project.paneGroups?.isEmpty == true)
        #expect(project.panes.count == 3)
    }

    @Test func invalidSelectionDoesNotCreateOrReplaceStacks() {
        let a = Pane(), b = Pane()
        var project = Project(name: "Work", folder: "/work", panes: [a, b])
        project.groupPanes([a.id, a.id, PaneID(rawValue: "missing")])
        #expect(project.paneGroups == nil)
    }

    @Test func closingMembersPromotesLeaderThenDissolvesSingleton() throws {
        let a = Pane(), b = Pane(), c = Pane()
        var doc = WorkspaceDocument()
        let id = doc.addProject(name: "Work", folder: "/work")
        doc.updateProject(id) {
            $0.panes = [a, b, c]
            $0.groupPanes([a.id, b.id, c.id])
        }
        doc.closePane(a.id)
        #expect(doc.project(id)?.paneGroups?.first?.paneIds == [b.id, c.id])
        doc.closePane(b.id)
        #expect(doc.project(id)?.paneGroups?.isEmpty == true)
        #expect(doc.project(id)?.panes.map(\.id) == [c.id])
    }

    @Test func reconciliationDropsDanglingDuplicateAndSingletonMembership() throws {
        let a = Pane(), b = Pane(), c = Pane(), d = Pane()
        var project = Project(name: "Work", folder: "/work", panes: [a, b, c, d])
        project.paneGroups = [
            PaneGroup(id: "first", paneIds: [a.id, a.id, b.id, PaneID(rawValue: "gone")]),
            PaneGroup(id: "singleton", paneIds: [a.id, c.id]),
            PaneGroup(id: "second", paneIds: [c.id, d.id])
        ]
        project.reconcilePaneGroups()
        #expect(project.paneGroups?.map(\.id) == ["first", "second"])
        #expect(project.paneGroups?.map(\.paneIds) == [[a.id, b.id], [c.id, d.id]])
    }

    @Test func importsWebStacksAndMediaWithoutLosingIDs() throws {
        let fixture = try #require(Bundle.module.url(forResource: "projects-v9", withExtension: "json",
                                                     subdirectory: "Fixtures/Tauri"))
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        var projects = try #require(json["projects"] as? [[String: Any]])
        projects[0]["terminals"] = [
            ["id": "image", "kind": "image", "filePath": "/work/chart.png"],
            ["id": "video", "kind": "video", "filePath": "/work/demo.mp4"]
        ]
        projects[0]["paneGroups"] = [["id": "stack", "paneIds": ["image", "video"]]]
        json["projects"] = projects
        var workspace = WorkspaceDocument()
        var preferences = PreferencesDocument()
        _ = TauriImport.apply(try .init(data: JSONSerialization.data(withJSONObject: json)),
                              to: &workspace, preferences: &preferences,
                              context: .init(agents: ["shell"], themes: ["elite-indigo"]))
        let project = try #require(workspace.projects.first { $0.paneGroups?.first?.id == "stack" })
        #expect(project.panes.map(\.id.rawValue) == ["image", "video"])
        #expect(project.panes.map(\.content) == [.image(path: "/work/chart.png"), .video(path: "/work/demo.mp4")])
        #expect(try JSONDecoder().decode(WorkspaceDocument.self, from: JSONEncoder().encode(workspace)) == workspace)
    }
}
