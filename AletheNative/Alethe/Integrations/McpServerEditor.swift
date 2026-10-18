import AletheDesign
import AletheIntegrations
import SwiftUI

/// Add Server (upstream `AddServerFlow`: registry search or manual entry, env hints, target agents)
/// and Edit Server (one agent's record). Stored secrets are never put in a field: an edited row left
/// empty keeps its value.
struct McpServerEditor: View {
    enum Source: Hashable { case registry, manual }
    enum RegistryFilter: Hashable { case all, local, remote }

    let model: McpManagerModel
    /// Nil adds a server.
    let editing: McpServerRecord?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.modalsM2Close) private var closeOverlay
    @State private var source = Source.registry
    @State private var draft = McpServerDraft()
    @State private var targets: Set<McpAgent> = []
    @State private var failure: String?
    @State private var saving = false
    @State private var prepared = false
    // Registry
    @State private var term = ""
    @State private var filter = RegistryFilter.all
    @State private var page: McpRegistryPage?
    @State private var entries: [McpCatalogEntry] = []
    @State private var registryState = RegistryState.loading
    @State private var loadingMore = false

    enum RegistryState { case loading, idle, offline }

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
        .task {
            guard !prepared else { return }
            prepared = true
            if let editing {
                draft = McpServerDraft(editing: editing.server)
                source = .manual
            } else { targets = Set(model.writableAgents) }
        }
        .task(id: term) { await search() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.editor")
    }

    private func close() { if let closeOverlay { closeOverlay() } else { dismiss() } }

    private var webBody: some View {
        ModalsM2WebModal(title: Text((editing == nil ? "mcp.add.title" : "mcp.edit.title") as LocalizedStringKey), close: close, width: 620) {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                if editing == nil {
                    ModalsM2Segments(selection: $source, options: [(.registry, "mcp.add.registry"), (.manual, "mcp.add.manual")])
                        .accessibilityIdentifier("mcp.add.source")
                }
                if source == .registry && editing == nil {
                    ScrollView { registry }.frame(height: metrics.size(360)).webScrollStyle()
                } else {
                    form
                    if editing == nil { targetList }
                }
            }
        } footer: {
            if let failure {
                Text(verbatim: failure).font(metrics.font(size: 11.5)).foregroundStyle(theme[.statusStopped])
                    .lineLimit(3).accessibilityIdentifier("mcp.editor.error")
            }
            Spacer()
            Button("editor.cancel", action: close).disabled(saving)
            Button { Task { await submit() } } label: {
                if editing != nil { Text("mcp.edit.save") }
                else { Text(verbatim: format("mcp.add.action", selectedTargets.count)) }
            }
            .buttonStyle(AletheButtonStyle(.primary))
            .disabled(saving || (editing == nil && source == .registry) || (editing == nil && selectedTargets.isEmpty))
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier("mcp.editor.save")
        }
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            Text((editing == nil ? "mcp.add.title" : "mcp.edit.title") as LocalizedStringKey)
                .font(metrics.font(.title3))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(metrics.space(.xl))
            if editing == nil {
                Picker("mcp.add.source", selection: $source) {
                    Text("mcp.add.registry").tag(Source.registry)
                    Text("mcp.add.manual").tag(Source.manual)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .padding(.bottom, metrics.space(.m))
                .accessibilityIdentifier("mcp.add.source")
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: metrics.space(.l)) {
                    if source == .registry && editing == nil {
                        registry
                    } else {
                        form
                        if editing == nil { targetList }
                    }
                }
                .padding(metrics.space(.xl))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            footer
        }
        .frame(width: metrics.size(640), height: metrics.size(600))
    }

    // MARK: Registry

    private var registry: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            TextField(text: $term, prompt: Text("mcp.registry.search")) { Text("mcp.registry.search") }
                .textFieldStyle(.roundedBorder)
                .modifier(ModalsM2Input())
                .accessibilityIdentifier("mcp.registry.search")
            HStack {
                Picker("mcp.registry.filter", selection: $filter) {
                    Text("mcp.registry.all").tag(RegistryFilter.all)
                    Text("mcp.registry.local").tag(RegistryFilter.local)
                    Text("mcp.registry.remote").tag(RegistryFilter.remote)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                Spacer()
                if registryState == .idle {
                    Text(verbatim: format("mcp.registry.count", filtered.count))
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textSecondary])
                }
            }
            if let stale = page?.staleSince {
                note(format("mcp.registry.stale", stale.formatted(date: .abbreviated, time: .shortened)))
            }
            switch registryState {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .offline:
                note(String(localized: "mcp.registry.offline")).accessibilityIdentifier("mcp.registry.offline")
            case .idle:
                if filtered.isEmpty {
                    note(String(localized: "mcp.registry.noResults"))
                } else {
                    ForEach(filtered) { entry in registryRow(entry) }
                    if page?.nextCursor != nil {
                        Button("mcp.registry.more") { Task { await loadMore() } }
                            .disabled(loadingMore)
                            .accessibilityIdentifier("mcp.registry.more")
                    }
                }
            }
        }
    }

    private var filtered: [McpCatalogEntry] {
        entries.filter { entry in
            switch filter {
            case .all: true
            case .local: entry.installs.contains { $0.kind == .stdio }
            case .remote: entry.installs.contains { $0.kind != .stdio }
            }
        }
    }

    private func registryRow(_ entry: McpCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: entry.title).font(metrics.font(.body).weight(.semibold))
                Text(verbatim: entry.version)
                    .font(metrics.font(.caption).monospaced())
                    .foregroundStyle(theme[.textTertiary])
            }
            if !entry.description.isEmpty {
                Text(verbatim: entry.description)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .lineLimit(3)
            }
            HStack(spacing: metrics.space(.xs)) {
                ForEach(Array(entry.installs.enumerated()), id: \.offset) { _, option in
                    Button {
                        draft = McpServerDraft(option: option, name: entry.suggestedName)
                        source = .manual
                    } label: {
                        Text(verbatim: option.label)
                    }
                    .help(Text(verbatim: option.label))
                }
            }
        }
        .padding(metrics.space(.m))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[metrics.isWebInterface ? .bgSunken : .surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.registry.entry.\(entry.id)")
    }

    /// Debounced like upstream (320 ms); a new term cancels the previous search.
    private func search() async {
        guard editing == nil else { return }
        registryState = .loading
        try? await Task.sleep(for: .milliseconds(320))
        guard !Task.isCancelled else { return }
        let query = term.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let next = try await model.registry.search(query: query.isEmpty ? nil : query)
            guard !Task.isCancelled else { return }
            page = next
            entries = next.entries
            registryState = .idle
        } catch {
            if error == .cancelled { return }
            page = nil
            entries = []
            registryState = .offline
        }
    }

    private func loadMore() async {
        guard let cursor = page?.nextCursor else { return }
        loadingMore = true
        defer { loadingMore = false }
        let query = term.trimmingCharacters(in: .whitespacesAndNewlines)
        if let next = try? await model.registry.search(query: query.isEmpty ? nil : query, cursor: cursor) {
            page = next
            let known = Set(entries.map(\.id))
            entries += next.entries.filter { !known.contains($0.id) }
        }
    }

    // MARK: Form

    private var form: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            field("mcp.field.name") {
                TextField(text: $draft.name, prompt: Text(verbatim: "playwright")) { Text("mcp.field.name") }
                    .disabled(editing != nil)
                    .modifier(ModalsM2Input(mono: false))
                        .accessibilityIdentifier("mcp.field.name")
            }
            Picker("mcp.field.transport", selection: $draft.kind) {
                ForEach(McpTransportKind.allCases, id: \.self) { kind in
                    Text(verbatim: kind.rawValue).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .accessibilityIdentifier("mcp.field.transport")
            if draft.kind == .stdio {
                field("mcp.field.command") {
                    TextField(text: $draft.command, prompt: Text(verbatim: "npx")) { Text("mcp.field.command") }
                        .modifier(ModalsM2Input(mono: true))
                        .accessibilityIdentifier("mcp.field.command")
                }
                field("mcp.field.args") {
                    TextField(text: $draft.arguments, prompt: Text("mcp.field.argsHint"), axis: .vertical) {
                        Text("mcp.field.args")
                    }
                    .lineLimit(2...6)
                    .font(metrics.font(.body).monospaced())
                    .modifier(ModalsM2Input(mono: true))
                        .accessibilityIdentifier("mcp.field.args")
                }
                field("mcp.field.cwd") {
                    TextField(text: $draft.cwd, prompt: Text("mcp.field.optional")) { Text("mcp.field.cwd") }
                        .modifier(ModalsM2Input(mono: true))
                        .accessibilityIdentifier("mcp.field.cwd")
                }
            } else {
                field("mcp.field.url") {
                    TextField(text: $draft.url, prompt: Text(verbatim: "https://mcp.example.com/mcp")) { Text("mcp.field.url") }
                        .modifier(ModalsM2Input(mono: true))
                        .accessibilityIdentifier("mcp.field.url")
                }
            }
            McpEnvRowsEditor(title: "mcp.field.env", rows: $draft.env, idPrefix: "mcp.field.env")
            if draft.kind != .stdio {
                McpEnvRowsEditor(title: "mcp.field.headers", rows: $draft.headers, idPrefix: "mcp.field.header")
            }
            if !draft.missingRequired.isEmpty {
                note(format("mcp.field.required", draft.missingRequired.joined(separator: ", ")))
            }
        }
        .textFieldStyle(.roundedBorder)
    }

    private var targetList: some View {
        let server = try? draft.server()
        let existing = Set(server.flatMap { model.group(named: $0.name)?.agents } ?? [])
        return VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Text("mcp.field.targets").font(metrics.font(.footnote).weight(.semibold))
            Text(verbatim: format("mcp.field.targetsHint", model.effectiveScope == .project
                                  ? String(localized: "mcp.scope.project") : String(localized: "mcp.scope.global")))
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textSecondary])
            ForEach(McpAgent.allCases, id: \.self) { agent in
                let reason = unavailable(agent, server: server, existing: existing)
                HStack {
                    Toggle(isOn: Binding {
                        reason == nil && targets.contains(agent)
                    } set: { on in
                        if on { targets.insert(agent) } else { targets.remove(agent) }
                    }) {
                        Text(verbatim: agent.label)
                    }
                    .toggleStyle(.checkbox)
                    .disabled(reason != nil)
                    .accessibilityIdentifier("mcp.target.\(agent.rawValue)")
                    if let reason {
                        Text(verbatim: reason)
                            .font(metrics.font(.caption))
                            .foregroundStyle(theme[.textTertiary])
                    }
                }
            }
        }
    }

    private func unavailable(_ agent: McpAgent, server: McpServer?, existing: Set<McpAgent>) -> String? {
        if !model.writableAgents.contains(agent) { return String(localized: "mcp.target.unavailable") }
        if existing.contains(agent) { return String(localized: "mcp.target.exists") }
        if let server {
            let blocked = server.unsupportedFields(for: agent)
            if !blocked.isEmpty { return format("mcp.target.blocked", blocked.map(\.field).joined(separator: ", ")) }
        }
        return nil
    }

    private var selectedTargets: [McpAgent] {
        let server = try? draft.server()
        let existing = Set(server.flatMap { model.group(named: $0.name)?.agents } ?? [])
        return McpAgent.allCases.filter { targets.contains($0) && unavailable($0, server: server, existing: existing) == nil }
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            if let failure {
                Label { Text(verbatim: failure) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.statusStopped])
                    .lineLimit(3)
                    .accessibilityIdentifier("mcp.editor.error")
            }
            Spacer()
            Button("editor.cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(saving)
            Button {
                Task { await submit() }
            } label: {
                if editing != nil {
                    Text("mcp.edit.save")
                } else {
                    Text(verbatim: format("mcp.add.action", selectedTargets.count))
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(saving || (source == .registry && editing == nil) || (editing == nil && selectedTargets.isEmpty))
            .accessibilityIdentifier("mcp.editor.save")
        }
        .padding(metrics.space(.l))
    }

    private func submit() async {
        saving = true
        defer { saving = false }
        do {
            if let editing {
                try await model.save(draft, over: editing)
            } else {
                try await model.add(draft, to: selectedTargets)
            }
            if metrics.isWebInterface { close() } else { dismiss() }
        } catch {
            failure = McpManagerModel.describe(error)
        }
    }

    // MARK: Pieces

    private func field<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            Text(title).font(metrics.font(.footnote).weight(.semibold))
            content()
        }
    }

    private func note(_ text: String) -> some View {
        Text(verbatim: text)
            .font(metrics.font(.footnote))
            .foregroundStyle(theme[.textSecondary])
    }
}

/// Env or header rows: key, value (a secure field for secrets), passthrough, remove.
private struct McpEnvRowsEditor: View {
    let title: LocalizedStringKey
    @Binding var rows: [McpEnvDraft]
    let idPrefix: String
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Text(title).font(metrics.font(.footnote).weight(.semibold))
            ForEach($rows) { $row in
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    HStack(spacing: metrics.space(.xs)) {
                        TextField(text: $row.key, prompt: Text(verbatim: "API_KEY")) { Text("mcp.field.key") }
                            .font(metrics.font(.body).monospaced())
                            .frame(width: metrics.size(160))
                            .accessibilityIdentifier("\(idPrefix).key.\(index(of: row))")
                        value($row)
                            .accessibilityIdentifier("\(idPrefix).value.\(index(of: row))")
                        Toggle("mcp.field.passthrough", isOn: $row.passthrough)
                            .toggleStyle(.checkbox)
                            .help(Text("mcp.field.passthroughHint"))
                        Button {
                            rows.removeAll { $0.id == row.id }
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .help(Text("mcp.field.removeRow"))
                        .accessibilityLabel(Text("mcp.field.removeRow"))
                    }
                    if let hint = row.hint, !hint.isEmpty {
                        Text(verbatim: hint)
                            .font(metrics.font(.caption))
                            .foregroundStyle(theme[.textTertiary])
                    }
                }
            }
            Button {
                rows.append(McpEnvDraft())
            } label: {
                Label("mcp.field.addRow", systemImage: "plus")
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("\(idPrefix).add")
        }
    }

    @ViewBuilder private func value(_ row: Binding<McpEnvDraft>) -> some View {
        let current = row.wrappedValue
        let prompt: Text = current.passthrough
            ? Text("mcp.field.hostVariable")
            : current.storedPreview.map { Text(verbatim: format("mcp.field.keep", $0)) } ?? Text("mcp.field.value")
        if current.secret && !current.passthrough {
            SecureField(text: row.value, prompt: prompt) { Text("mcp.field.value") }
        } else {
            TextField(text: row.value, prompt: prompt) { Text("mcp.field.value") }
        }
    }

    private func index(of row: McpEnvDraft) -> Int {
        rows.firstIndex { $0.id == row.id } ?? 0
    }
}
