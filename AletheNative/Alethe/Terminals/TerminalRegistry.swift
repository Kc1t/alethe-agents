import AletheAgents
import AletheDesign
import AletheFoundation
import AletheIntegrations
import AletheModel
import AletheTerminal
import AppKit
import Foundation
import Observation

/// Live terminals, one per tab. A terminal outlives the view showing it: switching projects or
/// collapsing a pane only detaches its view, the process keeps running.
@Observable
@MainActor
final class TerminalRegistry {
    enum State: Equatable {
        case running
        case exited(code: Int32)
        /// Ended by a double ⌃C.
        case forceKilled
        /// The agent's CLI was not found; `command` is the binary looked for.
        case notFound(command: String)
        case failed(message: String)
    }

    private(set) var states: [TabID: State] = [:]
    /// A local page a tab's output announced, offered until opened or dismissed.
    private(set) var pageOffers: [TabID: URL] = [:]
    /// Bumped whenever a tab gets a new view (start, restart) so hosts swap it in.
    private(set) var generations: [TabID: Int] = [:]
    /// Tabs ended to save memory (P2-24); each starts again, resuming its session, when shown.
    private(set) var hibernated: Set<TabID> = []
    /// What each running agent is doing (P3-9): from hooks where the agent has them, else inferred
    /// from its traffic.
    private(set) var activity: [TabID: AgentActivity] = [:]
    /// Called on every activity change (notifications, P3-11).
    @ObservationIgnored var onActivityChange: ((TabID, AgentActivity, AgentHookEvent?) -> Void)?
    @ObservationIgnored let hooks = AgentHookHub()
    /// MCP servers integrations add to each agent launch (P5-4).
    @ObservationIgnored let mcp = McpLaunchWiring()
    /// Conversation titles of agent tabs (P3-10), read from their transcripts.
    private(set) var titles: [TabID: String] = [:]
    /// Tabs whose agent finished while the user was elsewhere (upstream `completionUnread`).
    private(set) var unread: Set<TabID> = []
    @ObservationIgnored private var watches: [TabID: ActivityWatch] = [:]
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var views: [TabID: TerminalPaneView] = [:]
    @ObservationIgnored private var claims = SessionClaims()
    /// How each live process was started, for the early-exit fallback.
    @ObservationIgnored private var launches: [TabID: (startedAt: ContinuousClock.Instant, resumed: Bool)] = [:]
    /// Tabs that already fell back to a fresh session once; a second quick exit is shown, not retried.
    @ObservationIgnored private var retriedFresh: Set<TabID> = []
    /// One saved-output file per tab, shared by every process the tab runs, so clearing, loading and
    /// appending stay in order on its queue.
    @ObservationIgnored private var scrollbacks: [TabID: ScrollbackFile] = [:]
    /// Discovery of a new session (Codex, OpenCode, Antigravity), per tab, until its id is found.
    @ObservationIgnored private var discoveries: [TabID: Task<Void, Never>] = [:]
    /// Tabs whose launch waits on something first (a Cursor chat being created).
    @ObservationIgnored private var preparing: Set<TabID> = []
    /// Every running tab's output and exits, for remote control (P7-12).
    @ObservationIgnored let output = TerminalOutputRelay()

    func view(for tab: TabID) -> TerminalPaneView? { views[tab] }

    /// Starts the tab's process unless it already has one (running or ended) or is being prepared.
    func ensureStarted(_ tab: PaneTab, in project: Project, environment: AppEnvironment) {
        guard states[tab.id] == nil, !preparing.contains(tab.id) else { return }
        start(tab, in: project, environment: environment)
    }

    /// Replaces whatever the tab runs with a fresh process.
    func restart(_ tab: PaneTab, in project: Project, environment: AppEnvironment) {
        restart(tab, in: project, environment: environment, fresh: false)
    }

    private func restart(_ tab: PaneTab, in project: Project, environment: AppEnvironment, fresh: Bool) {
        if let view = views.removeValue(forKey: tab.id) {
            view.terminate()
            output.exit(tab.id, reason: "restarted")
        }
        // A restart starts clean, like upstream's `restart_pty`.
        scrollback(for: tab.id, environment: environment)?.clear()
        environment.launchers.invalidate()
        start(tab, in: project, environment: environment, fresh: fresh)
    }

    /// Ends the tab's process and forgets it (the tab was closed or deleted); its saved scrollback
    /// goes too unless `keepScrollback` (quitting).
    func close(_ tab: TabID, keepScrollback: Bool = false, exitReason: String = "killed") {
        let view = views.removeValue(forKey: tab)
        if view != nil, states[tab] == .running { output.exit(tab, reason: exitReason) }
        pageOffers.removeValue(forKey: tab)
        if let file = scrollbacks.removeValue(forKey: tab) {
            if keepScrollback { file.flush() } else { file.delete() }
        }
        view?.terminate()
        states.removeValue(forKey: tab)
        generations.removeValue(forKey: tab)
        discoveries.removeValue(forKey: tab)?.cancel()
        preparing.remove(tab)
        watches.removeValue(forKey: tab)?.stop()
        if watches.isEmpty {
            ticker?.invalidate()
            ticker = nil
        }
        activity.removeValue(forKey: tab)
        unread.remove(tab)
        launches.removeValue(forKey: tab)
        retriedFresh.remove(tab)
        claims.release(owner: tab.rawValue)
    }

    /// A hook event for a tab: its activity, and the conversation it is on now (Claude moves to a new
    /// id after `/clear` or an in-CLI `/resume`; upstream `trackClaudeSessionHook`).
    func apply(_ event: AgentHookEvent, to tab: TabID) {
        guard states[tab] == .running else { return }
        if let session = event.sessionID, let environment = hookEnvironment,
           let (project, pane) = environment.workspace?.document.paneHolding(tab),
           let item = pane.tabs.first(where: { $0.id == tab }), item.sessionID != session {
            let cwd = item.workingDirectory ?? project.folder
            claims.release(owner: tab.rawValue)
            claims.register(AgentKind(rawValue: item.agent), cwd: cwd, sessionID: session, owner: tab.rawValue)
            environment.workspace?.update { $0.updateTab(tab) { $0.sessionID = session } }
        }
        if let next = event.activity { setActivity(next, for: tab, event: event) }
    }

    /// Set by the environment so hook events can reach the workspace.
    @ObservationIgnored weak var hookEnvironment: AppEnvironment?

    private func setActivity(_ next: AgentActivity, for tab: TabID, event: AgentHookEvent? = nil) {
        guard activity[tab] != next else { return }
        activity[tab] = next
        if next == .done || next == .needsInput {
            if !isInFront(tab) { unread.insert(tab) }
            refreshTitle(tab)
        }
        onActivityChange?(tab, next, event)
    }

    /// The tab the user is looking at: the focused pane's shown tab in the key window.
    func isInFront(_ tab: TabID) -> Bool {
        guard NSApp.isActive, let document = hookEnvironment?.workspace?.document,
              let pane = document.workspace.focusedPaneID else { return false }
        return document.pane(pane)?.pane.activeTab?.id == tab
    }

    func markRead(_ tab: TabID) {
        unread.remove(tab)
    }

    /// Reads the tab's conversation title off the main thread.
    func refreshTitle(_ tab: TabID) {
        guard let document = hookEnvironment?.workspace?.document, let (project, pane) = document.paneHolding(tab),
              let item = pane.tabs.first(where: { $0.id == tab }), let session = item.sessionID else { return }
        let kind = AgentKind(rawValue: item.agent), cwd = item.workingDirectory ?? project.folder
        Task { [weak self] in
            let title = await Task.detached { ConversationHistory.title(kind, sessionID: session, cwd: cwd) }.value
            guard let self, let title, self.titles[tab] != title else { return }
            self.titles[tab] = title
        }
    }

    /// What to call a tab: its own title, else its conversation's, else the agent's name.
    func displayName(of tab: PaneTab) -> String {
        tab.title ?? titles[tab.id] ?? AgentLabels.name(for: tab.agent)
    }

    /// Traffic heuristics for a tab: a submitted prompt means working; for agents without turn hooks,
    /// quiet after a response means done (upstream `AgentCompletionMonitor`).
    private func watch(_ tab: TabID, view: TerminalPaneView, heuristicTurns: Bool) {
        watches.removeValue(forKey: tab)?.stop()
        let watch = ActivityWatch(tap: view.tap, endsTurns: heuristicTurns) { [weak self] next in
            Task { @MainActor in self?.setActivity(next, for: tab) }
        }
        watches[tab] = watch
        setActivity(.idle, for: tab)
        if ticker == nil {
            ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.watches.values.forEach { $0.tick() } }
            }
        }
    }

    /// Running terminals with their views, for the resource monitor.
    var running: [(tab: TabID, view: TerminalPaneView)] {
        states.compactMap { tab, state in state == .running ? views[tab].map { (tab, $0) } : nil }
    }

    /// Ends an idle hidden terminal to free its memory; its output is kept and it starts again when
    /// shown (upstream parking, but resumed by itself).
    func hibernate(_ tab: TabID) {
        guard states[tab] == .running else { return }
        close(tab, keepScrollback: true, exitReason: "suspended")
        hibernated.insert(tab)
    }

    /// Restarts every running agent on the conversation before its current one (upstream
    /// `resetLastSession`); returns how many were resumed and how many were running.
    func resumePreviousConversations(environment: AppEnvironment) -> (resumed: Int, total: Int) {
        guard let document = environment.workspace?.document else { return (0, 0) }
        var resumed = 0, total = 0
        for (tab, view) in running {
            guard let (project, pane) = document.paneHolding(tab), let item = pane.tabs.first(where: { $0.id == tab }) else { continue }
            let kind = AgentKind(rawValue: item.agent)
            guard kind != .shell else { continue }
            total += 1
            let sessions = SessionResume.sessions(kind, cwd: item.workingDirectory ?? project.folder)
            guard let previous = SessionResume.previous(in: sessions, excluding: item.sessionID, before: view.startedAt)
            else { continue }
            environment.workspace?.update { $0.updateTab(tab) { $0.sessionID = previous } }
            var next = item
            next.sessionID = previous
            restart(next, in: project, environment: environment)
            resumed += 1
        }
        return (resumed, total)
    }

    /// A disabled terminal: its process ends, its saved output stays for when it is enabled again.
    func suspend(_ tab: TabID) {
        guard states[tab] != nil else { return }
        close(tab, keepScrollback: true, exitReason: "suspended")
    }

    func dismissPageOffer(for tab: TabID) {
        pageOffers.removeValue(forKey: tab)
    }

    /// Closes terminals whose tabs no longer exist.
    func prune(keeping tabs: Set<TabID>) {
        for tab in Set(states.keys).subtracting(tabs) { close(tab) }
        hibernated.formIntersection(tabs)
    }

    /// Quitting: every process ends, every scrollback is written for the next launch.
    func terminateAll() {
        for tab in Array(states.keys) { close(tab, keepScrollback: true) }
    }

    func applyAppearance(theme: Theme, fontSize: Float) {
        for view in views.values { view.applyTheme(theme, fontSize: fontSize) }
    }

    private func scrollback(for tab: TabID, environment: AppEnvironment) -> ScrollbackFile? {
        if let file = scrollbacks[tab] { return file }
        let file = environment.scrollbackFile(for: tab)
        scrollbacks[tab] = file
        return file
    }

    /// Sends the tab's first prompt once, then forgets it so a relaunch does not send it again.
    private func deliver(_ prompt: String, to view: TerminalPaneView, tab: TabID,
                         style: PromptDelivery.Style, environment: AppEnvironment) {
        Task { [weak environment] in
            guard await view.deliverPrompt(prompt, style: style) else { return }
            environment?.workspace?.update { $0.updateTab(tab) { $0.initialPrompt = nil } }
        }
    }

    /// Whether to resume the tab's saved conversation: it must still exist on disk and not be held
    /// by another tab (Codex rejects a second writer; two panes on one Claude chat would interleave).
    private func resumableSession(of tab: PaneTab, kind: AgentKind, cwd: String, fresh: Bool) -> String? {
        guard !fresh, let id = tab.sessionID else { return nil }
        if claims.isClaimed(kind, cwd: cwd, sessionID: id, excluding: tab.id.rawValue) { return nil }
        return SessionResume.isResumable(kind, sessionID: id, cwd: cwd) ? id : nil
    }

    /// Binds the Codex session this tab's process creates, once the CLI writes it to disk.
    private func discoverSession(for tab: TabID, kind: AgentKind, cwd: String, before beforeTask: Task<Set<String>, Never>,
                                 executable: String?, environment: AppEnvironment) {
        discoveries[tab] = Task { [weak self, weak environment] in
            let before = await beforeTask.value
            let found = await SessionResume.discover(sleep: { try? await Task.sleep(for: $0) }) {
                let sessions = await Task.detached { await SessionResume.snapshot(kind, cwd: cwd, executable: executable) }.value
                return self?.claims.claimDiscovered(kind, cwd: cwd, before: before, sessions: sessions,
                                                    owner: tab.rawValue)?.id
            }
            guard let found, let self, !Task.isCancelled else { return }
            self.discoveries.removeValue(forKey: tab)
            environment?.workspace?.update { $0.updateTab(tab) { $0.sessionID = found } }
        }
    }

    private func start(_ tab: PaneTab, in project: Project, environment: AppEnvironment, fresh: Bool = false) {
        hibernated.remove(tab.id)
        let kind = AgentKind(rawValue: tab.agent)
        let cwd = tab.workingDirectory ?? project.folder
        // Cursor mints chat ids itself: create the chat first so the pane can always resume it
        // (upstream `create_cursor_chat`); without one (signed out, CLI failing) it starts as is.
        if kind == .cursor, tab.sessionID == nil, !preparing.contains(tab.id),
           let executable = environment.launchers.resolve("cursor-agent", override: environment.preferences?.document.cliPaths?["cursor"]) {
            preparing.insert(tab.id)
            Task { [weak self, weak environment] in
                let chat = await CursorChats.create(executable: executable, cwd: cwd)
                guard let self, let environment else { return }
                var prepared = tab
                if let chat {
                    prepared.sessionID = chat
                    environment.workspace?.update { $0.updateTab(tab.id) { $0.sessionID = chat } }
                }
                // Still there and still waiting (not closed meanwhile)?
                guard self.preparing.remove(tab.id) != nil, environment.workspace?.document.paneHolding(tab.id) != nil else { return }
                self.startPrepared(prepared, in: project, environment: environment, fresh: fresh)
            }
            return
        }
        // GSD Sync (P5-24): the plugin, its model chain and the `opencode.json` entry go in first, so
        // OpenCode loads them on this start (upstream `XTermView` before `spawn_pty`). A routed tab
        // (P7-17) reads 9router's settings and Keychain key off the main thread first, on every
        // start, so turning 9router off or removing the key applies at the next restart.
        let syncsGSD = kind == .opencode && environment.features.isOn(.gsdSync)
        let routes = Router9.wantsRouting(tab)
        if syncsGSD || routes, !preparing.contains(tab.id) {
            preparing.insert(tab.id)
            Task { [weak self, weak environment] in
                if syncsGSD { await environment?.gsdSync.prepareLaunch(in: cwd) }
                let config = routes ? await environment?.router9.routingConfig() : nil
                guard let self, let environment, self.preparing.remove(tab.id) != nil,
                      environment.workspace?.document.paneHolding(tab.id) != nil else { return }
                self.startPrepared(tab, in: project, environment: environment, fresh: fresh,
                                   routing: Router9.launchEnvironment(for: tab, config: config))
            }
            return
        }
        startPrepared(tab, in: project, environment: environment, fresh: fresh)
    }

    /// `routing`: 9router's variables for this launch; empty when the tab is not routed.
    private func startPrepared(_ tab: PaneTab, in project: Project, environment: AppEnvironment, fresh: Bool,
                               routing: [String: String] = [:]) {
        let kind = AgentKind(rawValue: tab.agent)
        let cwd = tab.workingDirectory ?? project.folder
        discoveries.removeValue(forKey: tab.id)?.cancel()
        claims.release(owner: tab.id.rawValue)
        let sessionID = resumableSession(of: tab, kind: kind, cwd: cwd, fresh: fresh)
        let servers = mcp.launch(for: McpLaunchContext(tab: tab.id, kind: kind, project: project, workingDirectory: cwd))
        let request = AgentLaunchRequest(
            kind: kind,
            workingDirectory: cwd,
            extraArguments: tab.extraArguments,
            sessionID: sessionID,
            unrestricted: tab.unrestricted,
            hooks: hooks.launch(for: tab.id, kind: kind, orchestrator: environment.features.isOn(.orchestrator)),
            mcpServers: servers.servers,
            mcpConfigPath: servers.configPath,
            environment: routing
        )
        do {
            let command = try environment.agentLauncher.command(for: request)
            // Taken before the spawn so the session the process creates is the only new one. Files
            // are read right away; OpenCode's list needs its CLI, and OpenCode only records a session
            // with the first message, so that snapshot may finish just after the spawn.
            var before: Task<Set<String>, Never>?
            if SessionResume.discoversNewSessions(kind) && command.sessionID == nil {
                if kind == .opencode {
                    let executable = command.executable
                    before = Task.detached { Set(await SessionResume.snapshot(kind, cwd: cwd, executable: executable).map(\.id)) }
                } else {
                    let ids = Set(SessionResume.sessions(kind, cwd: cwd).map(\.id))
                    before = Task { ids }
                }
            }
            // An agent redraws its own conversation when resumed, so replaying its last screen would
            // stack the previous run's TUI above the new one; only shells get their history back.
            let scrollbackFile = scrollback(for: tab.id, environment: environment)
            if kind != .shell { scrollbackFile?.clear() }
            let view = try TerminalPaneView(launch: command.ptyLaunch(size: PTYSize(columns: 80, rows: 24)),
                                            theme: environment.theme, fontSize: environment.terminalFontSize,
                                            forceKillNotice: String(localized: "terminal.forceKilled"),
                                            promptHistory: environment.promptHistory?.document.histories[tab.id.rawValue] ?? [],
                                            scrollback: scrollbackFile)
            view.onOpenLink = { [weak environment, weak view] link in
                guard let environment, let view else { return }
                environment.openTerminalLink(link, from: view, tab: tab, project: project)
            }
            view.onLocalServer = { [weak self] url in self?.pageOffers[tab.id] = url }
            view.onPromptHistoryChange = { [weak environment] entries in
                environment?.promptHistory?.update { $0.histories[tab.id.rawValue] = entries }
            }
            view.onExit = { [weak self, weak view, weak environment] code in
                guard let self, let view, self.views[tab.id] === view else { return }
                // A double ⌃C is the user's choice, not a failed resume: show it ended.
                if !view.wasForceKilled, let launch = self.launches[tab.id], let environment,
                   SessionResume.shouldRetryFresh(resumed: launch.resumed, elapsed: .now - launch.startedAt,
                                                  alreadyRetried: self.retriedFresh.contains(tab.id)) {
                    // The saved conversation is gone or unusable: start over without it.
                    self.retriedFresh.insert(tab.id)
                    self.restart(tab, in: project, environment: environment, fresh: true)
                    return
                }
                self.states[tab.id] = view.wasForceKilled ? .forceKilled : .exited(code: code)
                self.output.exit(tab.id, reason: view.wasForceKilled ? "killed" : "exited")
            }
            let relay = output, tabID = tab.id
            view.tap.observeOutput { data in relay.output(tabID, data) }
            views[tab.id] = view
            states[tab.id] = .running
            // Variable names only: their values may be tokens.
            let variables = command.environment.keys.sorted().joined(separator: ",")
            Diagnostics.shared.recordSpawn("started agent=\(kind.rawValue) pid=\(view.processID) cwd=\(cwd) "
                + "executable=\(command.executable ?? "-") resumed=\(sessionID != nil) env=[\(variables)] "
                + "command=\(command.shellCommand ?? "login shell")")
            if kind != .shell {
                watch(tab.id, view: view, heuristicTurns: !hooks.reportsTurns(kind))
                if tab.sessionID != nil { refreshTitle(tab.id) }
            }
            launches[tab.id] = (.now, sessionID != nil)
            if let prompt = tab.initialPrompt, kind != .shell {
                deliver(prompt, to: view, tab: tab.id, style: kind == .opencode ? .typeAndConfirm : .paste,
                        environment: environment)
            }
            if let session = command.sessionID {
                claims.register(kind, cwd: cwd, sessionID: session, owner: tab.id.rawValue)
            }
            if command.sessionID != tab.sessionID, kind != .shell {
                // Not undoable: it records what the process is, not a user edit.
                environment.workspace?.update { $0.updateTab(tab.id) { $0.sessionID = command.sessionID } }
            }
            if let before {
                discoverSession(for: tab.id, kind: kind, cwd: cwd, before: before, executable: command.executable,
                                environment: environment)
            }
        } catch AgentLaunchError.launcherNotFound(let command) {
            states[tab.id] = .notFound(command: command)
            Diagnostics.shared.recordSpawn("not found agent=\(kind.rawValue) command=\(command) cwd=\(cwd)")
            AppLog.record(.warning, .agents, "\(kind.rawValue): \(command) not found")
        } catch {
            states[tab.id] = .failed(message: String(describing: error))
            Diagnostics.shared.recordSpawn("failed agent=\(kind.rawValue) cwd=\(cwd) error=\(error)")
            AppLog.record(.error, .terminal, "\(kind.rawValue) did not start: \(error)")
        }
        generations[tab.id, default: 0] += 1
    }
}

// MARK: - Remote control (P7-12)

extension TerminalRegistry {
    /// Types `text` into the tab's process, as if from the keyboard. False when it runs nothing.
    func typeInput(_ text: String, into tab: TabID) -> Bool {
        guard states[tab] == .running, let view = views[tab] else { return false }
        view.type(text)
        return true
    }

    /// The running tab's grid.
    func gridSize(of tab: TabID) -> PTYSize? {
        guard states[tab] == .running else { return nil }
        return views[tab]?.gridSize
    }

    /// The tab's saved output file, if it has one.
    func scrollbackFile(of tab: TabID) -> ScrollbackFile? {
        scrollbacks[tab] ?? views[tab]?.scrollback
    }

    /// The last `maxBytes` of the tab's saved output, pending bytes included. Reads off the main
    /// thread.
    nonisolated static func scrollbackTail(_ file: ScrollbackFile, maxBytes: Int) async -> Data {
        await Task.detached(priority: .utility) {
            file.flush()
            guard let handle = try? FileHandle(forReadingFrom: file.url) else { return Data() }
            defer { try? handle.close() }
            guard let end = try? handle.seekToEnd() else { return Data() }
            try? handle.seek(toOffset: end > UInt64(maxBytes) ? end - UInt64(maxBytes) : 0)
            return (try? handle.readToEnd()) ?? Data()
        }.value
    }
}

/// Fans every running tab's output out to remote control. Taps call it on the PTY queues; with no
/// observer it only takes a lock.
final class TerminalOutputRelay: @unchecked Sendable {
    enum Event: Sendable {
        case data(TabID, Data)
        case exit(TabID, reason: String)
    }

    private let lock = NSLock()
    private var observers: [UUID: @Sendable (Event) -> Void] = [:]

    func observe(_ observer: @escaping @Sendable (Event) -> Void) -> UUID {
        let id = UUID()
        lock.withLock { observers[id] = observer }
        return id
    }

    func remove(_ id: UUID) {
        lock.withLock { _ = observers.removeValue(forKey: id) }
    }

    func output(_ tab: TabID, _ data: Data) {
        send(.data(tab, data))
    }

    func exit(_ tab: TabID, reason: String) {
        send(.exit(tab, reason: reason))
    }

    private func send(_ event: Event) {
        let current = lock.withLock { Array(observers.values) }
        for observer in current { observer(event) }
    }
}

/// One tab's traffic heuristics, fed from the terminal tap off the main thread.
final class ActivityWatch: @unchecked Sendable {
    private let lock = NSLock()
    private var monitor = ActivityMonitor()
    private let tap: TerminalIOTap
    private var observers: [UUID] = []
    private let endsTurns: Bool
    private let report: @Sendable (AgentActivity) -> Void

    init(tap: TerminalIOTap, endsTurns: Bool, report: @escaping @Sendable (AgentActivity) -> Void) {
        self.tap = tap
        self.endsTurns = endsTurns
        self.report = report
        observers.append(tap.observeInput { [weak self] data in
            guard let self else { return }
            let now = Date().timeIntervalSinceReferenceDate
            if let next = self.lock.withLock({ self.monitor.input(String(decoding: data, as: UTF8.self), at: now) }) {
                self.report(next)
            }
        })
        observers.append(tap.observeOutput { [weak self] data in
            guard let self else { return }
            let now = Date().timeIntervalSinceReferenceDate
            self.lock.withLock { self.monitor.output(String(decoding: data, as: UTF8.self), at: now) }
        })
    }

    func tick() {
        guard endsTurns else { return }
        let now = Date().timeIntervalSinceReferenceDate
        if let next = lock.withLock({ monitor.tick(at: now) }) { report(next) }
    }

    func stop() {
        for id in observers { tap.remove(id) }
    }
}
