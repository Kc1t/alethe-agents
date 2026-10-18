import AletheModel

/// A sheet the main window should present.
enum EditorRequest: Identifiable, Hashable {
    /// New project in a location, optionally with its folder filled in (an `alethe` open request).
    case newProject(ProjectLocation, folder: String? = nil)
    case editProject(ProjectID)
    case newGroup(parent: GroupID?)
    case editGroup(GroupID)
    /// New terminal in a project (nil: the selected one).
    case newTerminal(ProjectID?)
    /// New sub-tab in a pane.
    case newSubTab(PaneID)
    /// Add a file or page pane to a project (nil: the selected one).
    case addContent(ProjectID?)
    case addBrowser(ProjectID?)
    /// Quick look at a terminal link (upstream link viewer).
    case previewLink(LinkPreviewTarget)
    /// Import from the Tauri app's data.
    case importTauri
    /// Custom grid designer for a project (upstream `LayoutDesignerModal`).
    case layoutDesigner(LayoutDesignerScope)
    /// Find/Jump (⌘K; upstream `FindJumpModal`).
    case findJump
    /// Past conversations of a project (nil: the selected one; P3-7).
    case conversations(ProjectID?)
    /// Tokens and cost of a tab's session (P3-8).
    case sessionCost(TabID)
    /// Continue a tab's conversation in the other agent (P3-12).
    case handoff(TabID)
    /// AI usage of the providers (P3-13).
    case aiUsage
    /// A sheet contributed by a plugin, by its `viewID`, for a project (nil: the selected one).
    case pluginSheet(viewID: String, project: ProjectID?)
    /// Merge Center of a project (nil: the selected one; P4-10…P4-13), optionally resuming a
    /// prepared merge environment by id.
    case mergeCenter(ProjectID?, resume: String? = nil)
    /// Worktrees of a project (nil: the selected one; P4-9).
    case worktrees(ProjectID?)
    /// Branch testing of a project (nil: the selected one; P4-12).
    case branchTesting(ProjectID?)
    /// Agent Library of a project (nil: the selected one; P5-16).
    case agentLibrary(ProjectID?)
    /// Help › Diagnostics…: recent errors and log export (P5-11).
    case diagnostics
    case dataManagement(DataSettingsAction)
    /// The previous run did not exit cleanly: its crash records (P5-11).
    case crashNotice
    /// History › Skills…: the skills of every agent (P5-15).
    case skills
    /// The GSD Sync child session's activity (P5-24; upstream `GsdSyncActivityView`).
    case gsdSyncActivity(GSDSyncActivityTarget)
    /// The first-run sheet (P5-26); Help › Show Onboarding… reopens it.
    case onboarding
    /// Welcome back after an update or a long absence (upstream `WelcomeModal`).
    case welcome(WelcomeBack)
    /// The MCP manager (P5-25), on a tab, a server or the add form.
    case mcpManager(McpManagerRoute)
    /// The one-time MCP intro (upstream `McpIntroModal`).
    case mcpIntro
    /// Pairing a device for remote control (P7-19; upstream `RemoteControlModal`).
    case remotePairing
    /// GitHub gist sync (P7-15; upstream `SyncModal`).
    case gistSync
    /// The web's theme picker modal (upstream `ThemePickerModal`): themes, visual style, terminal theme.
    case themePicker
    /// The web's update modal (upstream `UpdateModal`) for a newer published native release.
    case updateAvailable(SidebarNativeRelease)

    var id: String {
        switch self {
        case .newProject(_, let folder): "newProject:\(folder ?? "")"
        case .editProject(let id): "editProject:\(id)"
        case .newGroup: "newGroup"
        case .editGroup(let id): "editGroup:\(id)"
        case .newTerminal: "newTerminal"
        case .newSubTab(let id): "newSubTab:\(id)"
        case .addContent: "addContent"
        case .addBrowser: "addBrowser"
        case .previewLink(let target): "previewLink:\(target)"
        case .importTauri: "importTauri"
        case .layoutDesigner(let id): "layoutDesigner:\(id)"
        case .findJump: "findJump"
        case .conversations: "conversations"
        case .sessionCost(let tab): "sessionCost:\(tab)"
        case .handoff(let tab): "handoff:\(tab)"
        case .aiUsage: "aiUsage"
        case .pluginSheet(let viewID, _): "pluginSheet:\(viewID)"
        case .mergeCenter: "mergeCenter"
        case .worktrees: "worktrees"
        case .branchTesting: "branchTesting"
        case .agentLibrary: "agentLibrary"
        case .diagnostics: "diagnostics"
        case .dataManagement(let action): "dataManagement:\(action.rawValue)"
        case .crashNotice: "crashNotice"
        case .skills: "skills"
        case .gsdSyncActivity(let target): "gsdSyncActivity:\(target.sessionID)"
        case .onboarding: "onboarding"
        case .welcome: "welcome"
        case .mcpManager: "mcpManager"
        case .mcpIntro: "mcpIntro"
        case .remotePairing: "remotePairing"
        case .gistSync: "gistSync"
        case .themePicker: "themePicker"
        case .updateAvailable: "updateAvailable"
        }
    }
}

/// Web LayoutDesignerModal contexts; the native command continues to use project scope.
enum LayoutDesignerScope: Hashable {
    case project(ProjectID)
    case group(GroupID)
    case workspace
}
