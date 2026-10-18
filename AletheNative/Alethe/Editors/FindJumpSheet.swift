import AletheDesign
import AletheModel
import AlethePluginKit
import AppKit
import SwiftUI

/// Find/Jump (⌘K; upstream `FindJumpModal`): one field that finds terminals, projects and commands,
/// ranked by fuzzy match. ↑/↓ move, ↩ jumps, Esc closes.
struct FindJumpSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var query = ""
    @State private var cursor = 0
    @FocusState private var fieldFocused: Bool

    static let limit = 50

    enum Item: Hashable {
        case terminal(TabID)
        case project(ProjectID)
        case command(JumpCommand)
        /// A plugin `commandContributions` entry placed in Find/Jump (upstream `FindJumpModal`).
        case plugin(String)
    }

    private var document: WorkspaceDocument { workspace.document }

    private var pluginCommands: [CommandContribution] {
        (environment.plugins?.contributions.commands ?? []).filter { $0.placement.contains(.findJump) }
    }

    private var items: [Item] {
        let terminals = document.projects.flatMap { project in project.panes.flatMap { $0.tabs.map { Item.terminal($0.id) } } }
        let projects = document.projects.map { Item.project($0.id) }
        let commands = JumpCommand.allCases.filter { $0.isAvailable(document) }.map(Item.command)
        let plugin = pluginCommands.map { Item.plugin($0.id) }
        let all = terminals + projects + commands + plugin
        return Array(FuzzyMatch.rank(all, query: query, fields: fields).map(\.item).prefix(Self.limit))
    }

    var body: some View {
        let results = items
        VStack(spacing: 0) {
            HStack(spacing: metrics.space(.m)) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(theme[.textTertiary])
                TextField(text: $query) { Text("findJump.placeholder") }
                    .textFieldStyle(.plain)
                    .font(metrics.font(.title3))
                    .focused($fieldFocused)
                    .onChange(of: query) { _, _ in cursor = 0 }
                    .onKeyPress(.downArrow) { move(1, count: results.count) }
                    .onKeyPress(.upArrow) { move(-1, count: results.count) }
                    .onSubmit { if results.indices.contains(cursor) { jump(results[cursor]) } }
                    .accessibilityIdentifier("findJump.field")
            }
            .padding(metrics.space(.l))
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    // Not lazy: at most 50 rows, and every row stays reachable by accessibility.
                    VStack(spacing: metrics.space(.xxs)) {
                        if results.isEmpty {
                            Text("findJump.nothing")
                                .font(metrics.font(.body))
                                .foregroundStyle(theme[.textTertiary])
                                .padding(metrics.space(.xxl))
                        }
                        ForEach(Array(results.enumerated()), id: \.element) { index, item in
                            row(item, selected: index == cursor)
                                .id(index)
                                .onTapGesture { jump(item) }
                                .onHover { if $0 { cursor = index } }
                        }
                    }
                    .padding(metrics.space(.s))
                }
                .onChange(of: cursor) { _, index in proxy.scrollTo(index) }
            }
            .frame(height: metrics.size(340))
        }
        .frame(width: metrics.size(560))
        .background(theme[.surfaceModal])
        .onAppear { fieldFocused = true }
        .onExitCommand { dismiss() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("findJump")
    }

    private func move(_ delta: Int, count: Int) -> KeyPress.Result {
        guard count > 0 else { return .handled }
        cursor = min(max(cursor + delta, 0), count - 1)
        return .handled
    }

    // MARK: - Rows

    private func row(_ item: Item, selected: Bool) -> some View {
        let info = describe(item)
        return HStack(spacing: metrics.space(.m)) {
            Image(systemName: info.symbol)
                .foregroundStyle(info.tint.map { theme[$0] } ?? theme[.textSecondary])
                .frame(width: metrics.size(18))
            Text(verbatim: info.title)
                .font(metrics.font(.body).weight(.medium))
                .foregroundStyle(theme[.textPrimary])
                .lineLimit(1)
            if let subtitle = info.subtitle {
                Text(verbatim: "· \(subtitle)")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .lineLimit(1)
            }
            Spacer(minLength: metrics.space(.m))
            if let detail = info.detail {
                Text(verbatim: detail)
                    .font(metrics.font(.caption).monospaced())
                    .foregroundStyle(theme[.textTertiary])
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .padding(.horizontal, metrics.space(.m))
        .padding(.vertical, metrics.space(.s))
        .background(selected ? theme[.accentFaint] : Color.clear, in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: [info.title, info.subtitle].compactMap { $0 }.joined(separator: ", ")))
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("findJump.row.\(info.title)")
    }

    private struct Info {
        var symbol: String
        var tint: ThemeToken?
        var title: String
        var subtitle: String?
        var detail: String?
    }

    private func describe(_ item: Item) -> Info {
        switch item {
        case .terminal(let id):
            guard let (project, pane) = document.paneHolding(id), let tab = pane.tabs.first(where: { $0.id == id }) else {
                return Info(symbol: "terminal", title: id.rawValue)
            }
            return Info(symbol: tab.agent == "shell" ? "terminal" : "sparkles", tint: AgentTokens.accent(for: tab.agent),
                        title: tab.title ?? AgentLabels.name(for: tab.agent), subtitle: project.name,
                        detail: tab.workingDirectory ?? project.folder)
        case .project(let id):
            let project = document.project(id)
            return Info(symbol: "folder", tint: project?.color.token, title: project?.name ?? id.rawValue,
                        subtitle: String(localized: "findJump.project"), detail: project?.folder)
        case .plugin(let id):
            return describePlugin(id)
        case .command(let command):
            return Info(symbol: command.symbol, title: String(localized: command.title),
                        subtitle: String(localized: "findJump.command"), detail: command.shortcut)
        }
    }

    private func describePlugin(_ id: String) -> Info {
        guard let command = pluginCommands.first(where: { $0.id == id }) else { return Info(symbol: "command", title: id) }
        return Info(symbol: "command", title: command.title, subtitle: String(localized: "findJump.command"),
                    detail: command.keyEquivalent.map { "⌘" + $0.uppercased() })
    }

    private func fields(_ item: Item) -> [String] {
        let info = describe(item)
        return [info.title, info.subtitle, info.detail].compactMap { $0 }
    }

    // MARK: - Jumping

    private func jump(_ item: Item) {
        dismiss()
        switch item {
        case .terminal(let id):
            workspace.update { doc in
                guard let project = doc.paneHolding(id)?.project else { return }
                doc.openInTab(project.id)
                doc.activateTab(id)
            }
        case .project(let id):
            workspace.update { $0.openInTab(id) }
        case .plugin(let id):
            guard let command = pluginCommands.first(where: { $0.id == id }) else { return }
            DispatchQueue.main.async { command.perform() }
        case .command(let command):
            // After the sheet is gone, so a command that opens another sheet can.
            DispatchQueue.main.async { command.run(environment: environment, undoManager: undoManager) }
        }
    }
}

/// Commands Find/Jump can run (upstream plugin `commandContributions`; native built-ins).
enum JumpCommand: String, CaseIterable, Hashable {
    case newTerminal, newProject, newGroup, addContent, reopenTab, flatWorkspace, focusPane
    case layoutAuto, layoutSpotlight, layoutSidebar, layoutGrid, designGrid, importTauri, settings, conversations

    var title: String.LocalizationValue {
        switch self {
        case .newTerminal: "menu.file.newTerminal"
        case .newProject: "menu.file.newProject"
        case .newGroup: "menu.file.newGroup"
        case .addContent: "menu.file.addContent"
        case .reopenTab: "menu.history.reopenTab"
        case .flatWorkspace: "menu.view.flat"
        case .focusPane: "focusMode.enter"
        case .layoutAuto: "findJump.layout.auto"
        case .layoutSpotlight: "findJump.layout.spotlight"
        case .layoutSidebar: "findJump.layout.sidebar"
        case .layoutGrid: "findJump.layout.grid"
        case .designGrid: "workspace.layout.design"
        case .importTauri: "menu.file.importTauri"
        case .settings: "findJump.settings"
        case .conversations: "menu.history.conversations"
        }
    }

    var symbol: String {
        switch self {
        case .newTerminal: "plus.rectangle"
        case .newProject: "folder.badge.plus"
        case .newGroup: "folder"
        case .addContent: "doc.badge.plus"
        case .reopenTab: "arrow.uturn.backward"
        case .flatWorkspace: "rectangle.grid.1x2"
        case .focusPane: "scope"
        case .layoutAuto: PaneLayoutMode.auto.symbol
        case .layoutSpotlight: PaneLayoutMode.spotlight.symbol
        case .layoutSidebar: PaneLayoutMode.sidebar.symbol
        case .layoutGrid, .designGrid: PaneLayoutMode.grid.symbol
        case .importTauri: "square.and.arrow.down"
        case .settings: "gearshape"
        case .conversations: "clock.arrow.circlepath"
        }
    }

    var shortcut: String? {
        switch self {
        case .newTerminal: "⌘T"
        case .newProject: "⌘N"
        case .newGroup: "⇧⌘N"
        case .addContent: "⇧⌘A"
        case .reopenTab: "⇧⌘T"
        case .focusPane: "⇧⌘F"
        case .settings: "⌘,"
        case .conversations: "⌘Y"
        default: nil
        }
    }

    @MainActor func isAvailable(_ document: WorkspaceDocument) -> Bool {
        switch self {
        case .newTerminal, .addContent: !document.projects.isEmpty
        case .reopenTab: !document.workspace.closedTabs.isEmpty
        case .focusPane: document.workspace.focusedPaneID != nil
        case .layoutAuto, .layoutSpotlight, .layoutSidebar, .layoutGrid, .designGrid:
            document.workspace.selectedProjectID.flatMap(document.project) != nil
        default: true
        }
    }

    @MainActor func run(environment: AppEnvironment, undoManager: UndoManager?) {
        let workspace = environment.workspace
        let selected = workspace?.document.workspace.selectedProjectID
        switch self {
        case .newTerminal: environment.editorRequest = .newTerminal(nil)
        case .newProject: environment.editorRequest = .newProject(.ungrouped)
        case .newGroup: environment.editorRequest = .newGroup(parent: nil)
        case .addContent: environment.editorRequest = .addContent(nil)
        case .reopenTab: workspace?.update { $0.reopenClosedWorkspaceTab() }
        case .flatWorkspace: workspace?.update { $0.workspace.flat.toggle() }
        case .focusPane: environment.focusModePaneID = workspace?.document.workspace.focusedPaneID
        case .layoutAuto, .layoutSpotlight, .layoutSidebar, .layoutGrid:
            let mode: PaneLayoutMode = switch self {
            case .layoutSpotlight: .spotlight
            case .layoutSidebar: .sidebar
            case .layoutGrid: .grid
            default: .auto
            }
            if let selected { workspace?.update { $0.setLayoutMode(mode, for: selected) } }
        case .designGrid: if let selected { environment.editorRequest = .layoutDesigner(.project(selected)) }
        case .importTauri: environment.editorRequest = .importTauri
        case .settings: NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        case .conversations: environment.editorRequest = .conversations(nil)
        }
    }
}
