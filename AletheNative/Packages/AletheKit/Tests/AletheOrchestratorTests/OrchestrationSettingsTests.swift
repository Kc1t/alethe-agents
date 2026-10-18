import AletheIntegrations
import AletheModel
import Testing
@testable import AletheOrchestrator

@Suite struct OrchestrationSettingsTests {
    @Test func ruleRoutingHonorsOrderAndReadOnlyRole() async throws {
        let core = OrchestratorCore(configuration: .init())
        var settings = OrchestrationPreferences()
        settings.applyPreset("balanced")
        await core.applySettings(settings)
        let result = try await core.configuredArguments(["tasks": ["Review"], "kind": "review"], planner: nil)
        #expect(result["agent"]?.stringValue == "codex")
        #expect(result["readOnly"]?.boolValue == true)
        #expect(result["effort"]?.stringValue == "low")
        #expect(result["timeoutSeconds"]?.uint64Value == 900)
        let request = try DelegateRequest(arguments: result)
        #expect(request.readOnly)
    }
    @Test func generalAndNamedRulesAreCombinedAndUnknownNamesRefused() async throws {
        let core = OrchestratorCore(configuration: .init())
        await core.applyWorkerRules([.init(id: "general", name: "General", text: "Always"), .init(id: "db", name: "Sessão", text: "SQL")])
        let block = try await core.workerRulesBlock(named: "SESSAO")
        #expect(block.contains("Always") && block.contains("SQL"))
        #expect(block.contains("the repository wins"))
        do { _ = try await core.workerRulesBlock(named: "Missing"); Issue.record("Unknown rules were accepted") }
        catch { #expect(String(describing: error).contains("unknown rule set")) }
        await core.applyWorkerRules([])
        #expect(try await core.workerRulesBlock(named: nil).isEmpty)
    }
    @Test func codexHandshakeKeepsReadOnlyModelEffortAndDisabledPlugins() {
        var job = Job(id: "job-01", plannerID: nil, agent: "codex", runID: "run-01", runLabel: nil, spec: "Read", cwd: "/repo", sandbox: "read-only")
        job.model = "gpt-6"; job.effort = "high"; job.threadID = "thread-01"
        let session = CodexWorkerSession(job: job, firstTurn: "Read", disabledPlugins: ["ecc@ecc"])
        let opening = session.handshake().last?.objectValue
        let params = opening?["params"]?.objectValue
        #expect(params?["model"]?.stringValue == "gpt-6")
        #expect(params?["sandbox"]?.stringValue == "read-only")
        #expect(params?["config"]?.objectValue?["model_reasoning_effort"]?.stringValue == "high")
        #expect(params?["config"]?.objectValue?["plugins"]?.objectValue?["ecc@ecc"]?.objectValue?["enabled"]?.boolValue == false)
        let restored = Job(record: job.record)
        #expect(restored?.model == job.model)
        #expect(restored?.effort == job.effort)
    }
}
