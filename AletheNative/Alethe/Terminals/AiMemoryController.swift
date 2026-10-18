import AletheAgents
import AletheIntegrations
import AletheModel
import AletheTerminal
import Foundation
import Observation

/// ai-memory (P5-18, upstream `ai_memory.rs`): detects the CLI and its server, and while the aiMemory
/// feature is on adds `ai-memory mcp` to Claude Code, Codex and OpenCode launches through P5-4.
@Observable
@MainActor
final class AiMemoryController {
    /// `cliPaths` key of the command override (a path chosen in Settings › Features › AI Memory).
    static let overrideKey = "ai-memory"
    static let providerID = "ai-memory"

    /// The last detection; nil until one finished.
    private(set) var status: AiMemoryStatus?
    private(set) var isDetecting = false
    @ObservationIgnored private weak var environment: AppEnvironment?
    @ObservationIgnored private var detection: Task<Void, Never>?

    @ObservationIgnored private var persistence: Task<Void, Never>?
    @ObservationIgnored private var sessionWatches: [TabID: (pid: Int32, watch: SessionWatch)] = [:]

    func start(environment: AppEnvironment) {
        self.environment = environment
        // Terminal persistence is independent of whether the optional MCP server is enabled.
        persistence?.cancel()
        persistence = Task { [weak self] in
            while !Task.isCancelled {
                guard self != nil else { return }
                await self?.reconcileTerminals()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        environment.terminals.mcp.register(Self.providerID) { [weak self] _ in
            self?.launchServers() ?? []
        }
        if environment.features.isOn(.aiMemory) { refresh() }
    }

    private func reconcileTerminals() async {
        guard let environment, let workspace = environment.workspace else { return }
        let running = environment.terminals.running
        let live = Set(running.map(\.tab))
        sessionWatches = sessionWatches.filter { live.contains($0.key) }
        for (tab, view) in running {
            guard !Task.isCancelled, environment.workspace === workspace,
                  let (project, pane) = workspace.document.paneHolding(tab),
                  let item = pane.tabs.first(where: { $0.id == tab }) else { continue }
            let kind = AgentKind(rawValue: item.agent)
            if kind == .shell {
                let directory = view.reportedDirectory ?? PaneWorkingDirectory.processDirectory(view.processID)
                if let directory, directory != item.workingDirectory {
                    workspace.update { $0.updateTab(tab) { $0.workingDirectory = directory } }
                    await workspace.flush()
                }
                continue
            }
            let cwd = item.workingDirectory ?? project.folder
            let siblings = environment.terminals.running.filter { other in
                guard other.tab != tab, let (otherProject, otherPane) = workspace.document.paneHolding(other.tab),
                      let otherItem = otherPane.tabs.first(where: { $0.id == other.tab }) else { return false }
                return otherItem.agent == item.agent
                    && SessionPaths.normalize(otherItem.workingDirectory ?? otherProject.folder) == SessionPaths.normalize(cwd)
            }
            // Modification times cannot attribute a CLI-side switch to one of two live panes.
            guard siblings.isEmpty else { sessionWatches.removeValue(forKey: tab); continue }
            let pid = view.processID
            guard pid > 0 else { continue }
            let command = AgentRegistry.builtin.descriptor(for: kind)?.cliCommand
            let executable = command.flatMap {
                environment.launchers.resolve($0, override: environment.preferences?.document.cliPaths?[kind.rawValue])
            }
            let sessions = await Task.detached {
                await SessionWatch.snapshot(kind, cwd: cwd, executable: executable)
            }.value
            guard !Task.isCancelled, environment.workspace === workspace, environment.terminals.view(for: tab) === view,
                  environment.terminals.states[tab] == .running,
                  let (_, currentPane) = workspace.document.paneHolding(tab),
                  let current = currentPane.tabs.first(where: { $0.id == tab }),
                  current.sessionID == item.sessionID else { continue }
            let claimed = Set(workspace.document.projects.flatMap { otherProject in
                otherProject.panes.flatMap { otherPane in
                    otherPane.tabs.compactMap { otherItem -> String? in
                        guard otherItem.id != tab, otherItem.agent == item.agent,
                              SessionPaths.normalize(otherItem.workingDirectory ?? otherProject.folder) == SessionPaths.normalize(cwd)
                        else { return nil }
                        return otherItem.sessionID
                    }
                }
            })
            var watch = sessionWatches[tab].flatMap { $0.pid == pid ? $0.watch : nil } ?? SessionWatch()
            let next = watch.reconcile(sessions: sessions, currentID: current.sessionID,
                                       startedAt: view.startedAt, claimedByOthers: claimed)
            sessionWatches[tab] = (pid, watch)
            if let next {
                environment.terminals.apply(AgentHookEvent(sessionID: next), to: tab)
                await workspace.flush()
                environment.terminals.refreshTitle(tab)
            }
        }
    }

    var override: String? { environment?.preferences?.document.cliPaths?[Self.overrideKey] }

    /// The CLI to run: the override when it is an executable, else `ai-memory` found on disk.
    var executable: String? {
        environment?.launchers.resolve(AiMemory.defaultCommand, override: override)
    }

    /// Detects again (cancels one in flight); runs off the main thread with a timeout.
    func refresh() {
        detection?.cancel()
        let executable = executable
        isDetecting = true
        detection = Task { [weak self] in
            let status = await AiMemory.detect(executable: executable)
            guard !Task.isCancelled, let self else { return }
            self.status = status
            self.isDetecting = false
        }
    }

    func setOverride(_ path: String?) {
        environment?.preferences?.update { preferences in
            var paths = preferences.cliPaths ?? [:]
            paths[Self.overrideKey] = path
            preferences.cliPaths = paths.isEmpty ? nil : paths
        }
        environment?.launchers.invalidate()
        refresh()
    }

    private func launchServers() -> [McpLaunchServer] {
        guard let environment else { return [] }
        let enabled = environment.features.isOn(.aiMemory)
        guard let server = AiMemory.server(enabled: enabled, executable: enabled ? executable : nil, status: status) else {
            return []
        }
        return [McpLaunchServer(name: server.name, command: server.command, arguments: server.arguments)]
    }
}
