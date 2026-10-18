import AletheFoundation
import Foundation

/// One-shot, read-only import of the Tauri app's `projects.json` (ADR-4): groups, projects, their
/// terminal panes and the core preferences. The Tauri files are never written.
///
/// Every version from 2 to 9 is read: the fields imported here (group tree, project, terminal and
/// sub-tab basics, theme/zoom/language/agents) kept their shape across upstream migrations v2 → v9
/// (`projectsStore.migrations.ts`), which only added fields this importer ignores.
public enum TauriImport {
    public static let supportedVersions = 2...9

    public enum Failure: Error, Equatable, Sendable {
        /// Not a readable JSON object.
        case unreadable
        /// A schema this importer does not know (nil: no version field).
        case unsupportedVersion(Int?)
    }

    /// Something left out of the import, and why.
    public enum Skip: Hashable, Sendable {
        /// Neither a default folder nor a terminal working directory to use as its folder.
        case projectWithoutFolder(project: String)
        /// A project for the same folder is already in the workspace.
        case projectAlreadyAdded(project: String)
        /// Hidden in the Tauri app; the native app has no archive yet.
        case projectArchived(project: String)
        /// A pane that is not a terminal or an orchestrator board (markdown, web, file, diff…), not
        /// imported yet.
        case paneKind(project: String, kind: String)
        /// A tab whose agent the native app does not run (yet).
        case agent(project: String, agent: String)
    }

    public struct Report: Hashable, Sendable {
        public var groups = 0
        public var projects = 0
        public var panes = 0
        public var tabs = 0
        public var skipped: [Skip] = []
        /// Preferences that were changed.
        public var preferences: Set<Preference> = []
        /// The Tauri app's interface language (`en`, `pt-BR`); app-wide, so the caller applies it.
        public var language: String?
        /// Secrets found (names only; the values come from `secrets(in:companions:context:)`), which
        /// the caller writes to the Keychain.
        public var secrets: Set<KeychainItem> = []
        /// The gist sync status from `github_sync.json`, without its token; the caller merges it into
        /// the profile's `github_sync.json`.
        public var gistSync: GistSyncState?

        public init() {}

        public var isEmpty: Bool {
            groups == 0 && projects == 0 && preferences.isEmpty && language == nil && secrets.isEmpty && gistSync == nil
        }
    }

    public enum Preference: String, Hashable, Sendable, CaseIterable {
        case theme, interfaceSize, enabledAgents, alwaysUnrestricted, cliPaths, features, appIcon, toolbar, mcp
        /// Spotify's client ID and Discord Rich Presence.
        case integrations
        case router9
        case remote
    }

    /// Secret values to write to the Keychain. Never logged: `description` names the items only.
    public struct Secrets: Sendable, CustomStringConvertible {
        public var values: [KeychainItem: Data] = [:]

        public init() {}

        public var description: String { "Secrets(\(values.keys.map(\.rawValue).sorted()))" }
    }

    /// The files upstream keeps beside `projects.json` in a profile folder that the import also reads:
    /// `spotify_tokens.json` and `github_sync.json`. Both hold plaintext tokens.
    public struct Companions: Sendable {
        public static let spotifyTokensFileName = "spotify_tokens.json"
        public static let githubSyncFileName = "github_sync.json"

        public var spotifyTokens: SpotifyTokens?
        public var githubToken: String?
        public var gistSync: GistSyncState?

        public init() {}

        /// Parses the files' contents; missing or unreadable ones are ignored.
        public init(spotifyTokens: Data?, githubSync: Data?) {
            if let data = spotifyTokens, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let access = raw["access_token"] as? String, let refresh = raw["refresh_token"] as? String,
               !access.isEmpty || !refresh.isEmpty {
                let expiry = (raw["expires_at"] as? Double) ?? 0
                self.spotifyTokens = SpotifyTokens(accessToken: access, refreshToken: refresh,
                                                   expiresAt: Date(timeIntervalSince1970: expiry))
            }
            if let data = githubSync, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                githubToken = (raw["token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty
                let login = (raw["login"] as? String)?.nilIfEmpty
                let gist = (raw["gist_id"] as? String)?.nilIfEmpty
                // The Tauri app's push and pull times describe its own gist, not the one this app
                // creates, so they are not carried over.
                if login != nil || gist != nil { gistSync = GistSyncState(login: login, tauriGistID: gist) }
            }
        }

        /// Reads the files beside `projectsFile`. Blocking: callers run it off the main thread.
        public static func beside(_ projectsFile: URL) -> Companions {
            let folder = projectsFile.deletingLastPathComponent()
            return Companions(spotifyTokens: try? Data(contentsOf: folder.appending(path: spotifyTokensFileName)),
                              githubSync: try? Data(contentsOf: folder.appending(path: githubSyncFileName)))
        }
    }

    /// What the importer needs to know about the native app, injected to keep this module free of
    /// the agent and design modules (and the file system).
    public struct Context: Sendable {
        public var agents: Set<String>
        public var themes: Set<String>
        public var includePreferences: Bool
        public var fileExists: @Sendable (String) -> Bool

        public init(agents: Set<String>, themes: Set<String>, includePreferences: Bool = true,
                    fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) {
            self.agents = agents
            self.themes = themes
            self.includePreferences = includePreferences
            self.fileExists = fileExists
        }
    }

    // MARK: - Reading

    /// A parsed `projects.json`.
    public struct File: @unchecked Sendable {
        public let version: Int
        let root: [String: Any]

        public init(data: Data) throws(Failure) {
            guard let object = try? JSONSerialization.jsonObject(with: data), let root = object as? [String: Any] else {
                throw .unreadable
            }
            let version = root["version"] as? Int
            guard let version, TauriImport.supportedVersions.contains(version) else {
                throw .unsupportedVersion(version)
            }
            self.version = version
            self.root = root
        }

        var groups: [[String: Any]] { root["groups"] as? [[String: Any]] ?? [] }
        var projects: [[String: Any]] { root["projects"] as? [[String: Any]] ?? [] }
        var ungroupedOrder: [String] { root["ungroupedOrder"] as? [String] ?? [] }
        var preferences: [String: Any] { root["preferences"] as? [String: Any] ?? [:] }
        var cliPaths: [String: Any] { root["cliPaths"] as? [String: Any] ?? [:] }
    }

    // MARK: - Applying

    /// Adds the file's groups and projects to `workspace` and its preferences to `preferences`.
    /// Pure: run it on copies for a preview, on the live documents to import.
    /// Secrets and the gist sync status come with the preferences; their values are read separately
    /// through `secrets(in:companions:context:)`.
    @discardableResult
    public static func apply(_ file: File, companions: Companions = Companions(), to workspace: inout WorkspaceDocument,
                             preferences: inout PreferencesDocument, context: Context) -> Report {
        var report = Report()
        let groupIDs = importGroups(file, into: &workspace, report: &report)
        importProjects(file, into: &workspace, groupIDs: groupIDs, context: context, report: &report)
        importScopeGrids(file, into: &workspace, preferences: &preferences, groupIDs: groupIDs, includePreferences: context.includePreferences)
        if context.includePreferences {
            importPreferences(file, into: &preferences, context: context, report: &report)
            report.secrets = Set(secrets(in: file, companions: companions, context: context).values.keys)
            report.gistSync = companions.gistSync
        }
        return report
    }

    /// The plaintext secrets of the Tauri profile (upstream `spotifyClientSecret`, `router9.apiKey`,
    /// `spotify_tokens.json`, `github_sync.json`'s token), for the Keychain. Empty values are skipped;
    /// nothing when preferences are not imported.
    public static func secrets(in file: File, companions: Companions, context: Context) -> Secrets {
        var secrets = Secrets()
        guard context.includePreferences else { return secrets }
        let raw = file.preferences
        if let value = (raw["spotifyClientSecret"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            secrets.values[.spotifyClientSecret] = Data(value.utf8)
        }
        if let value = ((raw["router9"] as? [String: Any])?["apiKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            secrets.values[.router9APIKey] = Data(value.utf8)
        }
        if let tokens = companions.spotifyTokens, let data = try? JSONEncoder().encode(tokens) {
            secrets.values[.spotifyTokens] = data
        }
        if let token = companions.githubToken { secrets.values[.githubToken] = Data(token.utf8) }
        return secrets
    }

    /// Recreates the group tree, parents first, in the file's sibling order. A group with the same
    /// name under the same parent is reused, so importing twice does not duplicate the tree.
    private static func importGroups(_ file: File, into workspace: inout WorkspaceDocument,
                                     report: inout Report) -> [String: GroupID] {
        let groups = file.groups.filter { $0["archived"] as? Bool != true }
        let known = Set(groups.compactMap { $0["id"] as? String })
        var mapped: [String: GroupID] = [:]
        var pending = groups
        while !pending.isEmpty {
            let before = pending.count
            pending.removeAll { group in
                guard let id = group["id"] as? String else { return true }
                let parent = (group["parentGroupId"] as? String).flatMap { known.contains($0) ? $0 : nil }
                if let parent, mapped[parent] == nil { return false }
                let parentID = parent.flatMap { mapped[$0] }
                let name = (group["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Group"
                if let existing = workspace.childGroups(of: parentID).first(where: { $0.name == name }) {
                    mapped[id] = existing.id
                } else {
                    let created = workspace.addGroup(name: name, color: projectColor(group["color"]), parent: parentID)
                    workspace.updateGroup(created) {
                        $0.isCollapsed = group["collapsed"] as? Bool ?? false
                        $0.iconUrl = group["iconUrl"] as? String
                    }
                    mapped[id] = created
                    report.groups += 1
                }
                return true
            }
            // A parent cycle: the rest become top-level groups on the next pass.
            if pending.count == before {
                pending = pending.map { var group = $0; group["parentGroupId"] = nil; return group }
            }
        }
        return mapped
    }

    private static func importProjects(_ file: File, into workspace: inout WorkspaceDocument, groupIDs: [String: GroupID],
                                       context: Context, report: inout Report) {
        let existingFolders = Set(workspace.projects.map { normalizedFolder($0.folder) })
        // Sidebar order: each group's `projectIds`, then `ungroupedOrder`, then anything unreferenced.
        var location: [String: String?] = [:]
        var order: [String] = []
        for group in file.groups {
            guard let groupID = group["id"] as? String else { continue }
            for projectID in group["projectIds"] as? [String] ?? [] where location[projectID] == nil {
                location[projectID] = .some(groupID)
                order.append(projectID)
            }
        }
        for projectID in file.ungroupedOrder where location[projectID] == nil {
            location[projectID] = .some(nil)
            order.append(projectID)
        }
        let byID = Dictionary(file.projects.compactMap { p in (p["id"] as? String).map { ($0, p) } },
                              uniquingKeysWith: { first, _ in first })
        for project in file.projects {
            guard let id = project["id"] as? String, location[id] == nil else { continue }
            location[id] = .some(project["groupId"] as? String)
            order.append(id)
        }

        for projectID in order {
            guard let project = byID[projectID] else { continue }
            let name = (project["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Project"
            if project["archived"] as? Bool == true {
                report.skipped.append(.projectArchived(project: name))
                continue
            }
            let terminals = project["terminals"] as? [[String: Any]] ?? []
            guard let folder = folder(of: project, terminals: terminals) else {
                report.skipped.append(.projectWithoutFolder(project: name))
                continue
            }
            if existingFolders.contains(normalizedFolder(folder)) {
                report.skipped.append(.projectAlreadyAdded(project: name))
                continue
            }
            let place = (location[projectID] ?? nil).flatMap { groupIDs[$0] }.map { ProjectLocation.group($0) } ?? .ungrouped
            let created = workspace.addProject(name: name, folder: folder,
                                               color: projectColor(project["color"]) ?? .blue, in: place)
            workspace.updateProject(created) { $0.iconUrl = project["iconUrl"] as? String }
            report.projects += 1
            var panes: [Pane] = []
            for terminal in terminals {
                if let kind = terminal["kind"] as? String, kind != "terminal" {
                    if kind == PaneContent.Kind.orchestrator.rawValue {
                        panes.append(orchestratorPane(from: terminal))
                    } else if kind == "graphify" || kind == "diff" {
                        var imported = orchestratorPane(from: terminal)
                        imported.content = kind == "graphify" ? .graphify
                            : .diff(path: terminal["filePath"] as? String, staged: terminal["staged"] as? Bool ?? false)
                        panes.append(imported)
                    } else if ["image", "video", "markdown"].contains(kind), let path = terminal["filePath"] as? String {
                        var imported = orchestratorPane(from: terminal)
                        switch kind {
                        case "image": imported.content = .image(path: path)
                        case "video": imported.content = .video(path: path)
                        default: imported.content = .markdown(path: path)
                        }
                        panes.append(imported)
                    } else {
                        report.skipped.append(.paneKind(project: name, kind: kind))
                    }
                    continue
                }
                if let pane = pane(from: terminal, folder: folder, project: name, context: context, report: &report) {
                    panes.append(pane)
                }
            }
            if let createdAt = (project["createdAt"] as? Double).map({ Date(timeIntervalSince1970: $0 / 1000) }) {
                workspace.updateProject(created) { $0.createdAt = createdAt }
            }
            workspace.updateProject(created) { target in
                target.panes = panes
                if let raw = project["paneGroups"], JSONSerialization.isValidJSONObject(raw),
                   let data = try? JSONSerialization.data(withJSONObject: raw) {
                    target.paneGroups = try? JSONDecoder().decode([PaneGroup].self, from: data)
                    target.reconcilePaneGroups()
                }
            }
            workspace.updateProject(created) {
                $0.validationCommands = project["validationCommands"] as? [String]
                $0.healthCheckCommand = project["healthCheckCommand"] as? String
                $0.healthCheckPath = project["healthCheckPath"] as? String
                $0.conflictAgentProvider = project["conflictAgentProvider"] as? String
                $0.conflictAgentModel = project["conflictAgentModel"] as? String
                $0.gsdWatcherEnabled = project["gsdWatcherEnabled"] as? Bool
            }
            if project["autoWorktree"] as? Bool == true { workspace.updateProject(created) { $0.autoWorktree = true } }
            if project["graphifyEnabled"] as? Bool == true { workspace.updateProject(created) { $0.graphifyEnabled = true } }
            if let mode = (project["worktreeMode"] as? String).flatMap(ProjectWorktreeMode.init(rawValue:)) {
                workspace.updateProject(created) { $0.worktreeMode = mode }
            }
            if (project["activeGridId"] as? String).map({ $0 == "default" }) ?? true,
               let mode = (project["layoutMode"] as? String).flatMap(PaneLayoutMode.init(rawValue:)), mode != .auto {
                workspace.updateProject(created) { $0.layoutMode = mode }
            }
            let named: [ProjectGrid] = (project["grids"] as? [[String: Any]] ?? []).compactMap { raw in
                guard let id = raw["id"] as? String, id != "default", let gridName = raw["name"] as? String else { return nil }
                return ProjectGrid(id: ProjectGridID(rawValue: id), name: gridName,
                                   layoutMode: (raw["layoutMode"] as? String).flatMap(PaneLayoutMode.init(rawValue:)).flatMap { $0 == .auto ? nil : $0 },
                                   gridLayout: raw["gridLayout"].flatMap(decodeGrid))
            }
            // Upstream mirrors the active named grid into the project's own layout fields; the
            // main grid keeps them only when no named grid is active.
            let activeNamed = (project["activeGridId"] as? String).flatMap { id in named.first { $0.id.rawValue == id } }
            if !named.isEmpty {
                let known = Set(named.map(\.id))
                workspace.updateProject(created) { project in
                    project.grids = named
                    for index in project.panes.indices where project.panes[index].gridID.map({ !known.contains($0) }) == true {
                        project.panes[index].gridID = nil
                    }
                    project.activeGridID = activeNamed?.id
                }
            }
            if activeNamed == nil, let raw = project["gridLayout"], let grid = decodeGrid(raw) {
                workspace.updateProject(created) { $0.gridLayout = grid.reconciled($0.panes(in: nil).map(\.id.rawValue)) }
            }
            report.panes += panes.count
            report.tabs += panes.reduce(0) { $0 + $1.tabs.count }
        }
    }

    /// An orchestrator board (upstream `createOrchestratorPane`): no tabs, so only its id and grid
    /// are kept. Its stack membership is imported with the project's paneGroups.
    static func orchestratorPane(from terminal: [String: Any]) -> Pane {
        let id = (terminal["id"] as? String).flatMap { $0.isEmpty ? nil : PaneID(rawValue: $0) } ?? .make()
        var pane = Pane(id: id, content: .orchestrator)
        pane.gridID = (terminal["gridId"] as? String).flatMap { $0.isEmpty || $0 == "default" ? nil : ProjectGridID(rawValue: $0) }
        return pane
    }

    private static func importScopeGrids(_ file: File, into workspace: inout WorkspaceDocument,
                                         preferences: inout PreferencesDocument, groupIDs: [String: GroupID],
                                         includePreferences: Bool) {
        var mapped: [String: String] = [:]
        for raw in file.projects {
            guard let old = raw["id"] as? String,
                  let folder = folder(of: raw, terminals: raw["terminals"] as? [[String: Any]] ?? []),
                  let project = workspace.projects.first(where: { normalizedFolder($0.folder) == normalizedFolder(folder) }) else { continue }
            mapped[old] = project.id.rawValue
        }
        func grid(_ raw: Any?) -> CustomGrid? {
            guard let raw, var result = decodeGrid(raw) else { return nil }
            result.cells = Dictionary(result.cells.compactMap { key, cell in mapped[key].map { ($0, cell) } },
                                      uniquingKeysWith: { first, _ in first })
            return result
        }
        func history(_ raw: Any?) -> [CustomGridHistoryEntry]? {
            guard let entries = raw as? [[String: Any]] else { return nil }
            return entries.compactMap { entry in
                guard let id = entry["id"] as? String, let at = entry["savedAt"] as? Double,
                      let layout = grid(entry["layout"]) else { return nil }
                return CustomGridHistoryEntry(id: id, savedAt: Date(timeIntervalSince1970: at / 1000), layout: layout)
            }
        }
        for raw in file.groups {
            guard let old = raw["id"] as? String, let id = groupIDs[old], let layout = grid(raw["gridLayout"]) else { continue }
            let recent = history(raw["gridLayoutHistory"])
            workspace.updateGroup(id) {
                $0.layoutMode = (raw["layoutMode"] as? String).flatMap(PaneLayoutMode.init(rawValue:))
                $0.gridLayout = layout
                $0.gridLayoutHistory = recent
            }
        }
        if includePreferences {
            preferences.workspaceGridLayout = grid(file.preferences["workspaceGridLayout"])
            preferences.workspaceGridLayoutHistory = history(file.preferences["workspaceGridLayoutHistory"])
        }
    }

    // MARK: - Orchestrator history

    /// Upstream `orchestrator_store_path`: the job history beside `projects.json` in a profile.
    public static let orchestratorJobsFileName = "orchestrator-jobs.json"

    /// Copies the Tauri profile's orchestrator job history into `profileDirectory` when that profile
    /// has none yet; an existing history is never replaced. True when a file was copied.
    @discardableResult
    public static func copyOrchestratorJobs(from projectsFile: URL, into profileDirectory: URL,
                                            fileManager: FileManager = .default) -> Bool {
        let source = projectsFile.deletingLastPathComponent().appending(path: orchestratorJobsFileName)
        let target = profileDirectory.appending(path: orchestratorJobsFileName)
        guard fileManager.fileExists(atPath: source.path), !fileManager.fileExists(atPath: target.path) else { return false }
        do {
            try fileManager.createDirectory(at: profileDirectory, withIntermediateDirectories: true)
            try fileManager.copyItem(at: source, to: target)
            return true
        } catch {
            return false
        }
    }

    /// A terminal's tabs the native app can run; nil when none is left.
    static func pane(from terminal: [String: Any], folder: String, project: String, context: Context,
                             report: inout Report) -> Pane? {
        var tabs: [PaneTab] = []
        var activeTab: TabID?
        for tab in terminal["tabs"] as? [[String: Any]] ?? [] {
            let agent = tab["type"] as? String ?? "shell"
            guard context.agents.contains(agent) else {
                report.skipped.append(.agent(project: project, agent: agent))
                continue
            }
            let cwd = (tab["cwd"] as? String) ?? (terminal["cwd"] as? String)
            let own = cwd.flatMap { isAbsolute($0) && normalizedFolder($0) != normalizedFolder(folder) ? $0 : nil }
            var created = PaneTab(
                agent: agent,
                title: (tab["name"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                workingDirectory: own,
                sessionID: (tab["sessionId"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                extraArguments: tab["extraArgs"] as? [String] ?? [],
                createdAt: (tab["lastUsedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
            )
            if tab["useRouter9"] as? Bool == true { created.useRouter9 = true }
            if tab["id"] as? String == terminal["activeTabId"] as? String { activeTab = created.id }
            tabs.append(created)
        }
        guard !tabs.isEmpty else { return nil }
        // The terminal's id is kept, so its cell in an imported custom grid still finds it.
        let id = (terminal["id"] as? String).flatMap { $0.isEmpty ? nil : PaneID(rawValue: $0) } ?? .make()
        var pane = Pane(id: id, tabs: tabs, activeTabID: activeTab)
        pane.gridID = (terminal["gridId"] as? String).flatMap { $0.isEmpty || $0 == "default" ? nil : ProjectGridID(rawValue: $0) }
        if isRemoteShared(terminal) { pane.remoteShared = true }
        return pane
    }

    /// Upstream's v8 migration, which it applies on every load: an explicit `remoteShared` wins, else
    /// the terminal is shared unless the older opt-out `remoteExcluded` is set.
    static func isRemoteShared(_ terminal: [String: Any]) -> Bool {
        (terminal["remoteShared"] as? Bool) ?? (terminal["remoteExcluded"] as? Bool != true)
    }

    private static func importPreferences(_ file: File, into preferences: inout PreferencesDocument, context: Context,
                                          report: inout Report) {
        let raw = file.preferences
        func portable<T: Decodable>(_ key: String, as type: T.Type) -> T? {
            guard let value = raw[key], !(value is NSNull), JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return try? JSONDecoder().decode(type, from: data)
        }
        if raw["orchestration"] != nil { preferences.orchestration = portable("orchestration", as: OrchestrationPreferences.self) }
        if raw["workerRuleSets"] != nil { preferences.workerRuleSets = portable("workerRuleSets", as: [WorkerRuleSet].self) }
        if raw["orchestratorShortcuts"] != nil { preferences.orchestratorShortcuts = portable("orchestratorShortcuts", as: [OrchestratorShortcut].self) }
        if raw["customAgents"] != nil { preferences.customAgents = portable("customAgents", as: [CustomAgentDefinition].self) }
        if let theme = raw["uiTheme"] as? String, context.themes.contains(theme), theme != preferences.themeID {
            preferences.themeID = theme
            report.preferences.insert(.theme)
        }
        if let zoom = raw["uiZoom"] as? Double {
            let range = PreferencesDocument.uiScaleRange
            let scale = min(max((zoom * 10).rounded() / 10, range.lowerBound), range.upperBound)
            if scale != preferences.uiScale {
                preferences.uiScale = scale
                report.preferences.insert(.interfaceSize)
            }
        }
        if let enabled = raw["enabledAgents"] as? [String: Any] {
            // Agents the file does not mention stay enabled, as upstream defaults them.
            let known = context.agents.union((preferences.customAgents ?? []).map(\.id))
            let kinds = known.sorted().filter { (enabled[$0] as? Bool) ?? true }
            let value: [String]? = kinds.count == known.count ? nil : kinds
            if value != preferences.enabledAgents {
                preferences.enabledAgents = value
                report.preferences.insert(.enabledAgents)
            }
        }
        if let unrestricted = raw["alwaysStartUnrestricted"] as? Bool, unrestricted != preferences.alwaysStartUnrestricted {
            preferences.alwaysStartUnrestricted = unrestricted
            report.preferences.insert(.alwaysUnrestricted)
        }
        // Only paths that exist on this Mac: a file copied from Windows holds `C:\…` launchers.
        var paths = preferences.cliPaths ?? [:]
        for (agent, value) in file.cliPaths {
            guard context.agents.contains(agent), let path = value as? String, isAbsolute(path),
                  context.fileExists(path), paths[agent] != path else { continue }
            paths[agent] = path
            report.preferences.insert(.cliPaths)
        }
        if report.preferences.contains(.cliPaths) { preferences.cliPaths = paths }
        // Upstream's map as stored; keys this version does not know (legacy `git`, `todos`) are skipped.
        if let stored = raw["enabledFeatures"] as? [String: Any] {
            var features = preferences.features
            for feature in Feature.allCases {
                if let on = stored[feature.rawValue] as? Bool { features.set(feature, on: on) }
            }
            if features.enabled != preferences.features.enabled {
                preferences.features = features
                report.preferences.insert(.features)
            }
        }
        if let icon = (raw["appIconTheme"] as? String).flatMap(AppIconTheme.init(rawValue:)), icon != preferences.iconTheme {
            preferences.iconTheme = icon
            report.preferences.insert(.appIcon)
        }
        let toolbar: [(String, ToolbarItemKind)] = [
            ("topbarShowClaudeUsage", .usageClaude), ("topbarShowCodexUsage", .usageCodex),
            ("topbarShowAntigravityUsage", .usageAntigravity), ("topbarShowProfile", .profile),
            ("topbarShowMemory", .memory), ("topbarShowSync", .sync), ("topbarShowRouter9", .router9),
        ]
        for (key, item) in toolbar {
            if let shown = raw[key] as? Bool, shown != preferences.showsToolbarItem(item) {
                preferences.setToolbarItem(item, shown: shown)
                report.preferences.insert(.toolbar)
            }
        }
        if let scope = raw["mcpDefaultScope"] as? String, scope == "project" || scope == "global",
           scope != preferences.mcpDefaultScope ?? "global" {
            preferences.mcpDefaultScope = scope
            report.preferences.insert(.mcp)
        }
        if raw["mcpOnboardingSeen"] as? Bool == true, preferences.mcpOnboardingSeen != true {
            preferences.mcpOnboardingSeen = true
            report.preferences.insert(.mcp)
        }
        importPeripherals(raw, into: &preferences, report: &report)
        if let language = raw["language"] as? String, !language.isEmpty { report.language = language }
    }

    /// Spotify's client ID, Discord, 9router and remote control (upstream `normalizePreferences`).
    /// Their secrets are left to `secrets(in:companions:context:)`; `remoteEnabled` is session-scoped
    /// upstream and never imported.
    private static func importPeripherals(_ raw: [String: Any], into preferences: inout PreferencesDocument,
                                          report: inout Report) {
        if let id = (raw["spotifyClientId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
           id != preferences.spotifyClientID {
            preferences.spotifyClientID = id
            report.preferences.insert(.integrations)
        }
        if let on = raw["discordRichPresenceEnabled"] as? Bool, on != preferences.showsDiscordPresence {
            preferences.discordPresence = on
            report.preferences.insert(.integrations)
        }
        if let stored = raw["router9"] as? [String: Any] {
            var router9 = preferences.router9Settings
            if let value = stored["enabled"] as? Bool { router9.enabled = value }
            if let value = stored["autoStart"] as? Bool { router9.autoStart = value }
            if let value = stored["source"] as? String { router9.source = value == "external" ? .external : .managed }
            if let value = stored["port"] as? Int { router9.port = value }
            if let value = stored["defaultForNewAgents"] as? Bool { router9.defaultForNewAgents = value }
            if router9 != preferences.router9Settings {
                preferences.router9 = router9
                report.preferences.insert(.router9)
            }
        }
        var remote = preferences.remoteSettings
        if let value = raw["remoteMaxDevices"] as? Int { remote.maxDevices = value }
        if let value = raw["remoteSessionExpirySecs"] as? Int { remote.sessionExpirySecs = value }
        if let value = raw["remoteReadOnly"] as? Bool { remote.readOnly = value }
        if let value = raw["remoteAllowShellInput"] as? Bool { remote.allowShellInput = value }
        if let value = raw["remoteUseTailscale"] as? Bool { remote.useTailscale = value }
        if remote != preferences.remoteSettings {
            preferences.remote = remote
            report.preferences.insert(.remote)
        }
    }

    // MARK: - Mapping helpers

    /// The project folder: its default working directory, else its first terminal's or tab's.
    static func folder(of project: [String: Any], terminals: [[String: Any]]) -> String? {
        var candidates: [String?] = [project["defaultCwd"] as? String]
        for terminal in terminals where (terminal["kind"] as? String ?? "terminal") == "terminal" {
            candidates.append(terminal["cwd"] as? String)
            candidates.append(contentsOf: (terminal["tabs"] as? [[String: Any]] ?? []).map { $0["cwd"] as? String })
        }
        return candidates.compactMap { $0 }.first { isAbsolute($0) }.map(trimmedFolder)
    }

    static func isAbsolute(_ path: String) -> Bool { path.hasPrefix("/") }

    static func trimmedFolder(_ path: String) -> String {
        var trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.count > 1, trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed
    }

    static func normalizedFolder(_ path: String) -> String {
        (trimmedFolder(path) as NSString).resolvingSymlinksInPath
    }

    /// The Tauri app stores any hex color (`#6ea8ff`, from its palette or a picker); the native app
    /// has ten named accents, so the nearest hue wins. Grays and near-blacks keep their tone.
    static func projectColor(_ value: Any?) -> ProjectColor? {
        guard let raw = (value as? String)?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else {
            return nil
        }
        if let named = ProjectColor(rawValue: raw) { return named }
        var hex = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count >= 6, let value = UInt32(hex.prefix(6), radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xff) / 255, g = Double((value >> 8) & 0xff) / 255, b = Double(value & 0xff) / 255
        let maxC = max(r, g, b), minC = min(r, g, b), delta = maxC - minC
        let lightness = (maxC + minC) / 2
        let saturation = delta == 0 ? 0 : delta / (1 - abs(2 * lightness - 1))
        if saturation < 0.2 || delta < 0.08 { return lightness < 0.2 ? .black : .gray }
        var hue: Double
        switch maxC {
        case r: hue = 60 * ((g - b) / delta).truncatingRemainder(dividingBy: 6)
        case g: hue = 60 * ((b - r) / delta + 2)
        default: hue = 60 * ((r - g) / delta + 4)
        }
        if hue < 0 { hue += 360 }
        switch hue {
        case ..<15, 345...: return .red
        case ..<45: return .orange
        case ..<70: return .yellow
        case ..<165: return .green
        case ..<200: return .teal
        case ..<250: return .blue
        case ..<290: return .purple
        default: return .pink
        }
    }

    /// Upstream grids key cells by terminal id, which the import keeps as the pane id.
    private static func decodeGrid(_ raw: Any) -> CustomGrid? {
        guard JSONSerialization.isValidJSONObject(raw), let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(CustomGrid.self, from: data)
    }
}

// MARK: - Locating the Tauri app's data

/// A profile of the Tauri app on this Mac.
public struct TauriProfile: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var projectsFile: URL
    public var isActive: Bool

    public init(id: String, name: String, projectsFile: URL, isActive: Bool) {
        self.id = id
        self.name = name
        self.projectsFile = projectsFile
        self.isActive = isActive
    }
}

public enum TauriDataLocation {
    /// `app_local_data_dir()` of the Tauri app (`com.kc1t.alethe`) on macOS.
    public static func defaultRoot(fileManager: FileManager = .default) -> URL? {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appending(path: "com.kc1t.alethe", directoryHint: .isDirectory)
    }

    /// Profiles that have a `projects.json`, the active one first. Upstream: `profiles.json`
    /// (`{ version, active_profile_id, profiles: [{ id, name }] }`) and `profiles/<id>/projects.json`.
    public static func profiles(root: URL, fileManager: FileManager = .default) -> [TauriProfile] {
        var entries: [(id: String, name: String?)] = []
        var active: String?
        if let data = try? Data(contentsOf: root.appending(path: "profiles.json")),
           let index = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            active = index["active_profile_id"] as? String
            for profile in index["profiles"] as? [[String: Any]] ?? [] {
                if let id = profile["id"] as? String { entries.append((id, profile["name"] as? String)) }
            }
        }
        // Profile folders missing from the index (or no index at all) still count.
        let folders = (try? fileManager.contentsOfDirectory(atPath: root.appending(path: "profiles").path)) ?? []
        for folder in folders.sorted() where !entries.contains(where: { $0.id == folder }) {
            entries.append((folder, nil))
        }
        let found = entries.compactMap { entry -> TauriProfile? in
            guard !entry.id.contains("/"), !entry.id.hasPrefix(".") else { return nil }
            let file = root.appending(path: "profiles").appending(path: entry.id).appending(path: "projects.json")
            guard fileManager.fileExists(atPath: file.path) else { return nil }
            let name = entry.name.flatMap { $0.isEmpty ? nil : $0 } ?? entry.id
            return TauriProfile(id: entry.id, name: name, projectsFile: file, isActive: entry.id == (active ?? "default"))
        }
        return found.filter(\.isActive) + found.filter { !$0.isActive }
    }

}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
