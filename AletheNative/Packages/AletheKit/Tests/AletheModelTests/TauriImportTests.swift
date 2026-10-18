import Foundation
import Testing
@testable import AletheModel

/// Golden tests over anonymized `projects.json` files in the shapes upstream migrations accept.
@Suite struct TauriImportTests {
    private static let context = TauriImport.Context(
        agents: ["claude", "codex", "opencode", "cursor", "shell"],
        themes: ["elite-indigo", "nord", "vscode", "dracula"]
    )

    private func fixture(_ version: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "projects-\(version)", withExtension: "json",
                                                 subdirectory: "Fixtures/Tauri"))
        return try Data(contentsOf: url)
    }

    private func imported(_ version: String, into workspace: WorkspaceDocument = WorkspaceDocument(),
                          context: TauriImport.Context = context) throws
        -> (WorkspaceDocument, PreferencesDocument, TauriImport.Report) {
        let file = try TauriImport.File(data: fixture(version))
        var workspace = workspace
        var preferences = PreferencesDocument()
        let report = TauriImport.apply(file, to: &workspace, preferences: &preferences, context: context)
        return (workspace, preferences, report)
    }

    @Test func importsVersion9() throws {
        let (doc, prefs, report) = try imported("v9")

        // Groups: the tree, colors and collapsed state.
        let work = try #require(doc.childGroups(of: nil).first)
        #expect(work.name == "Work" && work.color == .purple && !work.isCollapsed)
        let clients = try #require(doc.childGroups(of: work.id).first)
        #expect(clients.name == "Clients" && clients.color == .orange && clients.isCollapsed)

        // Projects in sidebar order, in their groups.
        let api = try #require(doc.projects.first { $0.name == "api" })
        #expect(api.folder == "/Users/example/code/api" && api.color == .blue)
        #expect(work.projectIDs == [api.id])
        let site = try #require(doc.projects.first { $0.name == "client-site" })
        #expect(doc.group(clients.id)?.projectIDs == [site.id] && site.color == .pink)
        let notes = try #require(doc.projects.first { $0.name == "notes" })
        #expect(doc.ungroupedProjectIDs == [notes.id] && notes.color == .green)

        // Terminals become panes; tabs keep sessions, arguments, titles and their own folders.
        #expect(api.panes.count == 4)
        let first = api.panes[0]
        #expect(first.tabs.map(\.agent) == ["claude", "shell"])
        #expect(first.tabs[0].sessionID == "11111111-2222-4333-8444-555555555555")
        #expect(first.tabs[0].extraArguments == ["--dangerously-skip-permissions"])
        #expect(first.tabs[0].workingDirectory == nil)
        #expect(first.tabs[1].title == "web" && first.tabs[1].workingDirectory == "/Users/example/code/api/web")
        #expect(first.activeTabID == first.tabs[1].id)
        #expect(api.panes[1].tabs.first?.sessionID == "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee")
        #expect(api.panes[2].content == .markdown(path: "/Users/example/code/api/README.md") && api.panes[2].tabs.isEmpty)
        #expect(api.panes[3].tabs.map(\.agent) == ["opencode"])
        #expect(site.panes.first?.tabs.first?.agent == "cursor")

        #expect(api.usesGraphify && !site.usesGraphify && notes.graphifyEnabled == nil)

        #expect(report.groups == 2 && report.projects == 3 && report.panes == 6 && report.tabs == 6)
        #expect(report.skipped == [
            .agent(project: "api", agent: "kiro"),
            .projectArchived(project: "old-site"),
            .paneKind(project: "notes", kind: "web"),
            .projectWithoutFolder(project: "windows-only"),
        ])

        // Preferences: known theme, zoom on the native step, native agents, and only CLI paths that exist here.
        #expect(prefs.themeID == "nord")
        #expect(prefs.uiScale == 1.2)
        #expect(prefs.enabledAgents == ["claude", "cursor", "opencode", "shell"])
        #expect(prefs.alwaysStartUnrestricted)
        #expect(prefs.cliPaths == ["claude": "/usr/bin/true"])
        #expect(prefs.features.isOn(.playwright) && !prefs.features.isOn(.prs) && prefs.features.isOn(.browser))
        #expect(prefs.enabledFeatures?["git"] == nil, "legacy flags are plugins now")
        #expect(prefs.iconTheme == .eliteBlush)
        #expect(prefs.usagePillProviders == ["codex"])
        #expect(!prefs.showsToolbarItem(.memory) && prefs.showsToolbarItem(.profile))
        #expect(prefs.toolbarItems == ["usage.claude": false, "usage.antigravity": false, "memory": false], "usage pills default to shown")
        #expect(prefs.mcpDefaultScope == "project" && prefs.mcpOnboardingSeen == true)
        // The Phase 7 preferences are covered by `TauriImportPeripheralsTests`.
        #expect(report.preferences == Set(TauriImport.Preference.allCases).subtracting([.integrations, .router9, .remote]))
        #expect(report.language == "pt-BR")
    }

    @Test func importingTwiceAddsNothingNew() throws {
        let (once, _, _) = try imported("v9")
        let (twice, _, report) = try imported("v9", into: once)
        #expect(twice.groups == once.groups && twice.projects == once.projects)
        #expect(report.groups == 0 && report.projects == 0)
        #expect(report.skipped.contains(.projectAlreadyAdded(project: "api")))
        #expect(report.skipped.contains(.projectAlreadyAdded(project: "notes")))
    }

    @Test func keepsProjectsAlreadyInTheWorkspace() throws {
        var existing = WorkspaceDocument()
        existing.addProject(name: "my notes", folder: "/Users/example/notes/")
        let (doc, _, report) = try imported("v9", into: existing)
        #expect(doc.projects.filter { $0.folder.hasPrefix("/Users/example/notes") }.map(\.name) == ["my notes"])
        #expect(report.skipped.contains(.projectAlreadyAdded(project: "notes")))
    }

    @Test func preferencesAreOptional() throws {
        var context = Self.context
        context.includePreferences = false
        let (_, prefs, report) = try imported("v9", context: context)
        #expect(prefs == PreferencesDocument())
        #expect(report.preferences.isEmpty && report.language == nil)
        #expect(report.projects == 3)
    }

    /// The shape an older macOS install of the Tauri app leaves behind.
    @Test func importsVersion7() throws {
        let (doc, prefs, report) = try imported("v7")
        let personal = try #require(doc.childGroups(of: nil).first)
        #expect(personal.name == "Personal" && personal.color == .blue)
        let dotfiles = try #require(doc.projects.first { $0.name == "dotfiles" })
        #expect(personal.projectIDs == [dotfiles.id] && dotfiles.panes.count == 2 && dotfiles.color == .purple)
        #expect(doc.ungroupedProjectIDs.compactMap { doc.project($0)?.name } == ["blog"])
        #expect(report.skipped == [.projectWithoutFolder(project: "empty")])
        #expect(prefs.themeID == "vscode" && prefs.uiScale == 0.9)
        #expect(prefs.enabledAgents == ["claude", "cursor", "opencode", "shell"])
        #expect(report.language == "en")
    }

    @Test func importsVersions5And2() throws {
        let (v5, prefs5, _) = try imported("v5")
        #expect(v5.projects.map(\.name) == ["legacy"] && v5.projects.first?.color == .teal)
        #expect(v5.projects.first?.panes.first?.tabs.first?.agent == "claude")
        #expect(prefs5.themeID == "dracula")

        // v2 groups have no `parentGroupId`: they are top-level.
        let (v2, prefs2, report2) = try imported("v2")
        let group = try #require(v2.childGroups(of: nil).first)
        #expect(group.name == "Old group" && group.color == .orange)
        #expect(group.projectIDs.compactMap { v2.project($0)?.name } == ["first"])
        #expect(report2.preferences.isEmpty && prefs2 == PreferencesDocument())
    }

    @Test func refusesUnknownVersions() throws {
        #expect(throws: TauriImport.Failure.unsupportedVersion(nil)) { try TauriImport.File(data: fixture("v1")) }
        #expect(throws: TauriImport.Failure.unsupportedVersion(10)) { try TauriImport.File(data: fixture("v10")) }
        #expect(throws: TauriImport.Failure.unreadable) { try TauriImport.File(data: Data("[1, 2]".utf8)) }
        #expect(throws: TauriImport.Failure.unreadable) { try TauriImport.File(data: Data("not json".utf8)) }
    }

    @Test func mapsHexColorsToTheNearestAccent() {
        let expected: [String: ProjectColor] = [
            "#6ea8ff": .blue, "#22d3ee": .teal, "#a78bfa": .purple, "#34d399": .green, "#f59e0b": .orange,
            "#ef4444": .red, "#ec4899": .pink, "#10b981": .green, "#3b82f6": .blue, "#06b6d4": .teal,
            "#8b5cf6": .purple, "#f97316": .orange, "#eab308": .yellow, "#808080": .gray, "#111111": .black,
            "#fff": .gray, "teal": .teal,
        ]
        for (value, color) in expected {
            #expect(TauriImport.projectColor(value) == color, "\(value)")
        }
        #expect(TauriImport.projectColor("") == nil)
        #expect(TauriImport.projectColor("#zzz") == nil)
        #expect(TauriImport.projectColor(nil) == nil)
    }

    @Test func findsProfilesActiveFirst() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "alethe-tauri-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        for profile in ["default", "WorkID", "orphan", "empty"] {
            try FileManager.default.createDirectory(at: root.appending(path: "profiles/\(profile)"),
                                                    withIntermediateDirectories: true)
        }
        for profile in ["default", "WorkID", "orphan"] {
            try Data("{}".utf8).write(to: root.appending(path: "profiles/\(profile)/projects.json"))
        }
        let index = #"{"version":1,"active_profile_id":"WorkID","profiles":[{"id":"default","name":"Default"},{"id":"WorkID","name":"Work"},{"id":"empty","name":"Empty"}]}"#
        try Data(index.utf8).write(to: root.appending(path: "profiles.json"))

        let profiles = TauriDataLocation.profiles(root: root)
        #expect(profiles.map(\.name) == ["Work", "Default", "orphan"])
        #expect(profiles.map(\.isActive) == [true, false, false])
        #expect(TauriDataLocation.profiles(root: root.appending(path: "missing")).isEmpty)
    }

    /// Upstream `createOrchestratorPane` boards (P6-13): imported as `orchestrator` panes, in place and
    /// grid, instead of being skipped.
    @Test func mapsOrchestratorPanes() throws {
        let json = #"""
        {"version":9,"projects":[{"id":"p1","name":"orch","defaultCwd":"/Users/example/orch",
          "grids":[{"id":"g1","name":"Board"}],
          "terminals":[
            {"id":"t1","name":"Claude","cwd":"/Users/example/orch","kind":"terminal","activeTabId":"s1",
             "tabs":[{"id":"s1","type":"claude"}]},
            {"id":"orchestrator-abc","name":"Orchestration","cwd":"/Users/example/orch","tabs":[],"activeTabId":"",
             "kind":"orchestrator","gridId":"g1"},
            {"id":"m1","kind":"markdown","filePath":"/Users/example/orch/README.md","tabs":[]}
          ]}]}
        """#
        var workspace = WorkspaceDocument()
        var preferences = PreferencesDocument()
        let report = TauriImport.apply(try TauriImport.File(data: Data(json.utf8)), to: &workspace,
                                       preferences: &preferences, context: Self.context)
        let project = try #require(workspace.projects.first)
        #expect(project.panes.map(\.content) == [.terminal, .orchestrator, .markdown(path: "/Users/example/orch/README.md")])
        let board = project.panes[1]
        #expect(board.id == PaneID(rawValue: "orchestrator-abc") && board.tabs.isEmpty)
        #expect(board.gridID == ProjectGridID(rawValue: "g1"))
        #expect(report.skipped.isEmpty)
        #expect(report.panes == 3 && report.tabs == 1)
    }

    /// Upstream's job history beside `projects.json` is copied once into a profile that has none.
    @Test func copiesTheOrchestratorHistoryOnlyWhenTheProfileHasNone() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "alethe-tauri-jobs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let tauri = root.appending(path: "tauri/profiles/default")
        try FileManager.default.createDirectory(at: tauri, withIntermediateDirectories: true)
        let projectsFile = tauri.appending(path: "projects.json")
        try Data("{}".utf8).write(to: projectsFile)
        let native = root.appending(path: "native/profiles/default")

        #expect(!TauriImport.copyOrchestratorJobs(from: projectsFile, into: native), "nothing to copy")

        let history = Data(#"{"version":2,"jobs":[],"planners":[]}"#.utf8)
        try history.write(to: tauri.appending(path: TauriImport.orchestratorJobsFileName))
        #expect(TauriImport.copyOrchestratorJobs(from: projectsFile, into: native))
        let copied = native.appending(path: "orchestrator-jobs.json")
        #expect(try Data(contentsOf: copied) == history)

        try Data(#"{"version":2,"jobs":[{"id":"job-01"}]}"#.utf8).write(to: tauri.appending(path: "orchestrator-jobs.json"))
        #expect(!TauriImport.copyOrchestratorJobs(from: projectsFile, into: native), "an existing history is kept")
        #expect(try Data(contentsOf: copied) == history)
    }
}
