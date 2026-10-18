import Foundation
import Testing
@testable import AletheModel

@Suite struct OrchestrationPreferencesTests {
    @Test func portablePreferenceKeysAndExplicitEmptyListsRoundTrip() throws {
        var preferences = PreferencesDocument()
        preferences.orchestration = .init()
        preferences.workerRuleSets = []
        preferences.orchestratorShortcuts = []
        let data = try JSONEncoder().encode(preferences)
        let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((raw["workerRuleSets"] as? [Any])?.isEmpty == true)
        #expect((raw["orchestratorShortcuts"] as? [Any])?.isEmpty == true)
        #expect(raw["orchestration"] != nil)
        let decoded = try JSONDecoder().decode(PreferencesDocument.self, from: data)
        #expect(decoded == preferences)
        preferences.workerRuleSets = nil
        preferences.orchestratorShortcuts = nil
        let defaults = try JSONDecoder().decode(PreferencesDocument.self, from: JSONEncoder().encode(preferences))
        #expect(defaults.workerRuleSets == nil)
        #expect(defaults.orchestratorShortcuts == nil)
    }

    @Test func namesFoldLikeWebAndNewNamesStayUnique() {
        let first = WorkerRuleSet(id: "one", name: "Sessão")
        let second = WorkerRuleSet(id: "two", name: "Other")
        #expect(second.isDuplicate(" SESSA\u{0303}O ", in: [first, second]))
        #expect(!first.isDuplicate("sessao", in: [first, second]))
        #expect(WorkerRuleSet.uniqueName("Sessao", in: [first]) == "Sessao 2")
        #expect(WorkerRuleSet.defaults.first?.isProtected == true)
    }

    @Test func shortcutConditionsAndPlaceholderValuesStayLiteral() {
        let shortcut = OrchestratorShortcut(name: "Apply", text: "{jobId} {branch} {worktree} {project} {agent} {unknown}", rule: "finishedIsolated")
        #expect(shortcut.matches(done: true, isolated: true, native: false))
        #expect(!shortcut.matches(done: true, isolated: false, native: false))
        #expect(!shortcut.matches(done: true, isolated: true, native: true))
        #expect(shortcut.render(jobID: "job-01", agent: "codex", worktree: "{agent}", project: nil)
            == "job-01 alethe/agent-job-01 {agent}  codex {unknown}")
    }

    @Test func presetsPreserveCustomRolesAndUseWebValues() {
        var preferences = OrchestrationPreferences()
        preferences.roles = [.init(name: "mine"), .init(name: "builder", model: "old")]
        preferences.applyPreset("balanced")
        #expect(preferences.roles.contains { $0.name == "mine" })
        #expect(preferences.roles.first { $0.name == "builder" }?.model == "sonnet")
        #expect(preferences.routing.rules.count == 5)
        #expect(preferences.routing.rules[3].gates.first?.below == 50)
        preferences.maxConcurrent = 100
        preferences.defaultTimeoutSeconds = -1
        #expect(preferences.normalized.maxConcurrent == 16)
        #expect(preferences.normalized.defaultTimeoutSeconds == 900)
    }

    @Test func projectAdvancedFieldsUseWebNamesWithoutAMigration() throws {
        var project = Project(name: "API", folder: "/api")
        project.validationCommands = ["npm test", "npm run build"]
        project.healthCheckCommand = "npm run dev"
        project.healthCheckPath = "/health"
        project.conflictAgentProvider = "codex"
        project.conflictAgentModel = "gpt-6"
        project.gsdWatcherEnabled = true
        let data = try JSONEncoder().encode(project)
        #expect(try JSONDecoder().decode(Project.self, from: data) == project)
        let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(raw["conflictAgentProvider"] as? String == "codex")
        #expect(raw["validationCommands"] as? [String] == ["npm test", "npm run build"])
    }
}
