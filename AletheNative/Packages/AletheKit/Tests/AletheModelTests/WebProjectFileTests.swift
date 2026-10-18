import AletheFoundation
import Foundation
import Testing
@testable import AletheModel

struct WebProjectFileTests {
    private var fixture: Data {
        Data(#"""
        {
          "id":"web-project", "name":"Shop", "color":"#ef4444", "defaultCwd":"/work/shop",
          "groupId":"web-group", "layoutMode":"grid", "collapsed":false,
          "archived":true, "hidden":true, "createdAt":10,
          "iconUrl":"data:image/png;base64,YQ==", "reviewAgentModel":"future-model",
          "validationCommands":["npm test"], "healthCheckPath":"/health",
          "gridLayout":{"cols":1,"rows":1,"cells":{"pane-1":{"col":1,"row":1,"colSpan":1,"rowSpan":1}}},
          "paneGroups":[{"id":"stack","paneIds":["pane-1","board"],"plannerId":"pane-1","kind":"orchestration"}],
          "terminals":[
            {"id":"pane-1","name":"Planner","cwd":"/work/shop","disabled":false,"laneVisible":true,"activeTabId":"tab-1",
             "topbarPinned":true,"tabs":[{"id":"tab-1","type":"claude","name":"Build","cwd":"/work/shop",
               "ptyId":"live-web-process","sessionId":"resume-me","extraArgs":["--dangerously-skip-permissions"],"runtimeProfile":"lean"}]},
            {"id":"board","kind":"orchestrator","name":"Board","cwd":"/work/shop","tabs":[],"activeTabId":"","disabled":false,"laneVisible":null},
            {"id":"plugin","kind":"plugin","pluginId":"custom-plugin","tabs":[]}
          ]
        }
        """#.utf8)
    }

    @Test func importsWholeProjectAndResetsRuntimeIdentity() throws {
        let project = try WebProjectFile.decode(fixture)
        #expect(project.name == "Shop")
        #expect(project.id.rawValue != "web-project")
        #expect(project.folder == "/work/shop")
        #expect(project.color == .red)
        #expect(project.hidden == true)
        #expect(project.archived == false)
        #expect(project.panes.count == 2)
        #expect(project.panes[0].activeTab?.sessionID == "resume-me")
        #expect(project.panes[0].activeTab?.unrestricted == true)
        #expect(project.panes[1].content == .orchestrator)
        #expect(project.validationCommands == ["npm test"])
        #expect(project.healthCheckPath == "/health")
    }

    @Test func webExportPreservesUnknownFieldsAndClearsPTYs() throws {
        var project = try WebProjectFile.decode(fixture)
        project.name = "Renamed"
        project.hidden = false
        project.panes[0].tabs[0].title = "Edited"
        let raw = try JSONDecoder().decode(JSONObject.self, from: WebProjectFile.data(project))
        #expect(raw["name"] == .string("Renamed"))
        #expect(raw["groupId"] == .null)
        #expect(raw["hidden"] == .bool(false))
        #expect(raw["archived"] == .bool(false))
        #expect(raw["reviewAgentModel"] == .string("future-model"))
        #expect(raw["color"] == .string("#ef4444"))
        let panes = try #require(raw["terminals"]?.arrayValue)
        #expect(panes.count == 3, "web-only plugin panes survive a return to the web")
        let pane = try #require(panes[0].objectValue)
        #expect(pane["topbarPinned"] == .bool(true))
        let tab = try #require(pane["tabs"]?.arrayValue?.first?.objectValue)
        #expect(tab["ptyId"] == .null)
        #expect(tab["sessionId"] == .string("resume-me"))
        #expect(tab["runtimeProfile"] == .string("lean"))
        #expect(tab["name"] == .string("Edited"))
        #expect(panes[2].objectValue?["pluginId"] == .string("custom-plugin"))
    }

    @Test func configurationSurvivesNativePersistence() throws {
        let project = try WebProjectFile.decode(fixture)
        let saved = try JSONEncoder().encode(WorkspaceDocument(projects: [project]))
        let restored = try JSONDecoder().decode(WorkspaceDocument.self, from: saved)
        #expect(restored.projects[0] == project)
        let exported = try WebProjectFile.data(restored.projects[0])
        let reimported = try WebProjectFile.decode(exported)
        #expect(reimported.panes.map(\.id) == project.panes.map(\.id))
        #expect(reimported.panes[0].activeTab?.sessionID == project.panes[0].activeTab?.sessionID)
        #expect(reimported.panes[0].activeTab?.extraArguments == project.panes[0].activeTab?.extraArguments)
    }

    @Test func repeatedImportRemapsPaneAndTabReferences() throws {
        let first = try WebProjectFile.decode(fixture)
        let second = try WebProjectFile.importing(fixture, avoiding: WorkspaceDocument(projects: [first]))
        #expect(second.id != first.id)
        #expect(second.panes[0].id != first.panes[0].id)
        #expect(second.panes[0].tabs[0].id != first.panes[0].tabs[0].id)
        #expect(second.panes[0].activeTabID == second.panes[0].tabs[0].id)
        #expect(second.gridLayout?.cells[second.panes[0].id.rawValue] != nil)
        #expect(second.paneGroups?.first?.paneIds.contains(second.panes[0].id) == true)
        #expect(second.panes[0].activeTab?.sessionID == "resume-me")
    }

    @Test func missingVisibilityFlagsRemainBackwardCompatible() throws {
        let project = Project(name: "Old", folder: "/old")
        let data = try JSONEncoder().encode(project)
        let raw = try JSONDecoder().decode(JSONObject.self, from: data)
        #expect(raw["hidden"] == nil)
        #expect(raw["archived"] == nil)
        let restored = try JSONDecoder().decode(Project.self, from: data)
        #expect(restored.hidden == nil)
        #expect(restored.archived == nil)
        var flagged = restored
        flagged.hidden = false
        flagged.archived = true
        let roundTrip = try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(flagged))
        #expect(roundTrip.hidden == false)
        #expect(roundTrip.archived == true)
    }

    @Test func legacyVisibilityMigrationIsScopedAndDoesNotUndoRestore() {
        let id = ProjectID(rawValue: "project")
        let profile = ProfileID(rawValue: "profile")
        var document = WorkspaceDocument(projects: [Project(id: id, name: "Old", folder: "/old")])
        document.migrateProjectVisibility(hidden: ["other:project"], archived: ["profile:project"], profile: profile)
        #expect(document.projects[0].hidden == nil)
        #expect(document.projects[0].archived == true)
        document.projects[0].archived = false
        document.migrateProjectVisibility(hidden: ["profile:project"], archived: ["profile:project"], profile: profile)
        #expect(document.projects[0].hidden == true)
        #expect(document.projects[0].archived == false)
    }

    @Test func gridHistoryUsesWebEpochMilliseconds() throws {
        var project = Project(name: "Grid", folder: "/grid")
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)
        project.gridLayoutHistory = [CustomGridHistoryEntry(savedAt: stamp, layout: .auto([]))]
        let raw = try JSONDecoder().decode(JSONObject.self, from: WebProjectFile.data(project))
        #expect(raw["gridLayoutHistory"]?.arrayValue?.first?.objectValue?["savedAt"] == .number(1_700_000_000_000))
        let restored = try WebProjectFile.decode(WebProjectFile.data(project))
        #expect(restored.gridLayoutHistory?.first?.savedAt == stamp)
    }

    @Test func rejectsMalformedConfiguration() {
        for json in [#"{}"#, #"{"name":"Bad","terminals":{}}"#,
                     #"{"name":"Bad","terminals":[1]}"#,
                     #"{"name":"Bad","terminals":[{"id":"p","tabs":[{"id":"t"}]}]}"#,
                     #"{"name":"Bad","terminals":[{"id":"p","tabs":[]},{"id":"p","tabs":[]}]}"#] {
            #expect(throws: (any Error).self) { try WebProjectFile.decode(Data(json.utf8)) }
        }
    }
}
