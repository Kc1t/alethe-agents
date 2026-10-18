import AletheAgents
import AletheDesign
import AletheFoundation
import AletheGitControl
import AletheIntegrations
import AletheModel
import AlethePluginKit
import AletheTodos
import AletheTerminal
import AletheThemePack
import AppKit
import Foundation
import Observation

/// Composition root: the active profile's documents plus what the UI derives from them.
@Observable
@MainActor
final class AppEnvironment {
    private(set) var profiles: DocumentModel<ProfileIndexDocument>?
    private(set) var workspace: WorkspaceModel?
    private(set) var preferences: PreferencesModel?
    private(set) var promptHistory: PromptHistoryModel?
    /// Reviewed PR head SHAs and the review agent/model (P4-15).
    private(set) var pullRequestReviews: PullRequestReviewsModel?
    private(set) var locations: DataLocations?
    /// The profile this process runs. Fixed for the process: switching writes the index and relaunches,
    /// so files written on the way out still land in this profile.
    private(set) var profileID: ProfileID?
    /// Set right before a relaunch the user already confirmed; the quit question is skipped.
    var relaunching = false
    /// What the launch applied from a scheduled import, reset or erase (P5-10); Settings reports it.
    var dataMaintenanceResult: Result<PendingDataOperation?, any Error> = .success(nil)
    /// Built-in plugins of the active profile (P4-2); created by `load`.
    private(set) var plugins: PluginHost?
    /// Third-party ExtensionKit extensions of the active profile (P4-19); created by `load`.
    private(set) var extensions: ExtensionManager?
    /// Sheet requested by a menu, the sidebar or the workspace.
    var editorRequest: EditorRequest?
    /// The pane shown in focus mode (P2-21); not persisted.
    var focusModePaneID: PaneID?
    /// Web sidebar inspector selection; transient and independent of keyboard focus.
    var inspectedPaneID: PaneID?
    /// Home instead of the workspace (P3-15; ⇧⌘H).
    var showingHome = false
    /// The Settings pane shown.
    var settingsTab = SettingsTab.general
    /// Right sidebar (P4-3; ⌥⌘0), persisted across launches.
    var rightSidebarVisible = UserDefaults.standard.bool(forKey: "main.rightSidebarVisible") {
        didSet { UserDefaults.standard.set(rightSidebarVisible, forKey: "main.rightSidebarVisible") }
    }
    /// The right-sidebar tab shown; nil for the first one.
    var rightSidebarTab: String?
    /// Bumped to focus the new-todo field (the Todos plugin's "New Todo" command).
    var newTodoRequest = 0
    /// Folders asked for (`alethe`, Finder, launch arguments) before the workspace loaded.
    @ObservationIgnored private var pendingFolders: [URL] = []

    /// Launcher lookups are cached across terminals; hits are re-checked on disk.
    let launchers = LauncherCache()
    let terminals = TerminalRegistry()
    /// Memory supervision of the terminals (P2-24).
    let resources = ResourceMonitor()
    /// Agent CLI installs, one at a time (P3-3).
    let installer = AgentInstaller()
    /// Agent notifications and the in-app list (P3-11).
    let notifier = AgentNotifier()
    /// AI usage of the providers (P3-13).
    let usage = UsageMonitor()
    /// Time analytics (P3-14).
    let activity = ActivityTracker()
    /// Dictation (P3-17).
    let dictation = DictationController()
    /// Logs, recent errors and the after-crash notice (P5-11).
    let diagnostics = DiagnosticsController()
    /// ai-memory detection and its MCP server on agent launches (P5-18).
    let aiMemory = AiMemoryController()
    /// Graphify CLI, graphs and the MCP server added to agent launches (P5-17).
    let graphify = GraphifyController()
    /// The Playwright MCP server and its shared browser (P5-19).
    let playwright = PlaywrightBrowser()
    /// GSD Sync child sessions and the OpenCode plugin install (P5-24).
    let gsdSync = GSDSyncController()
    /// Event bus, telemetry and `.planning/` change events for the scheduler and autocommit (P6-18).
    let multiagent = MultiagentController()
    /// The delegation core behind the planners' `alethe_*` tools and the board (P6-9).
    let orchestrator = OrchestratorService()
    /// Remote control (P7-12); off at every launch.
    let remoteControl = RemoteControlController()
    /// Discord Rich Presence (P7-13).
    let discordPresence = DiscordPresenceController()
    /// Spotify's Now Playing (P7-14).
    let nowPlaying = NowPlayingController()
    /// GitHub gist sync (P7-15).
    let gistSync = GistSyncController()
    /// 9router's runtime (P7-16).
    let router9 = Router9Controller()
    /// Models of open Markdown (and later other file) panes.
    let contentPanes = ContentPaneRegistry()
    /// The interface language this process launched with; Settings offers a relaunch when it changes.
    let launchLanguage = LanguageSetting().current()

    /// Dictation follows the interface language, in the user's region.
    var dictationLocale: Locale {
        let language = Bundle.main.preferredLocalizations.first ?? "en"
        let code = Locale.Language(identifier: language).languageCode?.identifier ?? "en"
        return Locale(languageCode: .init(code), languageRegion: Locale.current.region)
    }

    var isLoaded: Bool { workspace != nil && preferences != nil }

    /// Built-in themes plus those contributed by active plugins, for the picker and resolution.
    var themeCatalog: ThemeCatalog {
        guard let plugins, !plugins.contributions.themes.isEmpty else { return .builtin }
        let contributed = plugins.contributions.themes
        if let cache = themeCatalogCache, cache.contributions == contributed { return cache.catalog }
        let catalog = ThemeCatalog.builtin.merging(contributions: contributed)
        themeCatalogCache = (contributed, catalog)
        return catalog
    }

    /// Decoding contributed themes on every `theme` read would be wasteful; keyed by the contributions.
    @ObservationIgnored private var themeCatalogCache: (contributions: [ThemeContribution], catalog: ThemeCatalog)?

    var theme: Theme {
        themeCatalog.resolved(id: preferences?.document.themeID ?? PreferencesDocument.defaultThemeID)
            .styled(visualStyle)
    }

    var visualStyle: VisualStyle {
        preferences?.document.visualStyle.flatMap(VisualStyle.init(rawValue:)) ?? .normal
    }

    /// Web-identical or native interface. A per-Mac choice (not part of the imported preferences).
    var interfaceStyle: InterfaceStyle = UserDefaults.standard.string(forKey: "interfaceStyle")
        .flatMap(InterfaceStyle.init(rawValue:)) ?? .web {
        didSet { UserDefaults.standard.set(interfaceStyle.rawValue, forKey: "interfaceStyle") }
    }

    /// macOS Reduce Motion, kept current by `load`.
    private(set) var systemReducesMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    /// Reduced motion by preference or by macOS Reduce Motion (upstream `motionPreference`).
    var reducesMotion: Bool { preferences?.document.reducedMotion == true || systemReducesMotion }

    /// Terminal text follows the UI zoom.
    var terminalFontSize: Float {
        TerminalAppearance.defaultFontSize * Float(preferences?.document.uiScale ?? 1)
    }

    var metrics: Metrics {
        Metrics(scale: CGFloat(preferences?.document.uiScale ?? 1), style: visualStyle, interface: interfaceStyle,
                reducesMotion: reducesMotion)
    }

    /// Optional modules (P5-3); every gated surface reads this.
    var features: Features { preferences?.document.features ?? .defaults }

    /// The skills of every agent under the integrations home (P5-15).
    var skillStore: SkillStore { SkillStore(home: Self.integrationsHome) }

    /// The MCP tab and manager of the active profile (P5-25); created by `load`.
    private(set) var mcp: McpManagerModel?

    /// The agents' MCP configs under the integrations home; `McpHome.current()` (which honors
    /// `XDG_CONFIG_HOME`) unless a test home is set.
    static var mcpHome: McpHome {
        integrationsHomeOverridden ? McpHome(home: integrationsHome) : .current()
    }

    static var integrationsHomeOverridden: Bool {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "AletheIntegrationsHome") != nil
        #else
        return false
        #endif
    }

    /// The home folder whose agent configs and skills the integrations read and write.
    /// `-AletheIntegrationsHome <path>` (debug builds) points it elsewhere, like upstream's
    /// `ALETHE_MCP_HOME`, so UI tests work on a seeded throwaway home.
    static var integrationsHome: URL {
        #if DEBUG
        if let home = UserDefaults.standard.string(forKey: "AletheIntegrationsHome") {
            return URL(filePath: home, directoryHint: .isDirectory)
        }
        #endif
        return FileManager.default.homeDirectoryForCurrentUser
    }

    /// Builds agent commands with the user's CLI path overrides.
    var agentLauncher: AgentLauncher {
        AgentLauncher(registry: agentRegistry, launchers: launchers, overrides: preferences?.document.cliPaths ?? [:])
    }

    #if DEBUG
    var loadingSampleData = false
    #endif

    private(set) var startupFinished = false

    @ObservationIgnored private var startupTask: Task<Void, Never>?

    func load() async {
        if let startupTask { await startupTask.value; return }
        let task = Task { await loadOnce() }
        startupTask = task
        await task.value
    }

    private func loadOnce() async {
        defer { startupFinished = true }
        guard !isLoaded, let locations = try? Self.dataLocations() else { return }
        self.locations = locations
        // An import, reset or erase confirmed before the relaunch (P5-10) applies before anything loads.
        dataMaintenanceResult = await Task.detached { () -> Result<PendingDataOperation?, any Error> in
            Result { try DataMaintenance.applyPending(in: locations) }
        }.value
        #if DEBUG
        // `-AletheUITestCrashMarker YES`: the previous run "crashed" (an unclean marker is seeded).
        if UserDefaults.standard.bool(forKey: "AletheUITestCrashMarker") {
            SessionMarkerStore(logsDirectory: locations.logs).begin(
                SessionMarker(startedAt: .now.addingTimeInterval(-60), appVersion: "0.0-test", build: "0", processID: 1))
        }
        #endif
        await diagnostics.start(logs: locations.logs)
        await multiagent.start(logs: locations.logs)
        let profiles = await DocumentModel<ProfileIndexDocument>.load(from: locations.profileIndex)
        let profile = profiles.document.activeProfile.id
        profileID = profile
        async let workspace = WorkspaceModel.load(from: locations.workspace(profile))
        async let preferences = PreferencesModel.load(from: locations.preferences(profile))
        async let promptHistory = PromptHistoryModel.load(from: locations.promptHistory(profile))
        async let reviews = PullRequestReviewsModel.load(from: locations.pullRequestReviews(profile))
        let (loadedWorkspace, loadedPreferences, loadedHistory) = await (workspace, preferences, promptHistory)
        pullRequestReviews = await reviews
        loadedWorkspace.update { $0.repair() }
        await SidebarProjectVisibility.migrate(loadedWorkspace, profile: profile)
        if loadedPreferences.document.startClean == true { loadedWorkspace.update { $0.startClean() } }
        showingHome = loadedPreferences.document.startOnHome == true && !loadedWorkspace.document.projects.isEmpty
        let tabs = Set(loadedWorkspace.document.projects.flatMap(\.panes).flatMap(\.tabs).map(\.id))
        if loadedHistory.document.histories.keys.contains(where: { !tabs.contains(TabID(rawValue: $0)) }) {
            loadedHistory.update { $0.prune(keeping: tabs) }
        }
        Self.removeOrphanScrollback(in: locations.scrollback(profile), keeping: tabs)
        Handoff.pruneOld(in: locations.handoffs(profile))
        // Plugins load before the preferences are published, so a pack theme applies on the first frame.
        let plugins = PluginHost(plugins: Self.builtinPlugins, dataRoot: locations.profileDirectory(profile),
                                 services: Self.pluginServices)
        TodosPlugin.onNewTodo = { [weak self] in
            guard let self else { return }
            self.showTodos()
            self.newTodoRequest += 1
        }
        GitControlPlugin.onOpen = { [weak self] in
            self?.openPluginSheet(GitControlPlugin.sheetID, project: nil)
        }
        await plugins.load()
        self.plugins = plugins
        let extensions = ExtensionManager(profileDirectory: locations.profileDirectory(profile))
        self.extensions = extensions
        // Plugin and extension events reach the bus from launch on; failures held so far go out now.
        plugins.events.attach(multiagent.bus)
        extensions.events.attach(multiagent.bus)
        Task { await extensions.start() }
        #if DEBUG
        if let seed = UserDefaults.standard.string(forKey: "AletheUITestSeed"), loadedWorkspace.document.projects.isEmpty {
            loadedWorkspace.update { TestSeeds.apply(seed, to: &$0) }
            loadedPreferences.update { TestSeeds.apply(seed, to: &$0) }
        }
        // `-AletheUITestPreview <file name in the data root>`: opens the link preview at launch.
        if let name = UserDefaults.standard.string(forKey: "AletheUITestPreview") {
            editorRequest = .previewLink(.file(locations.root.appending(path: name).path))
        }
        #endif
        // The hook bridge listens before any terminal starts, so the first launches are wired too.
        terminals.hookEnvironment = self
        orchestrator.start(profileDirectory: locations.profileDirectory(profile), launchers: launchers,
                           overrides: { [weak self] in self?.preferences?.document.cliPaths ?? [:] },
                           isEnabled: { [weak self] in self?.features.isOn(.orchestrator) == true })
        OrchestratorWiring.start(environment: self)
        graphify.start(environment: self)
        playwright.start(profileDirectory: locations.browserSession(profile), wiring: terminals.mcp, environment: self)
        notifier.start(environment: self)
        await terminals.hooks.start(terminals: terminals)
        self.profiles = profiles
        self.workspace = loadedWorkspace
        if interfaceStyle == .web {
            for project in loadedWorkspace.document.projects where project.gsdWatcherEnabled == true {
                try? await multiagent.follow(projectID: project.id.rawValue, folder: URL(filePath: project.folder), by: .projectPreference)
            }
        }
        self.preferences = loadedPreferences
        await orchestrator.applySettings(loadedPreferences.document.orchestration ?? .init())
        await orchestrator.applyWorkerRules(interfaceStyle == .web ? loadedPreferences.document.workerRuleSets : [])
        aiMemory.start(environment: self)
        gsdSync.start(environment: self, profileDirectory: locations.profileDirectory(profile))
        mcp = makeMcpModel(profileDirectory: locations.profileDirectory(profile), preferences: loadedPreferences)
        followAppIcon()
        self.promptHistory = loadedHistory
        resources.start(environment: self)
        usage.start(environment: self)
        activity.start(environment: self, file: locations.activityStats(profile))
        dictation.start(environment: self)
        // Peripherals (Phase 7): each does nothing until the user turns it on or connects it.
        remoteControl.start(environment: self)
        discordPresence.start(environment: self)
        nowPlaying.start(environment: self)
        gistSync.start(environment: self)
        router9.start(environment: self)
        #if DEBUG
        if let seed = UserDefaults.standard.string(forKey: "AletheUITestSeed") { TestSeeds.apply(seed, to: self) }
        #endif
        let requested = pendingFolders
        pendingFolders = []
        requested.forEach(openFolder)
        if diagnostics.crashNotice != nil, editorRequest == nil, Self.showsCrashNotice { editorRequest = .crashNotice }
        greetLaunch()
        offerMcpIntro()
        #if DEBUG
        if ProcessInfo.processInfo.environment["ALETHE_SAMPLE_DATA"] == "1" { await loadSampleData() }
        #endif
        NotificationCenter.default.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
                                               object: NSWorkspace.shared, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.systemReducesMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            }
        }
    }

    /// An open request for a folder (TERM-11; upstream `cli_launch.rs`): the matching project is
    /// shown, an unknown folder offers New Project with it filled in. A file stands for its folder.
    func openFolder(_ url: URL) {
        guard let workspace else {
            pendingFolders.append(url)
            return
        }
        let document = workspace.document
        let candidates = document.projects.map { (id: $0.id, folder: $0.folder) }
        let selected = document.workspace.selectedProjectID
        Task {
            // Resolving symlinks touches the disk: off the main thread.
            let found: (folder: URL, project: ProjectID?)? = await Task.detached {
                guard let folder = CLILaunch.directory(for: url) else { return nil }
                return (folder, CLILaunch.match(folder: folder.path, in: candidates, preferred: selected))
            }.value
            guard let found else { return }
            if let project = found.project {
                self.workspace?.update { $0.open(project) }
                showingHome = false
            } else {
                editorRequest = .newProject(.ungrouped, folder: found.folder.path)
            }
            NSApp.activate()
        }
    }

    /// `--open-path <folder>` (or a bare path) on the command line, relative to the launch folder.
    func openLaunchArguments() {
        guard let raw = CLILaunch.pathArgument(in: CommandLine.arguments) else { return }
        let cwd = URL(filePath: FileManager.default.currentDirectoryPath, directoryHint: .isDirectory)
        let expanded = (raw as NSString).expandingTildeInPath
        openFolder(expanded.hasPrefix("/") ? URL(filePath: expanded) : cwd.appending(path: expanded))
    }

    /// The saved output of a terminal tab (`scrollback/<tab>.bin` in the active profile).
    func scrollbackFile(for tab: TabID) -> ScrollbackFile? {
        guard let locations, let profile = profileID else { return nil }
        return ScrollbackFile(url: locations.scrollback(profile).appending(path: "\(tab.rawValue).bin"))
    }

    /// Scrollback of tabs that no longer exist (closed while the app was not running, or by undo).
    private static func removeOrphanScrollback(in directory: URL, keeping tabs: Set<TabID>) {
        let names = Set(tabs.map { "\($0.rawValue).bin" })
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension == "bin" && !names.contains(file.lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// Running terminals, agents counted apart (the quit confirmation names them).
    var runningTerminals: (agents: Int, shells: Int) {
        guard let document = workspace?.document else { return (0, 0) }
        var agents = 0, shells = 0
        for (tab, _) in terminals.running {
            if document.paneHolding(tab)?.pane.tabs.first(where: { $0.id == tab })?.agent == "shell" { shells += 1 } else { agents += 1 }
        }
        return (agents, shells)
    }

    /// Writes every pending change; called before the app quits.
    func flush() async {
        await activity.finish()
        // Remote devices are revoked before the terminals they watch end.
        await remoteControl.stop()
        await router9.stop()
        await discordPresence.stop()
        await plugins?.shutdown()
        await extensions?.shutdown()
        terminals.terminateAll()
        await orchestrator.shutdown()
        terminals.hooks.stop()
        await playwright.stop()
        await multiagent.stop()
        await workspace?.flush()
        await preferences?.flush()
        await promptHistory?.flush()
        await pullRequestReviews?.flush()
        await profiles?.flush()
    }

    /// The Todos plugin's store while it is enabled. Reading `plugins` first makes views observe
    /// enabling and disabling (the store itself is a static of the plugin).
    var todoStore: TodoStore? {
        guard plugins?.record(for: TodosPlugin.manifest.id)?.state == .active else { return nil }
        return TodosPlugin.activeStore
    }

    /// Opens the right sidebar on the Todos tab.
    func showTodos() {
        rightSidebarTab = TodosPlugin.sidebarTabID
        rightSidebarVisible = true
    }

    /// Host services behind plugin capabilities. File access is whole-file; writes create the folder.
    private static let pluginServices = PluginServices(
        readFile: { url in
            try await Task.detached { try Data(contentsOf: url) }.value
        },
        writeFile: { data, url in
            try await Task.detached {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
            }.value
        }
    )

    /// Plugins compiled into the app, in registration order.
    static let builtinPlugins: [any AlethePlugin.Type] = [ThemePackPlugin.self, TodosPlugin.self, GitControlPlugin.self]

    /// Whether an active plugin contributes the command `id`.
    func hasPluginCommand(_ id: String) -> Bool {
        plugins?.contributions.commands.contains { $0.id == id } == true
    }

    /// Runs an active plugin's command; nothing when its plugin is disabled.
    func performPluginCommand(_ id: String) {
        plugins?.contributions.commands.first { $0.id == id }?.perform()
    }

    /// Presents an active plugin's sheet for a project (nil: the selected one).
    func openPluginSheet(_ id: String, project: ProjectID?) {
        guard let sheet = plugins?.contributions.sheets.first(where: { $0.id == id }) else { return }
        editorRequest = .pluginSheet(viewID: sheet.viewID, project: project)
    }

    private func makeMcpModel(profileDirectory: URL, preferences: PreferencesModel) -> McpManagerModel {
        let model = McpManagerModel(
            store: McpStore(home: Self.mcpHome, writer: ConfigFileWriter(profileDirectory: profileDirectory)),
            registry: McpRegistry(profileDirectory: profileDirectory),
            healthAvailable: !Self.integrationsHomeOverridden,
            scope: preferences.document.mcpDefaultScope == McpScope.project.rawValue ? .project : .global
        )
        model.onScopeChange = { [weak preferences] scope in
            preferences?.update { $0.mcpDefaultScope = scope == .global ? nil : scope.rawValue }
        }
        return model
    }

    /// Upstream `useMcpIntroPrompt`: the MCP intro, once, and only to someone with an agent config;
    /// never over another sheet (it is offered again on the next launch).
    private func offerMcpIntro() {
        guard features.isOn(.mcp), preferences?.document.mcpOnboardingSeen != true, Self.showsMcpIntro,
              let store = mcp?.store else { return }
        // The onboarding has its own MCP step, so the intro would repeat it.
        if case .onboarding = editorRequest {
            preferences?.update { $0.mcpOnboardingSeen = true }
            return
        }
        Task {
            guard let snapshots = try? await store.scan(scope: .global, repository: nil) else { return }
            if snapshots.contains(where: { $0.sources.contains(where: \.exists) }) {
                if editorRequest == nil { editorRequest = .mcpIntro }
            } else {
                preferences?.update { $0.mcpOnboardingSeen = true }
            }
        }
    }

    /// With a test data root the intro would cover every UI test's window: it shows only when asked.
    private static var showsMcpIntro: Bool {
        #if DEBUG
        if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil {
            return UserDefaults.standard.bool(forKey: "AletheUITestMcpIntro")
        }
        #endif
        return true
    }

    /// UI tests end the app without quitting it, so every relaunch would look like a crash: with a
    /// test data root the notice appears only for the seeded marker.
    private static var showsCrashNotice: Bool {
        #if DEBUG
        if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil {
            return UserDefaults.standard.bool(forKey: "AletheUITestCrashMarker")
        }
        #endif
        return true
    }

    /// `-AletheDataRoot <path>` (debug builds) points the app at another data folder: UI tests and
    /// manual experiments never touch the real one.
    private static func dataLocations() throws -> DataLocations {
        #if DEBUG
        if let root = UserDefaults.standard.string(forKey: "AletheDataRoot") {
            return DataLocations(root: URL(filePath: root, directoryHint: .isDirectory))
        }
        #endif
        return try DataLocations.application()
    }
}
