import AletheDesign
import AletheIntegrations
import AletheModel
import AlethePluginKit
import SwiftUI

/// Where the MCP manager opens.
struct McpManagerRoute: Hashable {
    enum Tab: String, Hashable { case servers, skills }

    var tab = Tab.servers
    var server: String?
    var add = false
}

/// The right sidebar's MCP tab (upstream `McpPanel`, EXT-1): servers grouped by name across agents,
/// with scope switch, agent filter, live health and config diagnostics; or the skills of every agent.
/// Rows open the MCP manager, where every change happens.
struct McpPanel: View {
    @Environment(AppEnvironment.self) private var environment

    static let tabID = "mcp"
    static let tab = SidebarTabContribution(id: tabID, title: "MCP", symbol: "powerplug", side: .right, viewID: tabID)

    var body: some View {
        if let model = environment.mcp {
            McpPanelContent(model: model, skillStore: environment.skillStore, folder: selectedFolder)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var selectedFolder: String? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)?.folder
        }
    }
}

private struct McpPanelContent: View {
    enum Section: String, Hashable { case servers, skills }

    let model: McpManagerModel
    let skillStore: SkillStore
    let folder: String?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var section = Section.servers
    @State private var query = ""
    @State private var picked: Set<McpAgent> = []
    @State private var skills: [SkillGroup]?
    @FocusState private var searchFocused: Bool

    private var visibleServers: [McpServerGroup] {
        model.groups.filter { $0.matches(query) && $0.isOn(anyOf: picked) }
    }

    private var visibleSkills: [SkillGroup] {
        (skills ?? []).filter { group in
            group.matches(query)
                && (picked.isEmpty
                    || group.agents.contains { agent in
                        picked.contains { $0.rawValue == agent.rawValue }
                    })
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.isWebInterface ? 0 : metrics.space(.m)) {
            header
            Group {
                if metrics.isWebInterface {
                    HStack(spacing: metrics.size(7)) {
                        Image(systemName: "magnifyingglass").resizable().scaledToFit()
                            .frame(width: metrics.size(13), height: metrics.size(13)).foregroundStyle(theme[.fgFaint])
                        TextField(
                            text: $query, prompt: Text((section == .servers ? "mcp.search" : "mcp.searchSkills") as LocalizedStringKey)
                        ) {
                            Text("mcp.search")
                        }.textFieldStyle(.plain).focused($searchFocused)
                    }
                    .font(metrics.font(size: 12.5)).foregroundStyle(theme[.fg])
                    .padding(.vertical, metrics.size(6)).padding(.horizontal, metrics.size(10))
                    .modifier(AletheSidebarFieldBorder(focused: searchFocused))
                    .accessibilityIdentifier("mcp.panel.search")
                } else {
                    TextField(text: $query, prompt: Text((section == .servers ? "mcp.search" : "mcp.searchSkills") as LocalizedStringKey)) {
                        Text("mcp.search")
                    }.textFieldStyle(.roundedBorder).accessibilityIdentifier("mcp.panel.search")
                }
            }
            .padding(.horizontal, metrics.isWebInterface ? metrics.size(10) : 0)
            .padding(.top, metrics.isWebInterface ? metrics.size(8) : 0)
            filters
                .padding(.horizontal, metrics.isWebInterface ? metrics.size(10) : 0)
                .padding(.top, metrics.isWebInterface ? metrics.size(8) : 0)
            stats
                .padding(.horizontal, metrics.isWebInterface ? metrics.size(12) : 0)
                .padding(.top, metrics.isWebInterface ? metrics.size(8) : 0)
                .padding(.bottom, metrics.isWebInterface ? metrics.size(6) : 0)
            if section == .servers, let error = model.error {
                if metrics.isWebInterface {
                    Text(verbatim: error).font(metrics.font(size: 12)).foregroundStyle(theme[.statusWaiting])
                        .padding(metrics.size(10)).frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .padding(metrics.size(10)).accessibilityIdentifier("mcp.panel.error")
                } else {
                    banner(error, symbol: "exclamationmark.triangle.fill", token: .statusStopped, id: "mcp.panel.error")
                }
            }
            list
            addButton
                .padding(.horizontal, metrics.isWebInterface ? metrics.size(10) : 0)
                .padding(.bottom, metrics.isWebInterface ? metrics.size(10) : 0)
            if section == .servers, !model.issues.isEmpty { diagnostics }
        }
        .padding(metrics.isWebInterface ? 0 : metrics.space(.l))
        .task(id: folder) { model.setRepository(folder) }
        .task(id: section) {
            if section == .skills, skills == nil { await loadSkills() }
        }
        .onChange(of: model.groups) { model.checkHealthOnce() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.panel")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.s)) {
            if metrics.isWebInterface {
                HStack(spacing: metrics.size(2)) {
                    ForEach([Section.servers, .skills], id: \.self) { option in
                        Button {
                            section = option
                        } label: {
                            Text((option == .servers ? "mcp.tab.servers" : "mcp.tab.skills") as LocalizedStringKey)
                        }
                        .buttonStyle(AletheSidebarFilterStyle(selected: section == option, kind: .segment))
                        .accessibilityAddTraits(section == option ? .isSelected : [])
                    }
                }
                .padding(metrics.size(3))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: section)
                .accessibilityIdentifier("mcp.panel.section")
            } else {
                Picker("mcp.view", selection: $section) {
                    Text("mcp.tab.servers").tag(Section.servers)
                    Text("mcp.tab.skills").tag(Section.skills)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("mcp.panel.section")
            }
            if !metrics.isWebInterface { Spacer(minLength: 0) }
            if !metrics.isWebInterface, section == .servers, model.healthAvailable {
                Button {
                    model.checkAllHealth()
                } label: {
                    Image(systemName: model.checking.isEmpty ? "waveform.path.ecg" : "hourglass")
                }
                .buttonStyle(.borderless)
                .disabled(!model.checking.isEmpty || model.groups.isEmpty)
                .help(Text("mcp.health.checkAll"))
                .accessibilityLabel(Text("mcp.health.checkAll"))
                .accessibilityIdentifier("mcp.panel.health")
            }
            Button {
                if section == .servers { Task { await model.refresh() } } else { Task { await loadSkills() } }
            } label: {
                if metrics.isWebInterface {
                    Image(systemName: "arrow.clockwise").font(metrics.font(size: 13))
                        .modifier(AletheSidebarSpinner(active: model.loading, kind: .mcp))
                } else { Image(systemName: "arrow.clockwise") }
            }
            .modifier(McpRefreshPresentation())
            .disabled(model.loading)
            .help(Text("mcp.refresh"))
            .accessibilityLabel(Text("mcp.refresh"))
            .accessibilityIdentifier("mcp.panel.refresh")
        }
        .padding(.horizontal, metrics.isWebInterface ? metrics.size(10) : 0)
        .padding(.top, metrics.isWebInterface ? metrics.size(10) : 0)
        .padding(.bottom, metrics.isWebInterface ? metrics.size(8) : 0)
        .overlay(alignment: .bottom) {
            if metrics.isWebInterface { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
        }
    }

    private var filters: some View {
        HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.xs)) {
            Group {
                if metrics.isWebInterface {
                    ScrollView(.horizontal) {
                        HStack(spacing: metrics.size(3)) { agentFilters }
                    }.scrollIndicators(.hidden)
                } else { agentFilters }
            }
            if !metrics.isWebInterface { Spacer(minLength: metrics.space(.s)) }
            if section == .servers {
                if metrics.isWebInterface {
                    HStack(spacing: metrics.size(6)) {
                        Button("mcp.scope.project") { scope.wrappedValue = .project }
                            .disabled(folder == nil)
                            .buttonStyle(AletheSidebarFilterStyle(selected: scope.wrappedValue == .project, kind: .scope))
                            .help(Text((folder == nil ? "mcp.scope.projectUnavailable" : "mcp.scope.help") as LocalizedStringKey))
                        Rectangle().fill(theme[.borderStrong]).frame(width: metrics.size(1), height: metrics.size(10))
                        Button("mcp.scope.global") { scope.wrappedValue = .global }
                            .buttonStyle(AletheSidebarFilterStyle(selected: scope.wrappedValue == .global, kind: .scope))
                            .help(Text("mcp.scope.help"))
                    }.font(metrics.font(size: 11)).fixedSize()
                        .accessibilityIdentifier("mcp.panel.scope")
                } else {
                    Picker("mcp.scope", selection: scope) {
                        Text("mcp.scope.project").tag(McpScope.project)
                        Text("mcp.scope.global").tag(McpScope.global)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .disabled(folder == nil)
                    .help(Text((folder == nil ? "mcp.scope.projectUnavailable" : "mcp.scope.help") as LocalizedStringKey))
                    .accessibilityIdentifier("mcp.panel.scope")
                }
            }
        }
    }

    private var agentFilters: some View {
            ForEach(McpAgent.allCases, id: \.self) { agent in
                let on = picked.contains(agent)
                Button {
                    if on { picked.remove(agent) } else { picked.insert(agent) }
                } label: {
                    Group {
                        if metrics.isWebInterface {
                            AgentLogo(agent: agent.rawValue, size: 13)
                        } else {
                            Circle()
                                .fill(theme[agent.colorToken].opacity(on || picked.isEmpty ? 1 : 0.3))
                                .frame(width: metrics.size(10), height: metrics.size(10))
                                .padding(metrics.space(.xs))
                                .background(on ? theme[.accentBgSoft] : .clear, in: Capsule())
                                .contentShape(Rectangle())
                        }
                    }
                }
                .modifier(McpFilterPresentation(selected: on))
                .help(Text(verbatim: agent.label))
                .accessibilityLabel(Text(verbatim: agent.label))
                .accessibilityValue(Text((on ? "mcp.filter.on" : "mcp.filter.off") as LocalizedStringKey))
                .accessibilityIdentifier("mcp.panel.agent.\(agent.rawValue)")
            }
    }

    private var scope: Binding<McpScope> {
        Binding {
            model.effectiveScope
        } set: {
            model.setScope($0)
        }
    }

    private var stats: some View {
        let shown = section == .servers ? visibleServers.count : visibleSkills.count
        let total = section == .servers ? model.groups.count : (skills?.count ?? 0)
        let filtered = !picked.isEmpty || !query.trimmingCharacters(in: .whitespaces).isEmpty
        let text =
            section == .servers
            ? (filtered ? format("mcp.stats.serversOf", shown, total) : format("mcp.stats.servers", shown))
            : (filtered ? format("mcp.stats.skillsOf", shown, total) : format("mcp.stats.skills", shown))
        return Text(verbatim: text)
            .font(metrics.isWebInterface ? metrics.font(size: 11.5) : metrics.font(.caption))
            .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .textSecondary])
            .accessibilityIdentifier("mcp.panel.stats")
    }

    // MARK: List

    @ViewBuilder private var list: some View {
        let loaded = section == .servers ? model.snapshots != nil : skills != nil
        let empty = section == .servers ? visibleServers.isEmpty : visibleSkills.isEmpty
        let none = section == .servers ? model.groups.isEmpty : (skills ?? []).isEmpty
        if !loaded && !metrics.isWebInterface {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if empty {
            Group {
                if metrics.isWebInterface {
                    WebMcpEmpty(title: emptyTitle(none: none), detail: none && section == .servers ? "mcp.empty.detail" : nil)
                } else {
                    ContentUnavailableView {
                        Label(emptyTitle(none: none), systemImage: "powerplug")
                    } description: {
                        if none && section == .servers { Text("mcp.empty.detail") }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("mcp.panel.empty")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: metrics.isWebInterface ? 0 : metrics.space(.xs)) {
                    if section == .servers {
                        ForEach(visibleServers, id: \.name) { group in serverRow(group) }
                    } else {
                        ForEach(visibleSkills) { group in skillRow(group) }
                    }
                }
                .padding(.horizontal, metrics.isWebInterface ? metrics.size(6) : 0)
                .padding(.bottom, metrics.isWebInterface ? metrics.size(10) : 0)
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func emptyTitle(none: Bool) -> LocalizedStringKey {
        guard none else { return "mcp.noMatch" }
        return section == .servers ? "mcp.empty.title" : "skills.empty.title"
    }

    private func serverRow(_ group: McpServerGroup) -> some View {
        Button {
            environment.editorRequest = .mcpManager(McpManagerRoute(server: group.name))
        } label: {
            VStack(alignment: .leading, spacing: metrics.isWebInterface ? metrics.size(5) : metrics.space(.xxs)) {
                HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.xs)) {
                    if !metrics.isWebInterface, let status = model.status(of: group) {
                        McpHealthDot(status: status)
                    }
                    Text(verbatim: group.name)
                        .frame(maxWidth: metrics.isWebInterface ? .infinity : nil, alignment: .leading)
                        .font(metrics.isWebInterface ? metrics.font(size: 12.5, weight: .medium) : metrics.font(.body).weight(.medium))
                        .lineLimit(1)
                        .truncationMode(metrics.isWebInterface ? .tail : .middle)
                    if group.hasDisabled { McpBadge(title: "mcp.badge.disabled") }
                    if group.records.contains(where: { $0.managedByImport != nil }) {
                        McpBadge(title: "mcp.badge.imported", token: .statusWaiting)
                    }
                    Spacer(minLength: 0)
                    McpAgentDots(present: group.agents, missing: group.missingAgents)
                }
                Text(verbatim: group.records.first?.server.transport.summary ?? "")
                    .font(metrics.isWebInterface ? metrics.monoFont(size: 10.5, weight: .regular) : metrics.font(.caption).monospaced())
                    .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .textSecondary])
                    .lineLimit(1)
                    .truncationMode(metrics.isWebInterface ? .tail : .middle)
            }
            .padding(metrics.isWebInterface ? metrics.size(8) : metrics.space(.s))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                theme[.surfaceCardDefault].opacity(metrics.isWebInterface ? 0 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.md))
            )
            .modifier(McpWebRowBackground())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text(verbatim: presence(group)))
        .accessibilityIdentifier("mcp.panel.row.\(group.name)")
    }

    private func presence(_ group: McpServerGroup) -> String {
        var text = format("mcp.presentOn", McpManagerModel.labels(group.agents))
        if !group.missingAgents.isEmpty { text += " · " + format("mcp.missingOn", McpManagerModel.labels(group.missingAgents)) }
        return text
    }

    private func skillRow(_ group: SkillGroup) -> some View {
        Button {
            environment.editorRequest = .mcpManager(McpManagerRoute(tab: .skills))
        } label: {
            VStack(alignment: .leading, spacing: metrics.isWebInterface ? metrics.size(5) : metrics.space(.xxs)) {
                HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.xs)) {
                    Text(verbatim: group.name)
                        .font(metrics.isWebInterface ? metrics.font(size: 12.5, weight: .medium) : metrics.font(.body).weight(.medium))
                        .lineLimit(1)
                    if group.bundled {
                        Group {
                            if metrics.isWebInterface {
                                Image(systemName: "lock").resizable().scaledToFit()
                                    .frame(width: metrics.size(11), height: metrics.size(11))
                            } else { Image(systemName: "lock.fill") }
                        }
                        .foregroundStyle(theme[.textTertiary])
                        .accessibilityLabel(Text("skills.badge.bundled"))
                    }
                    Spacer(minLength: 0)
                    HStack(spacing: metrics.isWebInterface ? metrics.size(3) : metrics.space(.xxs)) {
                        ForEach(group.agents, id: \.self) { agent in
                            Group {
                                if metrics.isWebInterface { AgentLogo(agent: agent.rawValue, size: 13) }
                                else { Circle().fill(theme[agent.colorToken]).frame(width: metrics.size(7), height: metrics.size(7)) }
                            }
                        }
                    }
                }
                Text(verbatim: group.description.isEmpty ? group.agents.map(\.label).joined(separator: ", ") : group.description)
                    .font(metrics.isWebInterface ? metrics.monoFont(size: 10.5, weight: .regular) : metrics.font(.caption))
                    .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .textSecondary])
                    .lineLimit(metrics.isWebInterface ? 1 : 2)
            }
            .padding(metrics.isWebInterface ? metrics.size(8) : metrics.space(.s))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                theme[.surfaceCardDefault].opacity(metrics.isWebInterface ? 0 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.md))
            )
            .modifier(McpWebRowBackground())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("mcp.panel.skill.\(group.name)")
    }

    private var addButton: some View {
        Group {
            if metrics.isWebInterface {
                Button {
                    environment.editorRequest = .mcpManager(
                        section == .servers ? McpManagerRoute(add: true) : McpManagerRoute(tab: .skills))
                } label: {
                    HStack(spacing: metrics.size(6)) {
                        Image(systemName: "plus").resizable().scaledToFit()
                            .frame(width: metrics.size(13), height: metrics.size(13))
                        Text((section == .servers ? "rightSidebar.mcp.addMore" : "mcp.manageSkills") as LocalizedStringKey)
                    }
                }.buttonStyle(AletheSidebarFilterStyle(kind: .add))
                    .accessibilityIdentifier("mcp.panel.add")
            } else {
                nativeAddButton
            }
        }
    }

    private var nativeAddButton: some View {
        Button {
            environment.editorRequest = .mcpManager(section == .servers ? McpManagerRoute(add: true) : McpManagerRoute(tab: .skills))
        } label: {
            Label(
                (section == .servers ? "mcp.addServer" : "mcp.manageSkills") as LocalizedStringKey,
                systemImage: section == .servers ? "plus" : "wand.and.stars"
            )
            .frame(maxWidth: .infinity)
        }
        .controlSize(.large)
        .disabled(section == .servers && model.writableAgents.isEmpty)
        .accessibilityIdentifier("mcp.panel.add")
    }

    @ViewBuilder private var diagnostics: some View {
        if metrics.isWebInterface {
            VStack(alignment: .leading, spacing: metrics.size(6)) {
                Text("mcp.diag.title").font(metrics.font(size: 10.5))
                    .tracking(metrics.size(0.42)).textCase(.uppercase).foregroundStyle(theme[.fgFaint])
                ForEach(model.issues, id: \.agent) { item in
                    HStack(spacing: metrics.size(7)) {
                        Text(verbatim: item.agent.label).foregroundStyle(theme[.fg])
                            .frame(minWidth: metrics.size(76), alignment: .leading).fixedSize(horizontal: true, vertical: false)
                        Text(item.issue.title).foregroundStyle(theme[.fgFaint]).lineLimit(1)
                    }.font(metrics.font(size: 11.5))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, metrics.size(8)).padding(.horizontal, metrics.size(12)).padding(.bottom, metrics.size(10))
            .overlay(alignment: .top) { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
            .accessibilityElement(children: .combine).accessibilityIdentifier("mcp.panel.diagnostics")
        } else { nativeDiagnostics }
    }

    private var nativeDiagnostics: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            Text("mcp.diag.title")
                .font(metrics.font(.caption).weight(.semibold))
                .foregroundStyle(theme[.textSecondary])
                .textCase(.uppercase)
            ForEach(model.issues, id: \.agent) { item in
                HStack(alignment: .firstTextBaseline, spacing: metrics.space(.xs)) {
                    Text(verbatim: item.agent.label)
                        .font(metrics.font(.caption).weight(.medium))
                    Text(item.issue.title)
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textSecondary])
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("mcp.panel.diagnostics")
    }

    private func banner(_ text: String, symbol: String, token: ThemeToken, id: String) -> some View {
        Label {
            Text(verbatim: text).textSelection(.enabled)
        } icon: {
            Image(systemName: symbol)
        }
        .font(metrics.font(.footnote))
        .foregroundStyle(theme[token])
        .accessibilityIdentifier(id)
    }

    private func loadSkills() async {
        let snapshots = (try? await skillStore.scan()) ?? []
        skills = SkillGroup.group(snapshots)
    }
}

// MARK: - Shared pieces

extension McpSnapshotIssue {
    var title: LocalizedStringKey {
        switch self {
        case .unsupported: "mcp.diag.unsupported"
        case .unreadable: "mcp.diag.unreadable"
        case .missing: "mcp.diag.missing"
        case .readOnly: "mcp.diag.readOnly"
        }
    }
}

extension McpHealthStatus {
    var title: LocalizedStringKey {
        switch self {
        case .connected: "mcp.health.connected"
        case .failed: "mcp.health.failed"
        case .needsAuth: "mcp.health.needsAuth"
        case .disabled: "mcp.health.disabled"
        case .unknown: "mcp.health.unknown"
        }
    }

    var token: ThemeToken {
        switch self {
        case .connected: .statusActive
        case .failed: .statusStopped
        case .needsAuth: .statusWaiting
        case .disabled, .unknown: .statusIdle
        }
    }
}

struct McpHealthDot: View {
    let status: McpHealthStatus
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Circle()
            .fill(theme[status.token])
            .frame(width: metrics.size(7), height: metrics.size(7))
            .help(Text(status.title))
            .accessibilityLabel(Text(status.title))
    }
}

struct McpBadge: View {
    let title: LocalizedStringKey
    var token: ThemeToken = .textSecondary
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Text(title)
            .lineLimit(metrics.isWebInterface ? 1 : nil)
            .font(metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.caption))
            .foregroundStyle(theme[metrics.isWebInterface && token == .textSecondary ? .fgFaint : token])
            .padding(.horizontal, metrics.isWebInterface ? metrics.size(6) : metrics.space(.xs))
            .padding(.vertical, metrics.isWebInterface ? metrics.size(3) : metrics.space(.xxs))
            .background(theme[.bgSunken].opacity(metrics.isWebInterface ? 0 : 1), in: Capsule())
            .overlay {
                if metrics.isWebInterface { Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)) }
            }
    }
}

/// Agents that have the server (filled) and readable agents that lack it (hollow).
struct McpAgentDots: View {
    let present: [McpAgent]
    let missing: [McpAgent]
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.isWebInterface ? metrics.size(3) : metrics.space(.xxs)) {
            ForEach(McpAgent.allCases.filter { present.contains($0) || missing.contains($0) }, id: \.self) { agent in
                if metrics.isWebInterface {
                    AgentLogo(agent: agent.rawValue, size: 13)
                        .opacity(present.contains(agent) ? 1 : 0.22)
                        .saturation(present.contains(agent) ? 1 : 0)
                } else if present.contains(agent) {
                    Circle().fill(theme[agent.colorToken])
                        .frame(width: metrics.size(7), height: metrics.size(7))
                } else {
                    Circle().strokeBorder(theme[agent.colorToken], lineWidth: 1)
                        .frame(width: metrics.size(7), height: metrics.size(7))
                }
            }
        }
        .fixedSize(horizontal: metrics.isWebInterface, vertical: false)
        .accessibilityHidden(true)
    }
}

private struct McpWebRowBackground: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false
    func body(content: Content) -> some View {
        content.background(
            theme[.panelHover].opacity(metrics.isWebInterface && hovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md))
        )
        .overlay {
            RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[.borderSubtle].opacity(metrics.isWebInterface && hovering ? 1 : 0), lineWidth: metrics.size(1))
        }
        .animation(metrics.isWebInterface ? Motion.sidebarColor(reduceMotion: metrics.reducesMotion) : nil, value: hovering)
        .onHover { hovering = $0 }
    }
}

/// The web MCP panel uses the compact bordered EmptyState component.
private struct WebMcpEmpty: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey?
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: metrics.size(10)) {
            Image(systemName: "powerplug").font(metrics.font(size: 20))
                .foregroundStyle(theme[.accent])
                .frame(width: metrics.size(56), height: metrics.size(56))
                .background(theme[.accentSoft], in: RoundedRectangle(cornerRadius: metrics.size(18)))
                .overlay(RoundedRectangle(cornerRadius: metrics.size(18)).strokeBorder(theme[.accentBorder], lineWidth: metrics.size(1)))
            VStack(spacing: metrics.size(6)) {
                Text(title).font(metrics.font(size: 15, weight: 650)).tracking(metrics.size(-0.3))
                if let detail {
                    Text(detail).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                        .lineSpacing(metrics.size(3))
                }
            }
            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(theme[.fg])
        .padding(.vertical, metrics.size(20)).padding(.horizontal, metrics.size(18))
        .frame(maxWidth: .infinity)
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .padding(metrics.size(12))
    }
}

private struct McpRefreshPresentation: ViewModifier {
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.buttonStyle(AletheSidebarUtilityStyle(disabledOpacity: 1, faintWhenDisabled: true))
        } else { content.buttonStyle(.borderless) }
    }
}

private struct McpFilterPresentation: ViewModifier {
    let selected: Bool
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        if metrics.isWebInterface { content.buttonStyle(AletheSidebarFilterStyle(selected: selected, kind: .agent)) }
        else { content.buttonStyle(.plain) }
    }
}
