import Foundation
import Testing
@testable import AletheModel

@Suite struct ScopeGridParityTests {
    @Test func groupAndWorkspaceLayoutsRoundTrip() throws {
        let layout = CustomGrid.auto(["project-a", "project-b"], cols: 2)
        let entry = CustomGridHistoryEntry(id: "saved", savedAt: Date(timeIntervalSince1970: 1_792_300_000), layout: layout)
        var group = ProjectGroup(name: "Team")
        group.layoutMode = .grid
        group.gridLayout = layout
        group.gridLayoutHistory = [entry]
        let groupData = try JSONEncoder().encode(group)
        #expect(try JSONDecoder().decode(ProjectGroup.self, from: groupData) == group)
        var preferences = PreferencesDocument()
        preferences.workspaceGridLayout = layout
        preferences.workspaceGridLayoutHistory = [entry]
        let data = try JSONEncoder().encode(preferences)
        #expect(try JSONDecoder().decode(PreferencesDocument.self, from: data) == preferences)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["workspaceGridLayout"] != nil)
        let history = try #require(json["workspaceGridLayoutHistory"] as? [[String: Any]])
        #expect(history.first?["savedAt"] as? Double == 1_792_300_000_000)
    }

    @Test func legacyHistoryDatesRemainReadable() throws {
        let raw = #"{"id":"old","savedAt":800000000,"layout":{"cols":1,"rows":1,"cells":{}}}"#
        let entry = try JSONDecoder().decode(CustomGridHistoryEntry.self, from: Data(raw.utf8))
        #expect(entry.savedAt == Date(timeIntervalSinceReferenceDate: 800_000_000))
    }

    @Test func legacyISOHistoryDatesRemainReadable() throws {
        let raw = #"{"id":"old","savedAt":"2026-10-18T00:00:00Z","layout":{"cols":1,"rows":1,"cells":{}}}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let entry = try decoder.decode(CustomGridHistoryEntry.self, from: Data(raw.utf8))
        #expect(entry.savedAt == ISO8601DateFormatter().date(from: "2026-10-18T00:00:00Z"))
    }

    @Test func oldFilesNeedNoScopeFields() throws {
        let group = ProjectGroup(name: "Before")
        let decoded = try JSONDecoder().decode(ProjectGroup.self, from: JSONEncoder().encode(group))
        #expect(decoded.gridLayout == nil && decoded.gridLayoutHistory == nil && decoded.layoutMode == nil)
        let preferences = try JSONDecoder().decode(PreferencesDocument.self, from: JSONEncoder().encode(PreferencesDocument()))
        #expect(preferences.workspaceGridLayout == nil && preferences.workspaceGridLayoutHistory == nil)
    }

    @Test func importingScopeGridsRemapsProjectIDs() throws {
        let raw = #"""
        {"version":9,"groups":[{"id":"g","name":"Team","projectIds":["p"],"layoutMode":"grid",
        "gridLayout":{"cols":1,"rows":1,"cells":{"p":{"col":1,"row":1,"colSpan":1,"rowSpan":1}}}}],
        "projects":[{"id":"p","name":"App","defaultCwd":"/tmp/scope-grid-parity","groupId":"g","terminals":[]}],
        "preferences":{"workspaceGridLayout":{"cols":1,"rows":1,"cells":{"p":{"col":1,"row":1,"colSpan":1,"rowSpan":1}}}}}
        """#
        var document = WorkspaceDocument()
        var preferences = PreferencesDocument()
        _ = TauriImport.apply(try TauriImport.File(data: Data(raw.utf8)), to: &document, preferences: &preferences,
                              context: TauriImport.Context(agents: ["shell"], themes: []))
        let id = try #require(document.projects.first?.id.rawValue)
        #expect(document.groups.first?.gridLayout?.cells[id] != nil)
        #expect(document.groups.first?.gridLayout?.cells["p"] == nil)
        #expect(preferences.workspaceGridLayout?.cells[id] != nil)
    }
}
