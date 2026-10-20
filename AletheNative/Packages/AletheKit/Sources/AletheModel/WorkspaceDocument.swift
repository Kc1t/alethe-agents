import AletheFoundation
import Foundation

/// Accent color of a project or group; the UI maps each case to a theme token (`project*`).
public enum ProjectColor: String, Codable, CaseIterable, Sendable {
    case orange, pink, purple, blue, teal, green, yellow, red, gray, black
}

public struct ProjectGroup: Codable, Hashable, Sendable, Identifiable {
    public var id: GroupID
    public var name: String
    /// Optional web-compatible URL or inline data URL.
    public var iconUrl: String?
    public var color: ProjectColor?
    /// Nesting: nil for a top-level group.
    public var parentID: GroupID?
    /// Projects directly in this group, in sidebar order.
    public var projectIDs: [ProjectID]
    /// Optional mixed sidebar order; absent for the default groups-then-projects order.
    public var childOrder: [String]?
    public var isCollapsed: Bool
    /// Suspended: every project under it is disabled (upstream `group.suspended`, P2-23).
    public var suspended: Bool?
    public var layoutMode: PaneLayoutMode?
    public var gridLayout: CustomGrid?
    public var gridLayoutHistory: [CustomGridHistoryEntry]?

    public init(id: GroupID = .make(), name: String, color: ProjectColor? = nil, parentID: GroupID? = nil,
                projectIDs: [ProjectID] = [], isCollapsed: Bool = false) {
        self.id = id
        self.name = name
        self.color = color
        self.parentID = parentID
        self.projectIDs = projectIDs
        self.isCollapsed = isCollapsed
    }
}

/// One sub-tab of a pane: an agent or shell session.
public struct PaneTab: Codable, Hashable, Sendable, Identifiable {
    public var id: TabID
    /// Agent kind raw value (`claude`, `codex`, `opencode`, `cursor`, `shell`, …).
    public var agent: String
    public var title: String?
    /// Overrides the project folder.
    public var workingDirectory: String?
    /// Agent session to resume on relaunch, once known.
    public var sessionID: String?
    public var unrestricted: Bool
    public var extraArguments: [String]
    /// Prompt sent to a new session when it starts.
    public var initialPrompt: String?
    public var createdAt: Date
    /// Agent id of the tab's own worktree (upstream `worktreeAgentId`, P4-9); nil when the tab runs
    /// in the project folder. Absent in older files.
    public var worktreeAgentID: String?
    /// Branch of that worktree (`alethe/agent-<id>`), shown in the sidebar.
    public var worktreeBranch: String?
    /// Launch through the local 9router proxy (upstream `useRouter9`); nil is off.
    public var useRouter9: Bool?

    public init(id: TabID = .make(), agent: String, title: String? = nil, workingDirectory: String? = nil,
                sessionID: String? = nil, unrestricted: Bool = false, extraArguments: [String] = [],
                initialPrompt: String? = nil, createdAt: Date = Date(),
                worktreeAgentID: String? = nil, worktreeBranch: String? = nil) {
        self.id = id
        self.agent = agent
        self.title = title
        self.workingDirectory = workingDirectory
        self.sessionID = sessionID
        self.unrestricted = unrestricted
        self.extraArguments = extraArguments
        self.initialPrompt = initialPrompt
        self.createdAt = createdAt
        self.worktreeAgentID = worktreeAgentID
        self.worktreeBranch = worktreeBranch
    }
}

/// A workspace pane (the Tauri app's "terminal"): a terminal with one or more tabs, one visible, or
/// one file or page (`content`), with no tabs.
public struct Pane: Codable, Hashable, Sendable, Identifiable {
    public var id: PaneID
    public var content: PaneContent
    public var tabs: [PaneTab]
    public var activeTabID: TabID?
    /// The sub-tabs lane shown with a single tab (upstream `laneVisible`); nil means hidden. With
    /// several tabs the lane is always shown.
    public var laneVisible: Bool?
    /// The named grid of the project holding the pane; nil is the main grid (P2-20).
    public var gridID: ProjectGridID?
    /// Disabled: nothing runs until enabled again (upstream `terminal.disabled`, P2-23); nil is
    /// enabled.
    public var disabled: Bool?
    /// Shown to paired remote devices (upstream `remoteShared`); nil, as in older files, is not
    /// shared.
    public var remoteShared: Bool?

    public init(id: PaneID = .make(), content: PaneContent = .terminal, tabs: [PaneTab] = [],
                activeTabID: TabID? = nil, laneVisible: Bool? = nil) {
        self.id = id
        self.content = content
        self.tabs = content.isTerminal ? tabs : []
        self.activeTabID = activeTabID ?? tabs.first?.id
        self.laneVisible = laneVisible
    }

    public var activeTab: PaneTab? {
        tabs.first { $0.id == activeTabID } ?? tabs.first
    }

    public var isLaneVisible: Bool { content.isTerminal && (tabs.count > 1 || laneVisible == true) }

    public var isRemoteShared: Bool { content.isTerminal && remoteShared == true }
}

/// How a project's agent worktrees are created (upstream `worktreeMode`; raw values match upstream).
public enum ProjectWorktreeMode: String, Codable, CaseIterable, Sendable {
    case gitWorktree
    case localCopy
}

public struct Project: Codable, Hashable, Sendable, Identifiable {
    public var id: ProjectID
    public var name: String
    /// Optional web-compatible URL or inline data URL.
    public var iconUrl: String?
    /// Web sidebar flags; nil preserves older documents.
    public var hidden: Bool?
    public var archived: Bool?
    /// Original web configuration keeps fields the native editor does not expose.
    public var webConfiguration: JSONObject?
    public var color: ProjectColor
    /// Absolute path of the project folder; the default working directory of its panes.
    public var folder: String
    public var panes: [Pane]
    /// Web-compatible pane stacks; absent in older native documents.
    public var paneGroups: [PaneGroup]?
    public var createdAt: Date
    /// How the panes are arranged; nil means Auto (P2-18; absent in older files).
    public var layoutMode: PaneLayoutMode?
    /// The custom grid of the Grid layout, cells keyed by pane id (P2-19).
    public var gridLayout: CustomGrid?
    /// Recently saved custom grids, newest first (upstream `gridLayoutHistory`).
    public var gridLayoutHistory: [CustomGridHistoryEntry]?
    /// Named grids besides the main one (upstream `project.grids`, P2-20).
    public var grids: [ProjectGrid]?
    /// The named grid shown; nil is the main grid.
    public var activeGridID: ProjectGridID?
    /// New agent terminals start in their own worktree (upstream `autoWorktree`, P4-9); nil is off.
    public var autoWorktree: Bool?
    /// How those worktrees are created; nil is a linked git worktree (upstream leaves it undefined).
    public var worktreeMode: ProjectWorktreeMode?
    /// The repository the project was cloned from (upstream `githubUrl`, P5-5).
    public var githubURL: String?
    /// Agents get the Graphify MCP server and the graph is generated on their first launch (upstream
    /// `graphifyEnabled`, P5-17); nil is off. Takes effect only while the graphify feature is on.
    public var graphifyEnabled: Bool?
    public var validationCommands: [String]?
    public var healthCheckCommand: String?
    public var healthCheckPath: String?
    public var conflictAgentProvider: String?
    public var conflictAgentModel: String?
    public var gsdWatcherEnabled: Bool?


    public init(id: ProjectID = .make(), name: String, color: ProjectColor = .blue, folder: String,
                panes: [Pane] = [], createdAt: Date = Date(), layoutMode: PaneLayoutMode? = nil) {
        self.id = id
        self.name = name
        self.color = color
        self.folder = folder
        self.panes = panes
        self.createdAt = createdAt
        self.layoutMode = layoutMode
    }

    /// The shown grid's layout.
    public var layout: PaneLayoutMode { activeArrangement.layoutMode ?? .auto }

    public var usesAutoWorktree: Bool { autoWorktree ?? false }
    public var effectiveWorktreeMode: ProjectWorktreeMode { worktreeMode ?? .gitWorktree }
    public var usesGraphify: Bool { graphifyEnabled ?? false }
}

/// Relative track sizes of a pane grid; empty means equal sizes.
public struct GridWeights: Codable, Hashable, Sendable {
    public var columns: [Double]
    public var rows: [Double]

    public init(columns: [Double] = [], rows: [Double] = []) {
        self.columns = columns
        self.rows = rows
    }
}

/// What is open in the window.
public struct WorkspaceState: Codable, Hashable, Sendable {
    /// Projects shown side by side as containers, in order.
    public var openProjectIDs: [ProjectID]
    /// Relative widths of the open containers; empty means equal.
    public var containerWeights: [Double]
    /// Custom track sizes per project grid.
    public var gridWeights: [String: GridWeights]
    public var focusedPaneID: PaneID?
    public var selectedProjectID: ProjectID?
    /// Open containers folded to a narrow strip (upstream `container.collapsed`).
    public var collapsedProjectIDs: [ProjectID]
    /// The one container shown, filling the workspace (upstream `fullscreenContainerId`).
    public var fullscreenProjectID: ProjectID?
    /// The one pane shown, filling its fullscreen container (upstream `isolatedPaneId`).
    public var isolatedPaneID: PaneID?
    /// Workspace tabs in bar order, pinned first (upstream `workspace.tabs`).
    public var tabs: [WorkspaceTab]
    /// Recently closed tabs, newest first, for ⇧⌘T (upstream `workspace.closedTabs`).
    public var closedTabs: [WorkspaceTab]
    public var activeTabID: WorkspaceTabID?
    /// Visited views for back/forward, oldest first (upstream `workspace.history`).
    public var history: [WorkspaceHistoryEntry]
    /// The current entry of `history`; -1 when empty.
    public var historyIndex: Int
    /// Flat workspace: the panes of every open project in one area, without containers (upstream
    /// `preferences.workspaceFlat`, P2-21).
    public var flat: Bool

    public init(openProjectIDs: [ProjectID] = [], containerWeights: [Double] = [],
                gridWeights: [String: GridWeights] = [:], focusedPaneID: PaneID? = nil,
                selectedProjectID: ProjectID? = nil, collapsedProjectIDs: [ProjectID] = [],
                fullscreenProjectID: ProjectID? = nil, isolatedPaneID: PaneID? = nil, tabs: [WorkspaceTab] = [],
                closedTabs: [WorkspaceTab] = [], activeTabID: WorkspaceTabID? = nil,
                history: [WorkspaceHistoryEntry] = [], historyIndex: Int = -1, flat: Bool = false) {
        self.openProjectIDs = openProjectIDs
        self.containerWeights = containerWeights
        self.gridWeights = gridWeights
        self.focusedPaneID = focusedPaneID
        self.selectedProjectID = selectedProjectID
        self.collapsedProjectIDs = collapsedProjectIDs
        self.fullscreenProjectID = fullscreenProjectID
        self.isolatedPaneID = isolatedPaneID
        self.tabs = tabs
        self.closedTabs = closedTabs
        self.activeTabID = activeTabID
        self.history = history
        self.historyIndex = historyIndex
        self.flat = flat
    }

    /// Key of the flat area's track sizes in `gridWeights`.
    public static let flatWeightsKey = "flat"

    /// Fields added after v2 (P2-16, P2-17) are optional in the file: older files decode unchanged.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        openProjectIDs = try container.decode([ProjectID].self, forKey: .openProjectIDs)
        containerWeights = try container.decode([Double].self, forKey: .containerWeights)
        gridWeights = try container.decode([String: GridWeights].self, forKey: .gridWeights)
        focusedPaneID = try container.decodeIfPresent(PaneID.self, forKey: .focusedPaneID)
        selectedProjectID = try container.decodeIfPresent(ProjectID.self, forKey: .selectedProjectID)
        collapsedProjectIDs = try container.decodeIfPresent([ProjectID].self, forKey: .collapsedProjectIDs) ?? []
        fullscreenProjectID = try container.decodeIfPresent(ProjectID.self, forKey: .fullscreenProjectID)
        isolatedPaneID = try container.decodeIfPresent(PaneID.self, forKey: .isolatedPaneID)
        tabs = try container.decodeIfPresent([WorkspaceTab].self, forKey: .tabs) ?? []
        closedTabs = try container.decodeIfPresent([WorkspaceTab].self, forKey: .closedTabs) ?? []
        activeTabID = try container.decodeIfPresent(WorkspaceTabID.self, forKey: .activeTabID)
        history = try container.decodeIfPresent([WorkspaceHistoryEntry].self, forKey: .history) ?? []
        historyIndex = try container.decodeIfPresent(Int.self, forKey: .historyIndex) ?? history.count - 1
        flat = try container.decodeIfPresent(Bool.self, forKey: .flat) ?? false
    }
}

/// Everything the sidebar and workspace show, persisted as `workspace.json` in the profile folder.
public struct WorkspaceDocument: VersionedDocument, Hashable {
    public static let currentVersion = 2
    public static let migrations: [Int: @Sendable (inout JSONObject) throws -> Void] = [
        // v2 (P2-8): panes say what they show; every v1 pane was a terminal.
        1: { object in
            guard var projects = object["projects"]?.arrayValue else { return }
            for index in projects.indices {
                guard var project = projects[index].objectValue,
                      var panes = project["panes"]?.arrayValue else { continue }
                for pane in panes.indices {
                    guard var value = panes[pane].objectValue, value["content"] == nil else { continue }
                    value["content"] = .object(["kind": .string("terminal")])
                    panes[pane] = .object(value)
                }
                project["panes"] = .array(panes)
                projects[index] = .object(project)
            }
            object["projects"] = .array(projects)
        },
    ]
    public static let initial = WorkspaceDocument()

    public var schemaVersion: Int
    /// All groups; sibling order is array order.
    public var groups: [ProjectGroup]
    /// Projects outside any group, in sidebar order.
    public var ungroupedProjectIDs: [ProjectID]
    public var projects: [Project]
    public var workspace: WorkspaceState

    public init(schemaVersion: Int = currentVersion, groups: [ProjectGroup] = [],
                ungroupedProjectIDs: [ProjectID] = [], projects: [Project] = [],
                workspace: WorkspaceState = WorkspaceState()) {
        self.schemaVersion = schemaVersion
        self.groups = groups
        self.ungroupedProjectIDs = ungroupedProjectIDs
        self.projects = projects
        self.workspace = workspace
    }
}
