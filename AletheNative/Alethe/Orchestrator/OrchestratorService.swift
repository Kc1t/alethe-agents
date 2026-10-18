import AletheAgents
import AletheFoundation
import AletheIntegrations
import AletheModel
import AletheOrchestrator
import Foundation
import Observation

/// The app's orchestrator (upstream `orchestrator.rs`): one core for the profile this process runs,
/// prepared on first use — the job store restored, the worker launchers resolved once — so a
/// missing CLI never delays the launch and only fails the jobs that need it. Hosts the MCP endpoint
/// the planners call (`POST /mcp` on the hook listener, through `OrchestratorWiring`), republishes
/// the core's snapshots for the board, and answers, diffs and messages workers for it. `shutdown()`
/// (from `AppEnvironment.flush`) ends and reaps every worker.
@Observable
@MainActor
final class OrchestratorService {
    /// The latest state of every job and planner, for the board.
    private(set) var snapshot = OrchestratorSnapshot()
    private(set) var isPrepared = false
    private var workerRules: [WorkerRuleSet]? = []
    private var settings = OrchestrationPreferences()

    @ObservationIgnored private var setup: Setup?
    @ObservationIgnored private var isEnabled: @MainActor () -> Bool = { false }
    @ObservationIgnored private var leftovers: Task<Void, Never>?
    @ObservationIgnored private var preparing: Task<OrchestratorCore?, Never>?
    @ObservationIgnored private var observation: Task<Void, Never>?
    @ObservationIgnored private var isShutDown = false

    private struct Setup {
        var profileDirectory: URL
        var registry: WorkerRegistry
        var launchers: LauncherCache
        /// The user's CLI path overrides, read when the core is prepared.
        var overrides: @MainActor () -> [String: String]
    }

    /// Wires the profile in and ends workers an unclean exit left running (off main, before any
    /// spawn). The core itself waits for its first use.
    func start(profileDirectory: URL, launchers: LauncherCache,
               overrides: @escaping @MainActor () -> [String: String],
               isEnabled: @escaping @MainActor () -> Bool) {
        guard setup == nil else { return }
        let registry = WorkerRegistry(profileDirectory: profileDirectory)
        setup = Setup(profileDirectory: profileDirectory, registry: registry, launchers: launchers, overrides: overrides)
        self.isEnabled = isEnabled
        leftovers = Task.detached(priority: .utility) {
            guard FileManager.default.fileExists(atPath: registry.url.path) else { return }
            _ = await registry.terminateLeftovers()
        }
    }

    /// The core, prepared on the first call; nil before `start` or after `shutdown`.
    func prepared() async -> OrchestratorCore? {
        if let preparing { return await preparing.value }
        guard let setup, !isShutDown else { return nil }
        let overrides = setup.overrides()
        let leftovers = leftovers
        let (cache, registry, profileDirectory) = (setup.launchers, setup.registry, setup.profileDirectory)
        let task = Task { [weak self] () -> OrchestratorCore? in
            let core = await Task.detached(priority: .userInitiated) { () -> OrchestratorCore in
                await leftovers?.value
                let launchers = WorkerLaunchers.resolve { cache.resolve($0, override: overrides[$0]) }
                let directories = cache.searchDirectories
                let core = OrchestratorCore(configuration: OrchestratorCore.Configuration(
                    launchers: launchers,
                    store: OrchestratorJobStore(profileDirectory: profileDirectory),
                    registry: registry,
                    environment: { WorkerEnvironment.make(for: $0, searchDirectories: directories) }
                ))
                await core.restore()
                return core
            }.value
            if let self {
                await core.applySettings(self.settings)
                await core.applyWorkerRules(self.workerRules)
            }
            self?.observe(core)
            return core
        }
        preparing = task
        return await task.value
    }

    private func observe(_ core: OrchestratorCore) {
        isPrepared = true
        guard !isShutDown else { return }
        observation = Task { [weak self] in
            for await snapshot in await core.snapshots() {
                guard let self else { return }
                self.snapshot = snapshot
            }
        }
    }

    // MARK: Planners and the MCP endpoint

    /// A terminal that may delegate (upstream `orchestrator_mcp_config_path`'s `register_planner`).
    func registerPlanner(_ planner: Planner) {
        Task { await prepared()?.registerPlanner(planner) }
    }

    /// One `POST /mcp` body from a planner. Off while the feature is off (404), 202 for a notification.
    nonisolated func handleMcp(body: Data, planner: String?) async -> AgentHookServer.McpReply {
        guard let core = await coreIfEnabled() else { return .unavailable }
        guard let reply = await OrchestratorMCP.handle(body: body, planner: planner, handler: core) else { return .accepted }
        return .body(reply)
    }

    private func coreIfEnabled() async -> OrchestratorCore? {
        guard isEnabled() else { return nil }
        return await prepared()
    }

    // MARK: The board

    /// Answers a worker's pending ask (upstream `orchestrator_answer`): the person is already
    /// looking at the question. `decision`: accept, acceptForSession, decline or abort.
    func answer(job: String, decision: String) async throws -> OrderedJSON {
        try await callTool("alethe_answer", ["jobId": .string(job), "decision": .string(decision)])
    }

    /// The worker's diff so far (upstream `orchestrator_job_diff`); nil for an unknown job.
    func diff(job: String) async -> String? {
        guard let core = await prepared(), let found = await core.job(job) else { return nil }
        return found.diff ?? ""
    }

    /// Talks to one worker without the lead (upstream `orchestrator_message`): `steer` corrects the
    /// running turn, otherwise the message is its next turn.
    func message(job: String, text: String, steer: Bool) async throws -> OrderedJSON {
        try await callTool(steer ? "alethe_steer" : "alethe_send", ["jobId": .string(job), "message": .string(text)])
    }

    func applyWorkerRules(_ value: [WorkerRuleSet]?) async {
        workerRules = value
        if let preparing, let core = await preparing.value { await core.applyWorkerRules(value) }
    }

    func applySettings(_ value: OrchestrationPreferences) async {
        settings = value.normalized
        if let preparing, let core = await preparing.value { await core.applySettings(settings) }
    }

    func setConcurrencyLimit(_ limit: Int) async {
        await prepared()?.setConcurrencyLimit(limit)
    }

    private func callTool(_ name: String, _ arguments: OrderedJSONObject) async throws -> OrderedJSON {
        guard let core = await prepared() else { throw OrchestratorToolError("the orchestrator is not running") }
        return try await core.callTool(name: name, arguments: arguments, planner: nil)
    }

    // MARK: Quit

    /// Ends and reaps every worker and writes the history; nothing starts afterwards.
    func shutdown() async {
        isShutDown = true
        if let preparing, let core = await preparing.value {
            await core.shutdown()
        }
        observation?.cancel()
        observation = nil
        await leftovers?.value
    }
}
