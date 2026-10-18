import AletheFoundation
import Foundation

/// User preferences, persisted as `preferences.json` in the profile folder.
public struct PreferencesDocument: VersionedDocument, Hashable {
    public static let currentVersion = 2
    public static let migrations: [Int: @Sendable (inout JSONObject) throws -> Void] = [
        1: { migrateUsagePills(&$0) },
    ]
    public static let initial = PreferencesDocument()

    public static let defaultThemeID = "elite-indigo"
    public static let uiScaleRange: ClosedRange<Double> = 0.8...1.5
    public static let uiScaleStep = 0.1

    public var workspaceGridLayout: CustomGrid?
    public var workspaceGridLayoutHistory: [CustomGridHistoryEntry]?

    public var customAgents: [CustomAgentDefinition]?
    public var orchestratorShortcuts: [OrchestratorShortcut]?
    public var workerRuleSets: [WorkerRuleSet]?

    public var orchestration: OrchestrationPreferences?

    public var schemaVersion: Int
    /// Web-compatible optional preferences; absent values preserve existing native behavior.
    public var displayName: String?
    public var profileImageUrl: String?
    public var windowOpacity: Double?
    public var topbarStyle: String?
    public var terminalTheme: String?
    /// Web `spawnConcurrency` (1...8, default 3), `shellPath` and `terminalFontFamily`; nil means default.
    public var spawnConcurrency: Int?
    public var shellPath: String?
    public var terminalFontFamily: String?
    public var themeID: String
    /// UI zoom (⌘+ / ⌘− / ⌘0); scales fonts and metrics.
    public var uiScale: Double
    /// New agent tabs start with the agent's unrestricted flag.
    public var alwaysStartUnrestricted: Bool
    /// Agent kinds offered when creating a terminal; nil means all known agents.
    public var enabledAgents: [String]?
    /// Last choice in the new-terminal sheet.
    public var lastAgent: String?
    /// Per-agent CLI path overrides, keyed by agent kind; unset agents are resolved automatically.
    public var cliPaths: [String: String]?
    /// When idle terminals may be hibernated (P2-24); nil is the default policy.
    public var resourcePolicy: ResourcePolicy?
    /// Open with an empty workspace instead of the last one (P2-26; upstream `alwaysStartOnHome`).
    public var startClean: Bool?
    /// Ask before quitting while terminals run (P2-26); nil means yes.
    public var confirmQuit: Bool?
    /// `normal` or `clean` (upstream `visualStyle`, P2-27); nil is normal.
    public var visualStyle: String?
    /// Reduced motion even when macOS Reduce Motion is off (upstream `motionPreference`, P2-27).
    public var reducedMotion: Bool?
    /// The last New Terminal choice, for New Terminal Like Last ⌥⌘T (upstream
    /// `lastTerminalCreation`, P3-4).
    public var lastTerminalCreation: TerminalCreation?
    /// Notify when an agent finishes or needs an answer out of view (P3-11); nil means yes.
    public var notifyAgents: Bool?
    /// Notify when a usage limit resets (upstream `notifyOnLimitReset`); nil means yes.
    public var notifyLimitReset: Bool?
    /// Open on Home instead of the workspace (upstream `alwaysStartOnHome`; P3-15).
    public var startOnHome: Bool?
    /// Setup steps marked done by hand (`SetupStep` raw values; P3-16).
    public var setupDone: [String]?
    /// The setup walkthrough was hidden (upstream `setupWalkthroughHidden`).
    public var setupHidden: Bool?
    /// Optional modules turned on or off, keyed by `Feature` raw value (upstream `enabledFeatures`);
    /// read through `features`.
    public var enabledFeatures: [String: Bool]?
    /// `shared` or `dedicated` (upstream `playwrightBrowserMode`, P5-19); nil is shared.
    public var playwrightBrowserMode: String?
    /// Playwright launches its dedicated browser headless (upstream `playwrightDedicatedHeadless`).
    public var playwrightDedicatedHeadless: Bool?
    /// The shared browser runs headless; it has no pane to show it in, so nil (a window) is the default.
    public var playwrightSharedHeadless: Bool?
    /// The shared browser's executable or `.app`; nil finds Chrome, Chromium, Edge or Brave.
    public var playwrightBrowserPath: String?
    /// Dock icon artwork (upstream `appIconTheme`); read through `iconTheme`, nil is the default.
    public var appIconTheme: String?
    /// Models the GSD Sync child session tries in order (upstream `gsdSyncModelChain`), written to
    /// `.opencode/alethe-gsd-config.json`; nil or empty lets OpenCode pick.
    public var gsdSyncModelChain: [String]?
    /// Toolbar items shown or hidden against their default, keyed by `ToolbarItemKind` raw value
    /// (upstream `topbarShow*`; P5-13 replaced P3-13's `usagePills`); read through `showsToolbarItem`.
    public var toolbarItems: [String: Bool]?
    /// The Graphify CLI (Settings › Features › Graphify, P5-17): a command name looked up like the
    /// agents' CLIs, or a path; nil is `graphify`.
    public var graphifyCommand: String?
    /// The first-run sheet was finished or skipped (upstream `onboardingDone`; P5-26).
    public var onboardingDone: Bool?
    /// The first launch of this profile (upstream `firstLaunchAt`); welcome back counts days from it.
    public var firstLaunchAt: Date?
    /// The previous launch and the version it ran, for welcome back after an update or a long absence.
    public var lastLaunchAt: Date?
    public var lastSeenVersion: String?
    /// The MCP tab's scope, `global` or `project` (upstream `mcpDefaultScope`, P5-25); nil is global.
    public var mcpDefaultScope: String?
    /// The MCP intro was shown or dismissed (upstream `mcpOnboardingSeen`).
    public var mcpOnboardingSeen: Bool?
    /// Spotify app client ID for Now Playing (upstream `spotifyClientId`); the client secret lives in
    /// the Keychain (`KeychainItem.spotifyClientSecret`).
    public var spotifyClientID: String?
    /// Discord Rich Presence (upstream `discordRichPresenceEnabled`); nil is off.
    public var discordPresence: Bool?
    /// The local 9router proxy (upstream `router9`); read through `router9Settings`. Its API key lives
    /// in the Keychain (`KeychainItem.router9APIKey`).
    public var router9: Router9Preferences?
    /// Remote control (upstream `remote*`); read through `remoteSettings`. Whether it is on is not
    /// stored: remote control is off at every launch.
    public var remote: RemotePreferences?

    public init(schemaVersion: Int = currentVersion, themeID: String = defaultThemeID, uiScale: Double = 1,
                alwaysStartUnrestricted: Bool = false, enabledAgents: [String]? = nil, lastAgent: String? = nil,
                cliPaths: [String: String]? = nil) {
        self.schemaVersion = schemaVersion
        self.themeID = themeID
        self.uiScale = uiScale
        self.alwaysStartUnrestricted = alwaysStartUnrestricted
        self.enabledAgents = enabledAgents
        self.lastAgent = lastAgent
        self.cliPaths = cliPaths
    }

    public var resources: ResourcePolicy { resourcePolicy ?? ResourcePolicy() }
    public var router9Settings: Router9Preferences { router9 ?? Router9Preferences() }
    public var remoteSettings: RemotePreferences { remote ?? RemotePreferences() }
    public var showsDiscordPresence: Bool { discordPresence ?? false }

    public mutating func zoom(by steps: Int) {
        let next = (uiScale + Double(steps) * Self.uiScaleStep) * 10
        uiScale = min(max(next.rounded() / 10, Self.uiScaleRange.lowerBound), Self.uiScaleRange.upperBound)
    }
}

/// A terminal as New Terminal created it, repeated by New Terminal Like Last.
public struct TerminalCreation: Codable, Hashable, Sendable {
    public var agent: String
    /// A folder other than the project's; nil runs in the project folder.
    public var folder: String?
    public var unrestricted: Bool
    public var extraArguments: [String]
    /// Routed through 9router (P7-17); nil is off, and older files decode without it.
    public var useRouter9: Bool?

    public init(agent: String, folder: String? = nil, unrestricted: Bool = false, extraArguments: [String] = [],
                useRouter9: Bool? = nil) {
        self.agent = agent
        self.folder = folder
        self.unrestricted = unrestricted
        self.extraArguments = extraArguments
        self.useRouter9 = useRouter9
    }

    /// A new tab like the one this records.
    public func tab() -> PaneTab {
        var tab = PaneTab(agent: agent, workingDirectory: folder, unrestricted: unrestricted, extraArguments: extraArguments)
        tab.useRouter9 = useRouter9
        return tab
    }
}
