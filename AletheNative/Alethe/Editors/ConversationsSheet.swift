import AletheAgents
import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// Past conversations (upstream `ClaudeHistoryModal` + `RecentChatsModal`): Claude Code or Codex, for
/// one project or all of them, newest first, filterable. Opening one shows the tab that already holds
/// it, or starts a new terminal that resumes it.
struct ConversationsSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let initialProject: ProjectID?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    struct Row: Identifiable, Hashable {
        let project: ProjectID
        let summary: ConversationSummary
        var id: String { summary.id }
    }

    @State private var agent: AgentKind = .claude
    @State private var allProjects = false
    @State private var rows: [Row]?
    @State private var filter = ""
    @State private var selection: Row.ID?
    @State private var unrestricted = false
    @State private var cost: SessionCost?
    @State private var costLoading = false

    private var project: Project? {
        initialProject.flatMap(workspace.document.project) ?? workspace.document.workspace.selectedProjectID.flatMap(workspace.document.project)
            ?? workspace.document.projects.first
    }

    /// The terminal tab "Open here" restarts: the active tab of the project's focused terminal pane.
    private var targetTab: (pane: Pane, tab: PaneTab)? {
        guard let project else { return nil }
        let focused = workspace.document.workspace.focusedPaneID
        let pane = project.panes.first { $0.id == focused && $0.content.isTerminal }
            ?? project.panes.first { $0.content.isTerminal && !$0.tabs.isEmpty }
        guard let pane, let tab = pane.tabs.first(where: { $0.id == pane.activeTabID }) ?? pane.tabs.first else { return nil }
        return (pane, tab)
    }

    private var visible: [Row] {
        let query = filter.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return rows ?? [] }
        return (rows ?? []).filter { row in
            [row.summary.title, row.summary.firstPrompt, row.summary.id].compactMap { $0 }
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text("menu.history.conversations")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                HStack(spacing: metrics.size(8)) {
                    ForEach([AgentKind.claude, .codex], id: \.self) { choice in
                        Button { agent = choice } label: { Text(verbatim: AgentLabels.name(for: choice.rawValue)) }
                            .buttonStyle(ModalsM2RowStyle(selected: agent == choice))
                            .accessibilityIdentifier("conversations.agent.\(choice.rawValue)")
                            .accessibilityAddTraits(agent == choice ? [.isSelected] : [])
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("conversations.agent")
                NewTerminalRowSelect(selection: $allProjects, options: [false, true],
                    title: { $0 ? String(localized: "conversations.allProjects") : project?.name ?? "" }) { _ in
                    Image(systemName: "folder").webProfileSized(16)
                }.accessibilityIdentifier("conversations.scope")
                TextField("conversations.filter", text: $filter)
                    .modifier(ProjectGroupWebInput())
                    .accessibilityIdentifier("conversations.filter")
                if rows == nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: metrics.size(120))
                } else if visible.isEmpty {
                    Text("conversations.none").foregroundStyle(theme[.fgMuted])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(120))
                } else {
                    LazyVStack(spacing: metrics.size(4)) {
                        ForEach(visible) { row in
                            Button { selection = row.id } label: {
                                rowView(row).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(ModalsM2RowStyle(selected: selection == row.id))
                            .simultaneousGesture(TapGesture(count: 2).onEnded { open(row) })
                        }
                    }.accessibilityIdentifier("conversations.list")
                }
                if selection != nil {
                    ScrollView(.horizontal) { SessionCostView(cost: cost, loading: costLoading) }
                        .fixedSize(horizontal: false, vertical: true).webScrollStyle()
                }
            }
        } footer: {
            if AgentRegistry.builtin.descriptor(for: agent)?.unrestrictedFlag != nil {
                Toggle("newTerminal.unrestricted", isOn: $unrestricted).tint(theme[.accent])
            }
            Spacer()
            Button("editor.cancel", action: dismiss)
            // RecentChatsModal.tsx: "Open here" restarts the focused pane on the chat, "New pane" resumes it
            // in a pane of its own.
            Button("recentChats.openHere") { selection.flatMap { id in visible.first { $0.id == id } }.map(openHere) }
                .disabled(selection == nil || targetTab == nil)
                .help(Text(targetTab == nil ? "recentChats.openHereDisabled" : "recentChats.openHereTooltip"))
                .accessibilityIdentifier("conversations.openHere")
            Button("recentChats.openInNewPane") { selection.flatMap { id in visible.first { $0.id == id } }.map(open) }
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction).disabled(selection == nil)
                .help(Text("recentChats.openInNewPaneTooltip"))
                .accessibilityIdentifier("conversations.open")
        }
        .task(id: "\(agent.rawValue)|\(allProjects)") { await load() }
        .task(id: selection) { await loadCost() }
        .onAppear { unrestricted = environment.preferences?.document.alwaysStartUnrestricted ?? false }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversations")
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.space(.l)) {
                Picker(selection: $agent) {
                    Text(verbatim: "Claude Code").tag(AgentKind.claude)
                    Text(verbatim: "Codex").tag(AgentKind.codex)
                } label: { EmptyView() }
                    .pickerStyle(.segmented)
                    .fixedSize()
                    .accessibilityIdentifier("conversations.agent")
                Picker(selection: $allProjects) {
                    Text(verbatim: project?.name ?? "").tag(false)
                    Text("conversations.allProjects").tag(true)
                } label: { EmptyView() }
                    .fixedSize()
                    .accessibilityIdentifier("conversations.scope")
                TextField(text: $filter) { Text("conversations.filter") }
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("conversations.filter")
            }
            .padding(metrics.space(.l))
            Divider()
            content
                .frame(height: metrics.size(360))
            if selection != nil {
                Divider()
                SessionCostView(cost: cost, loading: costLoading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(metrics.space(.l))
            }
            Divider()
            HStack {
                if AgentRegistry.builtin.descriptor(for: agent)?.unrestrictedFlag != nil {
                    Toggle("newTerminal.unrestricted", isOn: $unrestricted)
                }
                Spacer()
                Button("editor.cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("conversations.open") { selection.flatMap { id in visible.first { $0.id == id } }.map(open) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(selection == nil)
                    .accessibilityIdentifier("conversations.open")
            }
            .padding(metrics.space(.l))
        }
        .frame(width: metrics.size(680))
        .task(id: "\(agent.rawValue)|\(allProjects)") { await load() }
        .task(id: selection) { await loadCost() }
        .onAppear { unrestricted = environment.preferences?.document.alwaysStartUnrestricted ?? false }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversations")
    }

    @ViewBuilder
    private var content: some View {
        if rows == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visible.isEmpty {
            Text("conversations.none")
                .foregroundStyle(theme[.textTertiary])
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(visible, selection: $selection) { row in
                rowView(row)
                    .tag(row.id)
                    .contextMenu {
                        Button("conversations.open") { open(row) }
                        Button("conversations.copyID") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(row.summary.id, forType: .string)
                        }
                    }
            }
            .contextMenu(forSelectionType: Row.ID.self) { _ in } primaryAction: { ids in
                ids.first.flatMap { id in visible.first { $0.id == id } }.map(open)
            }
            .accessibilityIdentifier("conversations.list")
        }
    }

    private func rowView(_ row: Row) -> some View {
        let summary = row.summary
        return VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            Text(verbatim: summary.displayTitle ?? String(localized: "conversations.untitled"))
                .font(metrics.font(.body).weight(.medium))
                .lineLimit(1)
            HStack(spacing: metrics.space(.m)) {
                if allProjects, let name = workspace.document.project(row.project)?.name {
                    Text(verbatim: name)
                }
                Text(summary.modifiedAt, format: .relative(presentation: .named))
                if let count = summary.messageCount {
                    Text(String(format: String(localized: "conversations.messages"), count))
                }
                Text(verbatim: ByteCountFormatter.string(fromByteCount: summary.sizeBytes, countStyle: .file))
                if isOpen(row) {
                    Label("conversations.isOpen", systemImage: "rectangle.on.rectangle")
                        .foregroundStyle(theme[.accent])
                }
            }
            .font(metrics.font(.footnote))
            .foregroundStyle(theme[.textSecondary])
        }
        .padding(.vertical, metrics.space(.xxs))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conversations.row.\(summary.id)")
    }

    // MARK: - Loading and opening

    private func load() async {
        rows = nil
        selection = nil
        let targets = (allProjects ? workspace.document.projects : project.map { [$0] } ?? []).map { ($0.id, $0.folder) }
        let kind = agent
        let loaded = await Task.detached {
            targets.flatMap { id, folder in ConversationHistory.list(kind, cwd: folder).map { Row(project: id, summary: $0) } }
                .sorted { $0.summary.modifiedAt > $1.summary.modifiedAt }
        }.value
        rows = loaded
    }

    /// The selected conversation's tokens and cost, read off the main thread.
    private func loadCost() async {
        cost = nil
        guard let id = selection, let row = visible.first(where: { $0.id == id }),
              let folder = workspace.document.project(row.project)?.folder else { return }
        costLoading = true
        let kind = agent
        cost = await Task.detached { await SessionCosts.cost(kind, sessionID: id, cwd: folder, openCodeExecutable: nil) }.value
        costLoading = false
    }

    private func isOpen(_ row: Row) -> Bool {
        workspace.document.projects.contains { $0.panes.contains { $0.tabs.contains { $0.sessionID == row.summary.id } } }
    }

    /// Restarts the target pane's active tab on the conversation (upstream `resumeSessionInPane`).
    private func openHere(_ row: Row) {
        guard let (_, tab) = targetTab, let project else { return }
        let kind = agent
        let unrestricted = unrestricted && AgentRegistry.builtin.descriptor(for: kind)?.unrestrictedFlag != nil
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newTerminal")) { doc in
            doc.updateTab(tab.id) {
                $0.agent = kind.rawValue
                $0.sessionID = row.summary.id
                $0.unrestricted = unrestricted
            }
        }
        if let updated = workspace.document.paneHolding(tab.id)?.pane.tabs.first(where: { $0.id == tab.id }) {
            environment.terminals.restart(updated, in: workspace.document.project(project.id) ?? project, environment: environment)
        }
        dismiss()
    }

    /// The tab that holds the conversation, or a new terminal resuming it.
    private func open(_ row: Row) {
        let id = row.summary.id
        if let tab = workspace.document.projects.lazy.flatMap(\.panes).flatMap(\.tabs).first(where: { $0.sessionID == id }) {
            workspace.update { doc in
                guard let project = doc.paneHolding(tab.id)?.project else { return }
                doc.openInTab(project.id)
                doc.activateTab(tab.id)
            }
        } else {
            let unrestricted = unrestricted && AgentRegistry.builtin.descriptor(for: agent)?.unrestrictedFlag != nil
            let tab = PaneTab(agent: agent.rawValue, sessionID: id, unrestricted: unrestricted)
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newTerminal")) { doc in
                doc.openInTab(row.project)
                doc.addPane(to: row.project, tab: tab)
            }
        }
        dismiss()
    }
}
