import AletheFoundation
import Foundation
import Testing
@testable import AletheModel

/// Toolbar configuration (P5-13): item visibility and the v1 → v2 migration of P3-13's `usagePills`.
@Suite struct ToolbarLayoutTests {
    private func migrated(_ json: String) async throws -> (PreferencesDocument, DocumentLoadOutcome, JSONObject) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "alethe-toolbar-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "preferences.json")
        try Data(json.utf8).write(to: url)
        let (document, outcome) = try await DocumentStore<PreferencesDocument>(url: url).load()
        let written = try JSONDecoder().decode(JSONObject.self, from: Data(contentsOf: url))
        return (document, outcome, written)
    }

    @Test func usagePillsMigrateToToolbarItems() async throws {
        let json = #"{"schemaVersion":1,"themeID":"nord","uiScale":1,"alwaysStartUnrestricted":false,"usagePills":["codex","claude","gemini"]}"#
        let (preferences, outcome, written) = try await migrated(json)
        guard case .migrated(from: 1, _) = outcome else {
            Issue.record("expected a migration from v1, got \(outcome)")
            return
        }
        #expect(preferences.schemaVersion == 2)
        #expect(preferences.themeID == "nord")
        #expect(preferences.usagePillProviders == ["claude", "codex"], "toolbar order; unknown providers dropped")
        #expect(preferences.showsToolbarItem(.usageCodex) && !preferences.showsToolbarItem(.usageAntigravity))
        #expect(preferences.toolbarItems == ["usage.claude": true, "usage.codex": true, "usage.antigravity": false])
        #expect(written["usagePills"] == nil, "the old key is not written back")
        #expect(written["schemaVersion"]?.intValue == 2)
    }

    @Test func noUsagePillsMigratesToDefaults() async throws {
        let json = #"{"schemaVersion":1,"themeID":"nord","uiScale":1,"alwaysStartUnrestricted":false}"#
        let (preferences, _, _) = try await migrated(json)
        #expect(preferences.toolbarItems == nil)
        #expect(preferences.usagePillProviders == ToolbarItemKind.usageProviders)
    }

    @Test func emptyUsagePillsKeepsDefaults() async throws {
        let json = #"{"schemaVersion":1,"themeID":"nord","uiScale":1,"alwaysStartUnrestricted":false,"usagePills":[]}"#
        let (preferences, _, written) = try await migrated(json)
        #expect(preferences.usagePillProviders.isEmpty)
        #expect(written["usagePills"] == nil)
    }

    @Test func defaultsShowUsageAndHideOnlyRouter9() {
        let preferences = PreferencesDocument()
        let hidden = ToolbarItemKind.allCases.filter { !preferences.showsToolbarItem($0) }
        #expect(hidden == [.router9])
        #expect(ToolbarItemKind.usageProviders.compactMap(ToolbarItemKind.usagePill(for:)) == [.usageClaude, .usageCodex, .usageAntigravity])
        #expect(ToolbarItemKind.memory.usageProvider == nil && ToolbarItemKind.usageCodex.usageProvider == "codex")
        #expect(ToolbarItemKind.aiUsage.usageProvider == nil)
    }

    @Test func onlyChoicesAgainstTheDefaultAreStored() throws {
        var preferences = PreferencesDocument()
        preferences.setToolbarItem(.memory, shown: false)
        preferences.setToolbarItem(.usageClaude, shown: false)
        #expect(preferences.toolbarItems == ["memory": false, "usage.claude": false])
        let decoded = try JSONDecoder().decode(PreferencesDocument.self, from: JSONEncoder().encode(preferences))
        #expect(!decoded.showsToolbarItem(.memory) && decoded.usagePillProviders == ["codex", "antigravity"])
        preferences.setToolbarItem(.memory, shown: true)
        preferences.setToolbarItem(.usageClaude, shown: true)
        #expect(preferences.toolbarItems == nil)
    }

    @Test func usagePillsOverflowFirstAndHomeAndProfileLast() {
        let pills = ToolbarItemKind.allCases.filter { $0.usageProvider != nil }
        let others = ToolbarItemKind.allCases.filter { $0.usageProvider == nil }
        for pill in pills {
            #expect(others.allSatisfy { pill.overflowRank < $0.overflowRank })
        }
        #expect(ToolbarItemKind.home.overflowRank == .last && ToolbarItemKind.profile.overflowRank == .last)
    }
}
