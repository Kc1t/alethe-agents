import AletheAgents
import AletheDesign
import AletheGit
import AletheIntegrations
import AletheModel
import AppKit
import SwiftUI

/// New Terminal sheet (⌘T): agent, project, folder, unrestricted mode and an optional first prompt.
/// Upstream: `NewTerminalModal`. With a `targetPane` it is upstream's `NewSubTabModal`: the tab joins
/// that pane, in the folder of the pane's active tab. Orchestration mode (upstream `SessionMode`,
/// P6-13) opens a Claude Code or Codex planner with the orchestrator board beside it. "Route through
/// 9router" (P7-17) is offered only when routing can apply to the chosen agent.
struct NewTerminalSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let initialProject: ProjectID?
    var targetPane: PaneID?
    var closeOverlay: (() -> Void)?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    /// Upstream `SessionMode`: a plain terminal, or a planner with the orchestrator board.
    enum SessionMode: Hashable { case terminal, orchestration }

    /// Upstream `PLANNER_AGENTS`: the agents that can drive the orchestrator's tools.
    static let plannerAgents: [AgentKind] = [.claude, .codex]

    @State private var mode: SessionMode = .terminal
    @State private var agent: AgentKind = .claude
    @State private var projectID: ProjectID?
    @State private var folder = ""
    @State private var unrestricted = false
    @State private var prompt = ""
    /// Named grid the new terminal joins (P3-4); nil is the main grid.
    @State private var gridID: ProjectGridID?
    /// Model passed with the agent's model flag (P3-5); empty is the agent's default.
    @State private var model = ""
    @State private var models: [String] = []
    /// Run the agent in its own worktree (P4-9); shells never get one.
    @State private var ownWorktree = false
    @State private var worktreeMode: WorktreeMode = .gitWorktree
    @State private var provisioning = false
    @State private var worktreeError: String?
    /// Launch through 9router (P7-17); starts from `defaultForNewAgents`.
    @State private var useRouter9 = false

    private var registry: AgentRegistry { environment.agentRegistry }
    private var agents: [AgentKind] { registry.enabledKinds(environment.preferences?.document.enabledAgents) }
    private var project: Project? { projectID.flatMap { workspace.document.project($0) } }
    private var descriptor: AgentDescriptor? { registry.descriptor(for: agent) }
    private var plannerAgents: [AgentKind] { agents.filter(Self.plannerAgents.contains) }
    /// Offered for a new pane when a planner agent is enabled; choosing it turns the feature on.
    private var canOrchestrate: Bool { targetPane == nil && !plannerAgents.isEmpty }
    private var orchestrating: Bool { canOrchestrate && mode == .orchestration }
    private var modeAgents: [AgentKind] { orchestrating ? plannerAgents : agents }
    private var router9: Router9Controller { environment.router9 }
    private var routingAvailable: Bool {
        Router9.routingAvailable(router9.preferences, hasAPIKey: router9.hasAPIKey, hasInstall: router9.hasInstall,
                                 agent: agent)
    }

    @Environment(\.newTerminalModalHeight) private var modalHeight
    @Environment(\.webModalHasExplicitHeight) private var explicitModalHeight
    @State private var webContentHeight: CGFloat = 440
    @State private var advanced = false
    @State private var createMore = false
    @FocusState private var pathFocused: Bool

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
    }

    private var nativeBody: some View {
        Form {
            if canOrchestrate {
                Picker(selection: $mode) {
                    Text("newTerminal.mode.terminal").tag(SessionMode.terminal)
                    Text("newTerminal.mode.orchestration").tag(SessionMode.orchestration)
                } label: {
                    Text("newTerminal.mode")
                    Text(orchestrating ? LocalizedStringKey("newTerminal.mode.orchestration.detail") : "newTerminal.mode.terminal.detail")
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("newTerminal.mode")
                .onChange(of: mode) { _, _ in
                    if !modeAgents.contains(agent) { agent = modeAgents.first ?? agent }
                }
            }

            Picker(selection: $agent) {
                ForEach(modeAgents, id: \.self) { kind in
                    Label {
                        Text(verbatim: AgentLabels.name(for: kind.rawValue))
                    } icon: {
                        Image(systemName: "circle.fill").foregroundStyle(theme[AgentTokens.accent(for: kind.rawValue)])
                    }
                    .tag(kind)
                }
            } label: { Text(orchestrating ? LocalizedStringKey("newTerminal.planner") : "newTerminal.agent") }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("newTerminal.agent")

            if targetPane == nil {
                Picker(selection: $projectID) {
                    ForEach(workspace.document.projects) { project in
                        Text(verbatim: project.name).tag(ProjectID?.some(project.id))
                    }
                } label: { Text("newTerminal.project") }
                    .onChange(of: projectID) { _, _ in
                        folder = project?.folder ?? ""
                        gridID = project?.shownGridID
                        loadWorktreeDefaults()
                    }
                if let project, !project.namedGrids.isEmpty {
                    Picker(selection: $gridID) {
                        Text("projectGrid.main").tag(ProjectGridID?.none)
                        ForEach(project.namedGrids) { grid in
                            Text(verbatim: grid.name).tag(Optional(grid.id))
                        }
                    } label: { Text("newTerminal.grid") }
                        .accessibilityIdentifier("newTerminal.grid")
                }
            }

            LabeledContent("newTerminal.folder") {
                HStack {
                    TextField(text: $folder) { Text("newTerminal.folder") }
                        .labelsHidden()
                        .accessibilityIdentifier("newTerminal.folder")
                    Button("editor.project.chooseFolder") { chooseFolder() }
                }
            }

            if ModelDiscovery.modelFlag(for: agent) != nil {
                LabeledContent("newTerminal.model") {
                    HStack {
                        TextField(text: $model) { Text("newTerminal.model.default") }
                            .labelsHidden()
                            .accessibilityIdentifier("newTerminal.model")
                        if !models.isEmpty {
                            Menu {
                                Button("newTerminal.model.defaultItem") { model = "" }
                                Divider()
                                ForEach(models, id: \.self) { id in
                                    Button { model = id } label: { Text(verbatim: id) }
                                }
                            } label: {
                                Image(systemName: "chevron.up.chevron.down")
                            }
                            .menuStyle(.borderlessButton)
                            .fixedSize()
                            .accessibilityLabel(Text("newTerminal.model.choices"))
                            .accessibilityIdentifier("newTerminal.model.choices")
                        }
                    }
                }
                .task(id: agent) { await discoverModels() }
            }

            if let flag = descriptor?.unrestrictedFlag {
                Toggle(isOn: $unrestricted) {
                    Text("newTerminal.unrestricted")
                    Text(verbatim: flag).font(metrics.font(.footnote).monospaced())
                }
                .accessibilityIdentifier("newTerminal.unrestricted")
            }

            if routingAvailable { router9Rows }

            if descriptor?.isShell == false {
                Toggle(isOn: $ownWorktree) {
                    Text("newTerminal.worktree")
                    Text("newTerminal.worktree.detail").font(metrics.font(.footnote))
                }
                .accessibilityIdentifier("newTerminal.worktree")
                if ownWorktree {
                    Picker(selection: $worktreeMode) {
                        Text("newTerminal.worktree.mode.gitWorktree").tag(WorktreeMode.gitWorktree)
                        Text("newTerminal.worktree.mode.localCopy").tag(WorktreeMode.localCopy)
                    } label: { Text("newTerminal.worktree.mode") }
                        .accessibilityIdentifier("newTerminal.worktreeMode")
                }
                if let worktreeError {
                    VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                        Text("newTerminal.worktree.failed")
                        Text(verbatim: worktreeError).font(metrics.font(.footnote).monospaced())
                    }
                    .foregroundStyle(theme[.statusStopped])
                    .accessibilityIdentifier("newTerminal.worktreeError")
                }
            }

            if descriptor?.isShell == false {
                LabeledContent(orchestrating ? LocalizedStringKey("newTerminal.goal") : "newTerminal.prompt") {
                    TextEditor(text: $prompt)
                        .font(metrics.font(.body))
                        .frame(minHeight: metrics.size(70))
                        .scrollContentBackground(.hidden)
                        .padding(metrics.space(.xs))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border]))
                        .accessibilityIdentifier("newTerminal.prompt")
                }
            }

            if let problem {
                Text(problem)
                    .foregroundStyle(.secondary)
                    .font(metrics.font(.footnote))
                    .accessibilityIdentifier("editor.problem")
            }
        }
        .formStyle(.grouped)
        .frame(width: metrics.size(480))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("editor.cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(targetPane != nil ? LocalizedStringKey("newSubTab.add")
                       : orchestrating ? "newTerminal.createOrchestration" : "newTerminal.create") { create() }
                    .disabled(problem != nil || provisioning)
                    .accessibilityIdentifier("editor.confirm")
            }
        }
        .navigationTitle(Text(targetPane == nil ? LocalizedStringKey("newTerminal.title") : "newSubTab.title"))
        .onAppear(perform: loadInitial)
        // Keeps 9router's install and running state current while the sheet is open.
        .task { if router9.preferences.enabled { await router9.watch() } }
        .onChange(of: agent) { _, _ in
            unrestricted = startsUnrestricted
            model = ""
        }
    }


    private func close() {
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private var webBody: some View {
        VStack(spacing: 0) {
            HStack {
                Text(targetPane == nil ? LocalizedStringKey("newTerminal.web.title") : "newSubTab.title")
                    .font(metrics.font(size: 17, weight: .semibold))
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark").font(metrics.font(size: 14))
                        .frame(width: metrics.size(26), height: metrics.size(26))
                }
                .buttonStyle(AletheWorkspaceActionStyle())
                .accessibilityLabel(Text("editor.cancel"))
            }
            .padding(.horizontal, metrics.size(22))
            .padding(.top, metrics.size(20))
            .padding(.bottom, metrics.size(2))
            .webModalHeader()
            .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                VStack(alignment: .leading, spacing: metrics.size(14)) {
                    if canOrchestrate {
                        webField("newTerminal.mode") {
                            NewTerminalRowSelect(selection: $mode, options: [.terminal, .orchestration],
                                title: { String(localized: $0 == .terminal ? "newTerminal.mode.terminal" : "newTerminal.mode.orchestration") },
                                detail: { String(localized: $0 == .terminal ? "newTerminal.mode.terminal.detail" : "newTerminal.web.orchestrationDetail") },
                                side: { String(localized: $0 == .terminal ? "newTerminal.web.terminalSide" : "newTerminal.web.orchestrationSide") },
                                autofocus: true) { value in
                                Image(systemName: value == .terminal ? "terminal" : "point.3.connected.trianglepath.dotted")
                                    .font(metrics.font(size: 15))
                            }
                            .accessibilityIdentifier("newTerminal.mode")
                        }.zIndex(4)
                    }
                    webField(orchestrating ? "newTerminal.planner" : "newTerminal.agent") {
                        NewTerminalRowSelect(selection: $agent, options: modeAgents,
                            title: { AgentLabels.name(for: $0.rawValue) }, autofocus: !canOrchestrate) { kind in
                            if registry.descriptor(for: kind)?.isShell == true {
                                Image(systemName: "terminal").font(metrics.font(size: 17))
                            } else {
                                AgentLogo(agent: kind.rawValue, size: 17)
                                    .frame(width: metrics.size(17), height: metrics.size(17))
                                    .clipped()
                            }
                        }
                        .accessibilityIdentifier("newTerminal.agent")
                    }.zIndex(3)
                    VStack(alignment: .leading, spacing: metrics.size(7)) {
                        HStack {
                            Text("newTerminal.folder")
                            Spacer()
                            Button("editor.project.chooseFolder", action: chooseFolder)
                                .buttonStyle(.plain)
                                .font(metrics.font(size: 11))
                        }
                        .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                        NewTerminalRowSelect(selection: $folder, options: folderChoices,
                            title: { URL(filePath: $0).lastPathComponent }, detail: { $0 }, side: { path in
                                let parts = path.split(separator: "/")
                                return parts.count > 2 ? "…/" + parts.suffix(2).joined(separator: "/") : path
                            }) { _ in
                            Image(systemName: "folder").font(metrics.font(size: 15))
                        }
                        .accessibilityIdentifier("newTerminal.folder")
                    }.zIndex(2)
                    if orchestrating {
                        webField("newTerminal.goal") {
                            TextEditor(text: $prompt)
                                .font(metrics.font(size: 13))
                                .scrollContentBackground(.hidden)
                                .frame(height: metrics.size(64))
                                .padding(metrics.size(11))
                                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.size(12)))
                                .accessibilityIdentifier("newTerminal.prompt")
                        }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        Button { advanced.toggle() } label: {
                            HStack(spacing: metrics.size(6)) {
                                Image(systemName: advanced ? "chevron.down" : "chevron.right")
                                    .font(metrics.font(size: 9))
                                Text("newTerminal.web.advanced").font(metrics.font(size: 12))
                                Text("newTerminal.web.advancedHint").font(metrics.font(size: 11))
                                    .foregroundStyle(theme[.fgFaint])
                            }
                        }.buttonStyle(.plain)
                        if advanced {
                            webAdvanced
                                .padding(metrics.size(12))
                                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.size(14)))
                                .padding(.top, metrics.size(12))
                        }
                    }
                    .foregroundStyle(theme[.fgMuted])
                    .padding(.top, metrics.size(2))
                    if let problem {
                        Text(problem).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                            .accessibilityIdentifier("editor.problem")
                    }
                }
                .padding(.horizontal, metrics.size(20))
                .padding(.top, metrics.size(14))
                .padding(.bottom, metrics.size(18))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { webContentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: explicitModalHeight ? nil : min(webContentHeight, max(0, modalHeight - metrics.size(125))))
            .frame(maxHeight: explicitModalHeight ? .infinity : nil)
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
            HStack(spacing: metrics.size(10)) {
                if !orchestrating && targetPane == nil {
                    Button { createMore.toggle() } label: {
                        HStack(spacing: metrics.size(9)) {
                            Capsule().fill(theme[createMore ? .panelHover : .bgSunken])
                                .frame(width: metrics.size(32), height: metrics.size(18))
                                .overlay(Capsule().strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                                .overlay(Circle().fill(theme[createMore ? .accent : .fgFaint])
                                    .frame(width: metrics.size(12), height: metrics.size(12))
                                    .offset(x: metrics.size(createMore ? 7 : -7)))
                            Text("newTerminal.web.createMore")
                        }
                    }
                    .buttonStyle(.plain)
                    .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    .accessibilityValue(Text(createMore ? "newTerminal.web.on" : "newTerminal.web.off"))
                    .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: createMore)
                }
                Spacer(minLength: 0)
                Button("editor.cancel", action: close).buttonStyle(AletheButtonStyle())
                Button(action: create) {
                    HStack(spacing: metrics.size(9)) {
                        if targetPane != nil {
                            Text("newSubTab.add")
                        } else if orchestrating {
                            Text("newTerminal.createOrchestration")
                        } else {
                            Text(verbatim: String(format: String(localized: "newTerminal.web.openAgent"),
                                                  AgentLabels.name(for: agent.rawValue)))
                        }
                        Text(verbatim: "⌘↵")
                            .font(metrics.monoFont(size: 10, weight: .regular))
                            .padding(.horizontal, metrics.size(5)).padding(.vertical, metrics.size(1))
                            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                                .strokeBorder(theme[.accentOn].opacity(0.5), lineWidth: metrics.size(1)))
                    }
                }
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(problem != nil || provisioning)
                .accessibilityIdentifier("editor.confirm")
            }
            .padding(.horizontal, metrics.size(22))
            .padding(.top, metrics.size(14)).padding(.bottom, metrics.size(18))
            .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(20)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(20))
            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
        .newTerminalDropdownLayer()
        .onAppear(perform: loadInitial)
        .task { if router9.preferences.enabled { await router9.watch() } }
        .onChange(of: agent) { _, _ in unrestricted = startsUnrestricted; model = "" }
        .onChange(of: mode) { _, _ in
            if !modeAgents.contains(agent) { agent = modeAgents.first ?? agent }
        }
    }

    private func webField<Content: View>(_ key: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(7)) {
            Text(key).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
            content()
        }
    }

    private var webAdvanced: some View {
        VStack(alignment: .leading, spacing: metrics.size(10)) {
            if targetPane == nil {
                Picker("newTerminal.project", selection: $projectID) {
                    ForEach(workspace.document.projects) { project in
                        Text(verbatim: project.name).tag(Optional(project.id))
                    }
                }
                .onChange(of: projectID) { _, _ in
                    folder = project?.folder ?? ""
                    gridID = project?.shownGridID
                    loadWorktreeDefaults()
                }
                if let project, !project.namedGrids.isEmpty {
                    Picker("newTerminal.grid", selection: $gridID) {
                        Text("projectGrid.main").tag(ProjectGridID?.none)
                        ForEach(project.namedGrids) { grid in
                            Text(verbatim: grid.name).tag(Optional(grid.id))
                        }
                    }.accessibilityIdentifier("newTerminal.grid")
                }
            }
            if ModelDiscovery.modelFlag(for: agent) != nil {
                LabeledContent("newTerminal.model") {
                    HStack {
                        TextField(text: $model) { Text("newTerminal.model.default") }
                            .labelsHidden()
                            .accessibilityIdentifier("newTerminal.model")
                        if !models.isEmpty {
                            Menu {
                                Button("newTerminal.model.defaultItem") { model = "" }
                                Divider()
                                ForEach(models, id: \.self) { id in
                                    Button { model = id } label: { Text(verbatim: id) }
                                }
                            } label: {
                                Image(systemName: "chevron.up.chevron.down")
                            }
                            .menuStyle(.borderlessButton)
                            .fixedSize()
                            .accessibilityLabel(Text("newTerminal.model.choices"))
                            .accessibilityIdentifier("newTerminal.model.choices")
                        }
                    }
                }
                .task(id: agent) { await discoverModels() }
            }

            if descriptor?.unrestrictedFlag != nil {
                webPermission("newTerminal.unrestricted", detail: String(localized: "newTerminal.web.permissionDetail"),
                              symbol: "bolt", value: $unrestricted)
                .accessibilityIdentifier("newTerminal.unrestricted")
            }

            if routingAvailable { router9Rows }

            if descriptor?.isShell == false {
                Toggle(isOn: $ownWorktree) {
                    Text("newTerminal.worktree")
                    Text("newTerminal.worktree.detail").font(metrics.font(.footnote))
                }
                .accessibilityIdentifier("newTerminal.worktree")
                if ownWorktree {
                    Picker(selection: $worktreeMode) {
                        Text("newTerminal.worktree.mode.gitWorktree").tag(WorktreeMode.gitWorktree)
                        Text("newTerminal.worktree.mode.localCopy").tag(WorktreeMode.localCopy)
                    } label: { Text("newTerminal.worktree.mode") }
                        .accessibilityIdentifier("newTerminal.worktreeMode")
                }
                if let worktreeError {
                    VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                        Text("newTerminal.worktree.failed")
                        Text(verbatim: worktreeError).font(metrics.font(.footnote).monospaced())
                    }
                    .foregroundStyle(theme[.statusStopped])
                    .accessibilityIdentifier("newTerminal.worktreeError")
                }
            }

            if descriptor?.isShell == false && !orchestrating {
                LabeledContent(orchestrating ? LocalizedStringKey("newTerminal.goal") : "newTerminal.prompt") {
                    TextEditor(text: $prompt)
                        .font(metrics.font(.body))
                        .frame(minHeight: metrics.size(70))
                        .scrollContentBackground(.hidden)
                        .padding(metrics.space(.xs))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border]))
                        .accessibilityIdentifier("newTerminal.prompt")
                }
            }

            webField("newTerminal.web.folderPath") {
                TextField(text: $folder) { Text("newTerminal.folder") }
                    .textFieldStyle(.plain)
                    .font(metrics.monoFont(size: 11, weight: .regular))
                    .focused($pathFocused)
                    .padding(.horizontal, metrics.size(10))
                    .frame(height: metrics.size(32))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.size(8)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(8))
                        .strokeBorder(theme[pathFocused ? .accent : .border], lineWidth: metrics.size(1)))
                    .accessibilityIdentifier("newTerminal.folder.path")
            }
        }
        .font(metrics.font(size: 12))
    }

    private var folderChoices: [String] {
        var seen = Set<String>()
        return ([folder] + workspace.document.projects.map(\.folder)).filter {
            !$0.isEmpty && seen.insert($0).inserted
        }
    }

    private func webPermission(_ title: LocalizedStringKey, detail: String, symbol: String,
                               value: Binding<Bool>) -> some View {
        Button { value.wrappedValue.toggle() } label: {
            HStack(spacing: metrics.size(11)) {
                Image(systemName: symbol).font(metrics.font(size: 16))
                    .frame(width: metrics.size(26), height: metrics.size(26))
                    .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(8)))
                VStack(alignment: .leading, spacing: metrics.size(3)) {
                    Text(title).font(metrics.font(size: 12, weight: .semibold))
                    Text(verbatim: detail).font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                }.frame(maxWidth: .infinity, alignment: .leading)
                Text(value.wrappedValue ? "newTerminal.web.on" : "newTerminal.web.off")
                    .textCase(.uppercase)
                    .font(metrics.font(size: 9, weight: .bold))
                    .padding(.horizontal, metrics.size(7)).padding(.vertical, metrics.size(3))
                    .background(theme[.panel], in: Capsule())
            }
            .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(9))
            .frame(minHeight: metrics.size(52))
            .background(theme[value.wrappedValue ? .statusWaitingSoft : .bgElevated],
                        in: RoundedRectangle(cornerRadius: metrics.size(12)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(12))
                .strokeBorder(theme[value.wrappedValue ? .statusWaiting : .border], lineWidth: metrics.size(1)))
        }
        .buttonStyle(.plain)
        .accessibilityValue(Text(value.wrappedValue ? "newTerminal.web.on" : "newTerminal.web.off"))
    }

    @ViewBuilder private var router9Rows: some View {
        Toggle(isOn: $useRouter9) {
            Text("newTerminal.router9")
            Text("newTerminal.router9.detail").font(metrics.font(.footnote))
        }
        .accessibilityIdentifier("newTerminal.router9")
        if useRouter9, !router9.isRunning {
            Button(router9.busy ? LocalizedStringKey("newTerminal.router9.starting") : "newTerminal.router9.stopped") {
                Task { await router9.startRouter() }
            }
            .disabled(router9.busy)
            .accessibilityIdentifier("newTerminal.router9.start")
        }
        Toggle(isOn: Binding(get: { router9.preferences.defaultForNewAgents },
                             set: { value in router9.update { $0.defaultForNewAgents = value } })) {
            Text("router9.defaultForNewAgents")
        }
        .accessibilityIdentifier("newTerminal.router9.always")
    }

    private var startsUnrestricted: Bool {
        descriptor?.unrestrictedFlag != nil && (environment.preferences?.document.alwaysStartUnrestricted ?? false)
    }

    private var problem: LocalizedStringKey? {
        guard project != nil else { return "newTerminal.problem.project" }
        if let targetPane, workspace.document.pane(targetPane) == nil { return "newSubTab.problem.pane" }
        var isDirectory: ObjCBool = false
        let path = expanded(folder)
        if path.isEmpty || !FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) || !isDirectory.boolValue {
            return "editor.problem.folder"
        }
        return nil
    }

    private func loadInitial() {
        let last = registry.parse(environment.preferences?.document.lastAgent)
        agent = last.flatMap { agents.contains($0) ? $0 : nil } ?? (agents.contains(.claude) ? .claude : agents.first ?? .shell)
        projectID = initialProject.flatMap { workspace.document.project($0)?.id } ?? workspace.document.projects.first?.id
        folder = project?.folder ?? ""
        gridID = project?.shownGridID
        if let targetPane, let found = workspace.document.pane(targetPane) {
            folder = found.pane.activeTab?.workingDirectory ?? found.project.folder
        }
        unrestricted = startsUnrestricted
        useRouter9 = router9.preferences.defaultForNewAgents
        loadWorktreeDefaults()
    }

    /// The worktree toggle starts from the project's settings (upstream `autoWorktree` / `worktreeMode`).
    private func loadWorktreeDefaults() {
        ownWorktree = project?.usesAutoWorktree ?? false
        worktreeMode = project?.effectiveWorktreeMode == .localCopy ? .localCopy : .gitWorktree
    }

    /// The agent's models, looked up off the main thread; never blocks the sheet.
    private func discoverModels() async {
        models = []
        let executable = descriptor?.cliCommand.flatMap {
            environment.launchers.resolve($0, override: environment.preferences?.document.cliPaths?[agent.rawValue])
        }
        models = await ModelDiscovery.discover(agent, executable: executable)
    }

    private func expanded(_ path: String) -> String {
        (path.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = URL(filePath: expanded(folder), directoryHint: .isDirectory)
        if panel.runModal() == .OK, let url = panel.url { folder = url.path }
    }

    private func create() {
        guard let project else { return }
        worktreeError = nil
        guard descriptor?.isShell == false, ownWorktree else { return add(in: project, worktree: nil) }
        // Provision before the tab exists, so the agent starts inside the worktree.
        let repo = URL(filePath: expanded(folder)).standardizedFileURL
        let tabID = TabID.make()
        let mode = worktreeMode
        provisioning = true
        Task {
            do {
                let info = try await GitWorktrees().provision(repo: repo, agentId: tabID.rawValue, mode: mode)
                provisioning = false
                add(in: project, worktree: info, tabID: tabID)
            } catch {
                provisioning = false
                worktreeError = Self.describe(error)
            }
        }
    }

    static func describe(_ error: Error) -> String {
        if case let GitError.commandFailed(_, stderr) = error, !stderr.isEmpty { return stderr }
        return String(describing: error)
    }

    private func add(in project: Project, worktree: WorktreeInfo?, tabID: TabID = .make()) {
        let path = URL(filePath: expanded(folder)).standardizedFileURL.path
        let projectFolder = URL(filePath: project.folder).standardizedFileURL.path
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        var tab = PaneTab(
            id: tabID,
            agent: agent.rawValue,
            workingDirectory: worktree?.path ?? (path == projectFolder ? nil : path),
            unrestricted: descriptor?.unrestrictedFlag != nil && unrestricted,
            extraArguments: ModelDiscovery.arguments([], model: model, for: agent),
            initialPrompt: descriptor?.isShell == false && !text.isEmpty ? text : nil,
            worktreeAgentID: worktree?.agentId,
            worktreeBranch: worktree?.branch
        )
        // Stored only when it can apply, like upstream; nil keeps older files unchanged.
        tab.useRouter9 = routingAvailable && useRouter9 ? true : nil
        if let targetPane {
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newSubTab")) {
                $0.addTab(tab, to: targetPane)
            }
        } else {
            let grid = gridID
            let orchestration = orchestrating
            let web = metrics.isWebInterface
            // The planner's launch reads the feature (its MCP wiring): turn it on before the tab exists.
            if orchestration, environment.features.isOn(.orchestrator) == false {
                environment.preferences?.update { $0.features.set(.orchestrator, on: true) }
            }
            let actionName = orchestration ? String(localized: "undo.newOrchestration") : String(localized: "undo.newTerminal")
            workspace.update(undoManager: undoManager, actionName: actionName) {
                // New panes join the shown grid: show the chosen one first.
                if grid != $0.project(project.id)?.shownGridID { $0.activateGrid(grid, in: project.id) }
                let planner = $0.addPane(to: project.id, tab: tab)
                // Mac: the board goes right after the planner, beside it, and the planner keeps the keyboard.
                if orchestration, let planner {
                    let board = $0.addPane(to: project.id, content: .orchestrator)
                    // Web: terminal and board form one "Orchestration" stack (upstream `groupPanes`).
                    if web, let board {
                        $0.updateProject(project.id) {
                            $0.groupPanes([planner, board], kind: "orchestration", plannerId: planner)
                        }
                    }
                    $0.workspace.focusedPaneID = planner
                }
            }
            environment.preferences?.update {
                $0.lastTerminalCreation = TerminalCreation(agent: tab.agent, folder: worktree == nil ? tab.workingDirectory : nil,
                                                           unrestricted: tab.unrestricted, extraArguments: tab.extraArguments,
                                                           useRouter9: tab.useRouter9)
            }
        }
        environment.preferences?.update { $0.lastAgent = agent.rawValue }
        if metrics.isWebInterface {
            if !createMore || orchestrating || targetPane != nil { close() }
        } else {
            dismiss()
        }
    }
}
