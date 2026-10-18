import AletheDesign
import AletheFoundation
import AletheIntegrations
import AppKit
import SwiftUI

/// The MCP manager (upstream `McpManagerModal`, EXT-1): servers grouped by name with their detail —
/// per-agent records, enable with undo, sync to the agents that lack a server, masked env with an
/// explicit reveal, edit, remove (asks once), backups with restore (asks once) — and the Skills
/// browser (P5-15).
struct McpManagerSheet: View {
    let route: McpManagerRoute
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if let model = environment.mcp {
                McpManagerContent(model: model, route: route, skillStore: environment.skillStore,
                                  folder: selectedFolder, dismiss: { if let closeOverlay { closeOverlay() } else { dismiss() } })
            } else {
                ProgressView()
            }
        }
        .frame(width: metrics.isWebInterface ? nil : metrics.size(920), height: metrics.isWebInterface ? nil : metrics.size(620))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.manager")
    }

    private var selectedFolder: String? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)?.folder
        }
    }
}

/// A record to act on in a nested sheet.
struct McpRecordTarget: Identifiable {
    let record: McpServerRecord
    var id: String { "\(record.agent.rawValue):\(record.sourceKind.rawValue):\(record.sourceURL.path):\(record.server.name)" }
}

private struct McpManagerContent: View {
    let model: McpManagerModel
    let route: McpManagerRoute
    let skillStore: SkillStore
    let folder: String?
    let dismiss: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var tab = McpManagerRoute.Tab.servers
    @State private var query = ""
    @State private var selection: String?
    @State private var adding = false
    @State private var editing: McpRecordTarget?
    @State private var backupsFor: McpRecordTarget?
    @State private var removal: [McpServerRecord]?
    @State private var routed = false

    private var visible: [McpServerGroup] { model.groups.filter { $0.matches(query) } }

    private var active: McpServerGroup? {
        visible.first { $0.name == selection } ?? model.groups.first { $0.name == selection } ?? visible.first
    }

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
        .task {
            guard !routed else { return }
            routed = true
            tab = route.tab
            selection = route.server
            model.setRepository(folder)
            if route.add { adding = true }
            await model.refresh()
        }
        .onDisappear { model.close() }
        .gitWebSheet(isPresented: $adding, width: 620) {
            McpServerEditor(model: model, editing: nil)
        }
        .gitWebSheet(item: $editing, width: 620) { target in
            McpServerEditor(model: model, editing: target.record)
        }
        .gitWebSheet(item: $backupsFor, width: 520) { target in
            McpBackupsSheet(model: model, record: target.record)
        }
        .gitWebSheet(isPresented: Binding(get: { metrics.isWebInterface && removal != nil },
            set: { if !$0 { removal = nil } }), width: 420) {
            if let records = removal {
                WebConfirmationModal(title: Text("mcp.remove.title"), message: Text(verbatim: removalMessage(records)),
                    confirm: "mcp.remove.action", confirmIdentifier: "mcp.remove.confirm") { Task { await model.remove(records) } }
            }
        }
        .confirmationDialog(Text("mcp.remove.title"), isPresented: Binding {
            !metrics.isWebInterface && removal != nil
        } set: { if !$0 { removal = nil } }, presenting: removal) { records in
            Button("mcp.remove.action", role: .destructive) { Task { await model.remove(records) } }
                .accessibilityIdentifier("mcp.remove.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { records in Text(verbatim: removalMessage(records)) }
    }

    private var webBody: some View {
        ModalsM2WebModal(title: Text("modalsM2.mcp.title"), close: dismiss, width: 880) {
            VStack(spacing: 0) {
                HStack(spacing: metrics.size(6)) {
                    webTab(.servers, title: "mcp.tab.servers")
                    webTab(.skills, title: "mcp.tab.skills")
                    Spacer()
                }
                .accessibilityIdentifier("mcp.manager.tab")
                .padding(.bottom, metrics.size(8))
                .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
                .padding(.bottom, metrics.size(16))
                if tab == .skills {
                    SkillsBrowser(model: SkillsBrowserModel(store: skillStore)).frame(height: metrics.size(380))
                } else {
                    HStack(spacing: metrics.size(14)) {
                        webSidebar.frame(width: metrics.size(232))
                        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }.frame(height: metrics.size(380))
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Text(verbatim: scopeNote).accessibilityIdentifier("mcp.manager.scope")
                if let error = model.error { Text(verbatim: error).foregroundStyle(theme[.statusStopped]).accessibilityIdentifier("mcp.manager.error") }
                if let note = model.note { Text(verbatim: note).accessibilityIdentifier("mcp.manager.note") }
            }
            .font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgFaint]).lineLimit(1)
            Spacer(minLength: 0)
            if model.undoLabel != nil {
                Button("mcp.undo") { Task { await model.performUndo() } }
                    .disabled(model.busy).accessibilityIdentifier("mcp.manager.undo")
            }
            Button("agentInstall.done", action: dismiss).accessibilityIdentifier("mcp.manager.done")
        }
    }

    private func webTab(_ value: McpManagerRoute.Tab, title: LocalizedStringKey) -> some View {
        Button { tab = value } label: {
            Text(title).font(metrics.font(size: 12, weight: tab == value ? .semibold : .medium))
                .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(6))
                .background(theme[.accentFaint].opacity(tab == value ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[.accentBorder].opacity(tab == value ? 1 : 0), lineWidth: metrics.size(1)))
        }.buttonStyle(.plain).foregroundStyle(theme[tab == value ? .fg : .fgMuted])
            .accessibilityAddTraits(tab == value ? [.isSelected] : [])
    }

    private var webSidebar: some View {
        VStack(spacing: metrics.size(8)) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "magnifyingglass").font(metrics.font(size: 13)).foregroundStyle(theme[.fgFaint])
                TextField(text: $query, prompt: Text("mcp.search")) { Text("mcp.search") }
                    .accessibilityIdentifier("mcp.manager.search")
            }.modifier(ModalsM2Input())
            Button { adding = true } label: {
                Label("mcp.addServer", systemImage: "plus").font(metrics.font(size: 12))
                    .frame(maxWidth: .infinity).padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(6))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.borderStrong], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(3)])))
            }.buttonStyle(.plain).foregroundStyle(theme[.fgMuted])
                .disabled(model.writableAgents.isEmpty || model.busy).accessibilityIdentifier("mcp.manager.add")
            if model.snapshots == nil { ProgressView() }
            ScrollView {
                VStack(spacing: metrics.size(2)) {
                    ForEach(visible, id: \.name) { group in
                        Button { selection = group.name } label: {
                            HStack(spacing: metrics.size(8)) {
                                Text(verbatim: group.name).lineLimit(1)
                                Spacer(minLength: 0)
                                Text(verbatim: "\(group.agents.count)").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                            }
                        }.buttonStyle(ModalsM2RowStyle(selected: active?.name == group.name))
                            .accessibilityIdentifier("mcp.manager.row.\(group.name)")
                    }
                }
            }.accessibilityIdentifier("mcp.manager.list")
        }
        .padding(.trailing, metrics.size(14))
        .overlay(alignment: .trailing) { Rectangle().fill(theme[.borderSubtle]).frame(width: metrics.size(1)) }
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("mcp.view", selection: $tab) {
                    Text("mcp.tab.servers").tag(McpManagerRoute.Tab.servers)
                    Text("mcp.tab.skills").tag(McpManagerRoute.Tab.skills)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("mcp.manager.tab")
                Spacer()
                if tab == .servers {
                    Text(verbatim: scopeNote)
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textSecondary])
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("mcp.manager.scope")
                }
            }
            .padding(metrics.space(.l))
            Divider()
            if tab == .skills {
                SkillsBrowser(model: SkillsBrowserModel(store: skillStore))
            } else {
                HStack(spacing: 0) {
                    sidebar.frame(width: metrics.size(240))
                    Divider()
                    detail.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            Divider()
            footer
        }
    }

    private var scopeNote: String {
        if model.effectiveScope == .project, let repository = model.repository {
            return format("mcp.scope.projectNote", repository.path(percentEncoded: false))
        }
        return String(localized: "mcp.scope.globalNote")
    }

    // MARK: List

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            TextField(text: $query, prompt: Text("mcp.search")) { Text("mcp.search") }
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("mcp.manager.search")
            Button {
                adding = true
            } label: {
                Label("mcp.addServer", systemImage: "plus").frame(maxWidth: .infinity)
            }
            .disabled(model.writableAgents.isEmpty || model.busy)
            .accessibilityIdentifier("mcp.manager.add")
            if model.snapshots == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if visible.isEmpty {
                Text((model.groups.isEmpty ? "mcp.empty.title" : "mcp.noMatch") as LocalizedStringKey)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(visible, id: \.name, selection: $selection) { group in
                    HStack(spacing: metrics.space(.xs)) {
                        Text(verbatim: group.name).lineLimit(1).truncationMode(.middle)
                        if group.hasDisabled {
                            Image(systemName: "pause.circle").foregroundStyle(theme[.textTertiary])
                                .accessibilityLabel(Text("mcp.badge.disabled"))
                        }
                        Spacer(minLength: 0)
                        Text(verbatim: "\(group.agents.count)")
                            .font(metrics.font(.caption).monospacedDigit())
                            .foregroundStyle(theme[.textTertiary])
                    }
                    .font(metrics.font(.body))
                    .tag(group.name)
                    .accessibilityIdentifier("mcp.manager.row.\(group.name)")
                }
                .listStyle(.sidebar)
                .accessibilityIdentifier("mcp.manager.list")
            }
        }
        .padding(metrics.space(.m))
    }

    // MARK: Detail

    @ViewBuilder private var detail: some View {
        if let group = active {
            McpServerDetail(model: model, group: group,
                            onEdit: { editing = McpRecordTarget(record: $0) },
                            onBackups: { backupsFor = McpRecordTarget(record: $0) },
                            onRemove: { removal = $0 })
                .id(group.name)
        } else if model.snapshots != nil {
            ContentUnavailableView {
                Label((model.groups.isEmpty ? "mcp.empty.title" : "mcp.noMatch") as LocalizedStringKey, systemImage: "powerplug")
            } description: {
                if model.groups.isEmpty { Text("mcp.empty.detail") }
            }
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: metrics.space(.m)) {
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                if let error = model.error {
                    Label { Text(verbatim: error).textSelection(.enabled) } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(theme[.statusStopped])
                    .accessibilityIdentifier("mcp.manager.error")
                }
                if let note = model.note {
                    Text(verbatim: note)
                        .foregroundStyle(theme[.textSecondary])
                        .accessibilityIdentifier("mcp.manager.note")
                }
            }
            .font(metrics.font(.footnote))
            .lineLimit(3)
            Spacer()
            if model.undoLabel != nil {
                Button("mcp.undo") { Task { await model.performUndo() } }
                    .keyboardShortcut("z", modifiers: .command)
                    .disabled(model.busy)
                    .help(Text(verbatim: model.undoLabel ?? ""))
                    .accessibilityIdentifier("mcp.manager.undo")
            }
            if model.busy { ProgressView().controlSize(.small) }
            Button("agentInstall.done") { dismiss() }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("mcp.manager.done")
        }
        .padding(metrics.space(.l))
    }

    private func removalMessage(_ records: [McpServerRecord]) -> String {
        guard let first = records.first else { return "" }
        var message = format("mcp.remove.message", first.server.name,
                             McpManagerModel.labels(Array(Set(records.map(\.agent))).sorted { $0.rawValue < $1.rawValue }))
        message += "\n\n" + records.map { $0.sourceURL.path(percentEncoded: false) }.joined(separator: "\n")
        if let owner = records.compactMap(\.managedByImport).first {
            message += "\n\n" + format("mcp.importedHint", owner)
        }
        return message
    }
}

/// One server across agents.
private struct McpServerDetail: View {
    let model: McpManagerModel
    let group: McpServerGroup
    let onEdit: (McpServerRecord) -> Void
    let onBackups: (McpServerRecord) -> Void
    let onRemove: ([McpServerRecord]) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var primary: McpServerRecord? { group.records.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.isWebInterface ? metrics.size(14) : metrics.space(.xl)) {
                header
                if let owner = group.records.compactMap(\.managedByImport).first {
                    Label { Text(verbatim: format("mcp.importedHint", owner)) } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.statusWaiting])
                }
                agents
                if let primary {
                    section("mcp.detail.env") {
                        McpEnvTable(model: model, record: primary, entries: primary.server.env, header: false)
                    }
                    if let headers = primary.server.transport.headers, !headers.isEmpty {
                        section("mcp.detail.headers") {
                            McpEnvTable(model: model, record: primary, entries: headers, header: true)
                        }
                    }
                }
            }
            .padding(metrics.isWebInterface ? 0 : metrics.space(.xl))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.detail")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: group.name)
                    .font(metrics.isWebInterface ? metrics.font(size: 15, weight: .medium) : metrics.font(.title3))
                    .textSelection(.enabled)
                    .accessibilityIdentifier("mcp.detail.name")
                Spacer()
                Button(role: .destructive) {
                    onRemove(group.records)
                } label: {
                    Text(verbatim: group.records.count > 1
                         ? format("mcp.remove.all", group.records.count)
                         : String(localized: "mcp.remove.action"))
                }
                .disabled(model.busy)
                .accessibilityIdentifier("mcp.detail.remove")
            }
            Text(verbatim: primary?.server.transport.summary ?? "")
                .font(metrics.isWebInterface ? metrics.monoFont(size: 11) : metrics.font(.footnote).monospaced())
                .foregroundStyle(theme[.textSecondary])
                .textSelection(.enabled)
                .lineLimit(2)
        }
    }

    private var agents: some View {
        section("mcp.detail.agents") {
            VStack(alignment: .leading, spacing: metrics.space(.s)) {
                if group.missingAgents.count > 1 {
                    Button {
                        Task { await model.sync(group, to: group.missingAgents) }
                    } label: {
                        Label(format("mcp.sync.all", group.missingAgents.count), systemImage: "square.on.square")
                    }
                    .disabled(model.busy)
                    .accessibilityIdentifier("mcp.detail.syncAll")
                }
                ForEach(McpAgent.allCases, id: \.self) { agent in
                    let records = group.records.filter { $0.agent == agent }
                    if records.isEmpty {
                        absentCard(agent)
                    } else {
                        ForEach(records, id: \.sourceURL) { record in card(record) }
                    }
                }
            }
        }
    }

    private func absentCard(_ agent: McpAgent) -> some View {
        HStack(spacing: metrics.space(.s)) {
            Circle().strokeBorder(theme[agent.colorToken], lineWidth: 1)
                .frame(width: metrics.size(8), height: metrics.size(8))
            Text(verbatim: agent.label).font(metrics.isWebInterface ? metrics.font(size: 12.5) : metrics.font(.body))
            Text(absentReason(agent))
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textTertiary])
            Spacer(minLength: 0)
            if group.missingAgents.contains(agent) {
                Button {
                    Task { await model.sync(group, to: [agent]) }
                } label: {
                    Label("mcp.sync.here", systemImage: "square.on.square")
                }
                .disabled(model.busy)
                .accessibilityIdentifier("mcp.detail.copy.\(agent.rawValue)")
            }
        }
        .padding(.horizontal, metrics.isWebInterface ? metrics.size(11) : metrics.space(.s))
        .padding(.vertical, metrics.isWebInterface ? metrics.size(9) : metrics.space(.s))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.detail.agent.\(agent.rawValue)")
    }

    private func absentReason(_ agent: McpAgent) -> LocalizedStringKey {
        model.snapshot(agent)?.issue.map(\.title) ?? "mcp.notConfigured"
    }

    private func card(_ record: McpServerRecord) -> some View {
        let agent = record.agent
        return HStack(spacing: metrics.space(.s)) {
            Circle().fill(theme[agent.colorToken]).frame(width: metrics.size(8), height: metrics.size(8))
            Text(verbatim: agent.label).font(metrics.isWebInterface ? metrics.font(size: 12.5, weight: .medium) : metrics.font(.body).weight(.medium))
            if record.sourceKind != .user { McpBadge(title: record.sourceKind.title) }
            if !record.server.enabled {
                McpBadge(title: "mcp.badge.disabled")
                    .accessibilityIdentifier("mcp.detail.disabled.\(agent.rawValue)")
            }
            if let status = model.status(of: record.server.name, on: agent) {
                McpBadge(title: status.title, token: status.token)
                    .accessibilityIdentifier("mcp.detail.status.\(agent.rawValue)")
            } else if let failure = model.healthErrors[agent] {
                McpBadge(title: failure.title, token: .statusStopped)
            }
            Text(verbatim: record.sourceURL.path(percentEncoded: false))
                .font(metrics.font(.caption).monospaced())
                .foregroundStyle(theme[.textSecondary])
                .lineLimit(1)
                .truncationMode(.middle)
                .help(Text(verbatim: record.sourceURL.path(percentEncoded: false)))
                .accessibilityIdentifier("mcp.detail.path.\(agent.rawValue)")
            Spacer(minLength: 0)
            actions(record)
        }
        .padding(.horizontal, metrics.isWebInterface ? metrics.size(11) : metrics.space(.s))
        .padding(.vertical, metrics.isWebInterface ? metrics.size(9) : metrics.space(.s))
        .background(theme[metrics.isWebInterface ? .bgSunken : .surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.detail.agent.\(agent.rawValue)")
    }

    @ViewBuilder private func actions(_ record: McpServerRecord) -> some View {
        let agent = record.agent
        if model.healthAvailable, McpHealthParser.cli(for: agent) != nil {
            Button {
                model.checkHealth(agent)
            } label: {
                Image(systemName: model.checking.contains(agent) ? "hourglass" : "waveform.path.ecg")
            }
            .buttonStyle(.borderless)
            .disabled(model.checking.contains(agent))
            .help(Text("mcp.health.check"))
            .accessibilityLabel(Text("mcp.health.check"))
            .accessibilityIdentifier("mcp.detail.health.\(agent.rawValue)")
        }
        if agent.capability.enabledFlag {
            Button((record.server.enabled ? "mcp.disable" : "mcp.enable") as LocalizedStringKey) {
                Task { await model.toggle(record) }
            }
            .disabled(model.busy)
            .accessibilityIdentifier("mcp.detail.enabled.\(agent.rawValue)")
        }
        iconButton("pencil", "mcp.edit", id: "mcp.detail.edit.\(agent.rawValue)") { onEdit(record) }
        iconButton("clock.arrow.circlepath", "mcp.backups", id: "mcp.detail.backups.\(agent.rawValue)") { onBackups(record) }
        iconButton("folder", "mcp.revealFile", id: "mcp.detail.reveal.\(agent.rawValue)") {
            NSWorkspace.shared.activateFileViewerSelecting([record.sourceURL])
        }
        iconButton("trash", "mcp.remove.action", id: "mcp.detail.remove.\(agent.rawValue)") { onRemove([record]) }
    }

    private func iconButton(_ symbol: String, _ title: LocalizedStringKey, id: String,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.borderless)
            .disabled(model.busy)
            .help(Text(title))
            .accessibilityLabel(Text(title))
            .accessibilityIdentifier(id)
    }

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            Text(title)
                .font(metrics.font(.footnote).weight(.semibold))
                .foregroundStyle(theme[.textSecondary])
                .textCase(.uppercase)
            content()
        }
    }
}

/// Env values or headers, masked; a literal is read from the file only when Reveal is pressed.
private struct McpEnvTable: View {
    let model: McpManagerModel
    let record: McpServerRecord
    let entries: McpEnvMap
    let header: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if entries.isEmpty {
            Text("mcp.detail.noEnv")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
        } else {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: metrics.space(.l), verticalSpacing: metrics.space(.xs)) {
                ForEach(entries.keys.sorted(), id: \.self) { key in
                    row(key, entries[key]?.view)
                }
            }
        }
    }

    private func row(_ key: String, _ view: McpEnvEntryView?) -> some View {
        let revealKey = model.key(record, key, header: header)
        let shown = model.revealed[revealKey]
        return GridRow {
            Text(verbatim: key)
                .font(metrics.isWebInterface ? metrics.monoFont(size: 11) : metrics.font(.footnote).monospaced())
                .foregroundStyle(theme[.textTertiary])
            HStack(spacing: metrics.space(.xs)) {
                Text(verbatim: shown ?? view?.literal?.preview ?? "")
                    .font(metrics.isWebInterface ? metrics.monoFont(size: 11) : metrics.font(.footnote).monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("mcp.env.value.\(key)")
                if let from = view?.passthroughFrom {
                    Text(verbatim: format("mcp.passthroughFrom", from))
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textSecondary])
                }
            }
            if let literal = view?.literal, !literal.isEmpty {
                if shown == nil {
                    Button {
                        Task { await model.reveal(record, key: key, header: header) }
                    } label: {
                        Label("mcp.reveal", systemImage: "eye")
                    }
                    .accessibilityIdentifier("mcp.env.reveal.\(key)")
                } else {
                    Button {
                        model.hide(revealKey)
                    } label: {
                        Label("mcp.hide", systemImage: "eye.slash")
                    }
                    .accessibilityIdentifier("mcp.env.hide.\(key)")
                }
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
        }
    }
}

/// A file's backups, newest first; restoring asks once and backs up the current contents first.
private struct McpBackupsSheet: View {
    let model: McpManagerModel
    let record: McpServerRecord
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var backups: [ConfigBackup]?
    @State private var restoring: ConfigBackup?

    private func closeWeb() {
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: closeWeb) {
            Text("mcp.backups.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                Text(verbatim: record.sourceURL.path(percentEncoded: false))
                    .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                    .lineLimit(2).textSelection(.enabled)
                if let backups {
                    if backups.isEmpty {
                        Text("mcp.backups.empty").foregroundStyle(theme[.fgMuted])
                            .frame(maxWidth: .infinity, minHeight: metrics.size(120))
                            .accessibilityIdentifier("mcp.backups.empty")
                    } else {
                        LazyVStack(spacing: metrics.size(8)) {
                            ForEach(Array(backups.enumerated()), id: \.element.id) { index, backup in
                                HStack {
                                    VStack(alignment: .leading, spacing: metrics.size(3)) {
                                        Text(verbatim: backup.createdAt.formatted(date: .abbreviated, time: .standard)).font(metrics.font(size: 12.5))
                                        Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64(backup.size), countStyle: .file))
                                            .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                                    }
                                    Spacer()
                                    Button("mcp.backups.restore") { restoring = backup }
                                        .disabled(model.busy).accessibilityIdentifier("mcp.backups.restore.\(index)")
                                }.padding(metrics.size(10))
                                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                            }
                        }.accessibilityIdentifier("mcp.backups.list")
                    }
                } else { ProgressView().frame(maxWidth: .infinity, minHeight: metrics.size(120)) }
                Text("mcp.backups.note").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
            }
        } footer: {
            Spacer()
            Button("agentInstall.done", action: closeWeb).accessibilityIdentifier("mcp.backups.done")
        }
        .task { backups = await model.backups(for: record) }
        .gitWebSheet(isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } }), width: 440) {
            if let backup = restoring {
                WebConfirmationModal(title: Text("mcp.backups.confirmTitle"),
                    message: Text(verbatim: format("mcp.backups.confirmMessage", record.sourceURL.lastPathComponent,
                        backup.createdAt.formatted(date: .abbreviated, time: .standard))), confirm: "mcp.backups.restore", confirmIdentifier: "mcp.backups.confirm") {
                    Task { await model.restore(backup, for: record); closeWeb() }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.backups")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            Text("mcp.backups.title").font(metrics.font(.title3))
            Text(verbatim: record.sourceURL.path(percentEncoded: false))
                .font(metrics.font(.caption).monospaced())
                .foregroundStyle(theme[.textSecondary])
                .lineLimit(1)
                .truncationMode(.middle)
            if let backups {
                if backups.isEmpty {
                    Text("mcp.backups.empty")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textSecondary])
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("mcp.backups.empty")
                } else {
                    List(Array(backups.enumerated()), id: \.element.id) { index, backup in
                        HStack {
                            Text(verbatim: backup.createdAt.formatted(date: .abbreviated, time: .standard))
                            Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64(backup.size), countStyle: .file))
                                .foregroundStyle(theme[.textSecondary])
                            Spacer()
                            Button("mcp.backups.restore") { restoring = backup }
                                .disabled(model.busy)
                                .accessibilityIdentifier("mcp.backups.restore.\(index)")
                        }
                        .font(metrics.font(.body))
                    }
                    .accessibilityIdentifier("mcp.backups.list")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack {
                Text("mcp.backups.note")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textTertiary])
                Spacer()
                Button("agentInstall.done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("mcp.backups.done")
            }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(520), height: metrics.size(380))
        .task { backups = await model.backups(for: record) }
        .confirmationDialog(Text("mcp.backups.confirmTitle"), isPresented: Binding {
            restoring != nil
        } set: { if !$0 { restoring = nil } }, presenting: restoring) { backup in
            Button("mcp.backups.restore", role: .destructive) {
                Task {
                    await model.restore(backup, for: record)
                    dismiss()
                }
            }
            .accessibilityIdentifier("mcp.backups.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { backup in
            Text(verbatim: format("mcp.backups.confirmMessage", record.sourceURL.lastPathComponent,
                                  backup.createdAt.formatted(date: .abbreviated, time: .standard)))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.backups")
    }
}

extension McpSourceKind {
    var title: LocalizedStringKey {
        switch self {
        case .user: "mcp.source.user"
        case .local: "mcp.source.local"
        case .project: "mcp.source.project"
        }
    }
}

extension McpHealthError {
    var title: LocalizedStringKey {
        switch self {
        case .unsupportedAgent: "mcp.health.unsupported"
        case .cliNotFound: "mcp.health.cliNotFound"
        case .cliFailed: "mcp.health.cliFailed"
        case .timedOut: "mcp.health.timedOut"
        case .cancelled: "mcp.health.unknown"
        }
    }
}

/// Upstream `McpIntroModal`: offered once to someone with an agent config (`mcpOnboardingSeen`).
struct McpIntroSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var snapshots: [McpAgentSnapshot]?

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
        .task {
            guard let store = environment.mcp?.store else { return }
            snapshots = (try? await store.scan(scope: .global, repository: nil)) ?? []
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.intro")
    }

    private var webGroups: [McpServerGroup] { McpStore.groups(snapshots ?? []) }
    private var webGaps: [McpServerGroup] { webGroups.filter { !$0.missingAgents.isEmpty } }

    private var webBody: some View {
        ModalsM2WebModal(title: Text("mcp.intro.title"), close: { markSeen(); closeWeb() }, width: 640) {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                VStack(alignment: .leading, spacing: metrics.size(1)) {
                    Text("modalsM2.mcp.onboardingTitle").font(metrics.font(size: 19, weight: .medium)).tracking(metrics.size(-0.38))
                    Text("modalsM2.mcp.onboardingSubtitle").font(metrics.font(size: 13)).foregroundStyle(theme[.fgMuted])
                }
                HStack(spacing: metrics.size(7)) {
                    webStat(webGroups.count, title: "modalsM2.mcp.servers", token: .accent)
                    webStat((snapshots ?? []).filter { !$0.servers.isEmpty && $0.issue == nil }.count,
                            title: "modalsM2.mcp.agents", token: .statusWorking)
                    webStat(webGaps.count, title: "modalsM2.mcp.gaps", token: webGaps.isEmpty ? .fgFaint : .statusWaiting)
                }
                VStack(spacing: 0) {
                    if let snapshots {
                        ForEach(snapshots, id: \.agent) { snapshot in
                            HStack(spacing: metrics.size(12)) {
                                Text(verbatim: snapshot.agent.label).font(metrics.font(size: 13, weight: .medium))
                                Spacer(minLength: 0)
                                if !snapshot.servers.isEmpty {
                                    Text(verbatim: format("mcp.stats.servers", snapshot.servers.count))
                                        .font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgFaint])
                                }
                                let found = snapshot.sources.contains(where: \.exists)
                                HStack(spacing: metrics.size(6)) {
                                    Circle().fill(theme[snapshot.issue != nil ? .statusWaiting : found ? .statusWorking : .fgFaint])
                                        .frame(width: metrics.size(5), height: metrics.size(5))
                                    Text(snapshot.issue != nil ? "modalsM2.mcp.unreadable" : found ? "modalsM2.mcp.found" : "mcp.intro.noConfig")
                                }
                                .font(metrics.font(size: 11.5))
                                .foregroundStyle(theme[snapshot.issue != nil ? .statusWaiting : found ? .statusWorking : .fgFaint])
                                .padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(3))
                                .overlay(Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                            }
                            .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10))
                            .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("mcp.intro.agent.\(snapshot.agent.rawValue)")
                        }
                    } else {
                        Text("modalsM2.mcp.scanning").font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
                            .frame(maxWidth: .infinity).padding(.vertical, metrics.size(18))
                    }
                }
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                if snapshots != nil {
                    Text(webGroups.isEmpty ? "modalsM2.mcp.nothing" : "modalsM2.mcp.syncHint")
                        .font(metrics.font(size: 12.5)).foregroundStyle(theme[.fgMuted])
                }
            }
        } footer: {
            Spacer()
            Button("mcp.intro.later") { markSeen(); closeWeb() }
                .accessibilityIdentifier("mcp.intro.later")
            Button("mcp.intro.open") { markSeen(); environment.editorRequest = .mcpManager(McpManagerRoute()) }
                .buttonStyle(AletheButtonStyle(.primary)).keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("mcp.intro.open")
        }
    }

    private func webStat(_ value: Int, title: LocalizedStringKey, token: ThemeToken) -> some View {
        HStack(spacing: metrics.size(7)) {
            Circle().fill(theme[token]).frame(width: metrics.size(5), height: metrics.size(5))
            Text(verbatim: "\(value)").font(metrics.font(size: 12, weight: .medium)).foregroundStyle(theme[.fg])
            Text(title).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
        }
        .padding(.leading, metrics.size(9)).padding(.trailing, metrics.size(11)).padding(.vertical, metrics.size(4))
        .background(theme[.bgSunken], in: Capsule())
        .overlay(Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private func closeWeb() { if let closeOverlay { closeOverlay() } else { dismiss() } }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            Text("mcp.intro.title").font(metrics.font(.title2))
            Text("mcp.intro.detail")
                .font(metrics.font(.body))
                .foregroundStyle(theme[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if let snapshots {
                VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                    ForEach(snapshots, id: \.agent) { snapshot in
                        HStack(spacing: metrics.space(.s)) {
                            Circle().fill(theme[snapshot.agent.colorToken]).frame(width: metrics.size(8), height: metrics.size(8))
                            Text(verbatim: snapshot.agent.label).font(metrics.font(.body).weight(.medium))
                            Spacer()
                            if snapshot.sources.contains(where: \.exists) {
                                Text(verbatim: format("mcp.stats.servers", snapshot.servers.count))
                                    .foregroundStyle(theme[.textSecondary])
                            } else {
                                Text("mcp.intro.noConfig").foregroundStyle(theme[.textTertiary])
                            }
                        }
                        .font(metrics.font(.footnote))
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("mcp.intro.agent.\(snapshot.agent.rawValue)")
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            HStack {
                Spacer()
                Button("mcp.intro.later") {
                    markSeen()
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("mcp.intro.later")
                Button("mcp.intro.open") {
                    markSeen()
                    environment.editorRequest = .mcpManager(McpManagerRoute())
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("mcp.intro.open")
            }
        }
        .padding(metrics.space(.xxl))
        .frame(width: metrics.size(520))
    }

    private func markSeen() {
        environment.preferences?.update { $0.mcpOnboardingSeen = true }
    }
}
