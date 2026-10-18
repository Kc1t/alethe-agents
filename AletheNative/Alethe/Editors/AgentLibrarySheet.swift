import AletheDesign
import AletheIntegrations
import AletheModel
import SwiftUI

/// Project menu › Agent Library… (P5-16; upstream shows the library only in the Agent Canvas POC,
/// EXP-1): Claude Code subagents from the library installed in the project or in `~/.claude/agents`,
/// the economy (Haiku) agents toggle, and the other agents found there.
struct AgentLibrarySheet: View {
    let workspace: WorkspaceModel
    let projectID: ProjectID?
    @State private var model: AgentLibraryModel?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var project: Project? { projectID.flatMap { workspace.document.project($0) } }

    var body: some View {
        Group {
            if let model {
                if metrics.isWebInterface { webContent(model) } else { content(model) }
            } else {
                Text("agentLibrary.noProject")
                    .foregroundStyle(theme[.textSecondary])
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: metrics.isWebInterface ? nil : metrics.size(660), height: metrics.isWebInterface ? nil : metrics.size(560))
        .task {
            guard let project, let locations = environment.locations,
                  let profile = environment.profiles?.document.activeProfile.id else { return }
            let model = AgentLibraryModel(
                projectFolder: URL(filePath: project.folder, directoryHint: .isDirectory),
                home: FileManager.default.homeDirectoryForCurrentUser,
                profileDirectory: locations.profileDirectory(profile)
            )
            self.model = model
            await model.refresh()
        }
        .onDisappear { model?.cancel() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agentLibrary.sheet")
    }

    private func webContent(_ model: AgentLibraryModel) -> some View {
        ModalsM2WebModal(title: Text("agentLibrary.title"), close: { if let closeOverlay { closeOverlay() } else { dismiss() } }, width: 660) {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                Text("agentLibrary.subtitle").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                ModalsM2Segments(selection: Binding(get: { model.scopeChoice }, set: { model.select($0) }),
                                 options: [(.project, "agentLibrary.scope.project"), (.user, "agentLibrary.scope.user")])
                    .disabled(model.running).accessibilityIdentifier("agentLibrary.scope")
                Text(verbatim: model.scope.agentsDirectory.path).font(metrics.monoFont(size: 10.5))
                    .foregroundStyle(theme[.fgFaint]).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    .accessibilityIdentifier("agentLibrary.path")
                if model.loading { ProgressView().frame(maxWidth: .infinity) } else {
                    VStack(alignment: .leading, spacing: metrics.size(8)) {
                        Text("agentLibrary.section.library").font(metrics.font(size: 10, weight: .semibold)).textCase(.uppercase)
                            .foregroundStyle(theme[.fgFaint]).tracking(metrics.size(0.6))
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(240)), spacing: metrics.size(8))], spacing: metrics.size(8)) {
                            ForEach(AgentLibraryCatalog.templates) { template in
                                webTemplate(template, model)
                            }
                        }
                    }.accessibilityIdentifier("agentLibrary.list")
                    Toggle(isOn: Binding(get: { model.economyOn }, set: { model.setEconomy($0) })) {
                        VStack(alignment: .leading, spacing: metrics.size(3)) {
                            Text("agentLibrary.economy.toggle").font(metrics.font(size: 12.5, weight: .medium))
                            Text("agentLibrary.economy.detail").font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
                        }
                    }.disabled(model.running).accessibilityIdentifier("agentLibrary.economy")
                    ForEach(EconomyAgents.templates) { template in webTemplate(template, model) }
                    ForEach(model.otherAgents) { agent in otherRow(agent, model) }
                }
                if let error = model.error {
                    Text(verbatim: error).foregroundStyle(theme[.statusStopped]).accessibilityIdentifier("agentLibrary.error")
                }
                if let note = model.note {
                    Text(verbatim: note).foregroundStyle(theme[.fgMuted]).accessibilityIdentifier("agentLibrary.note")
                }
                if model.restartHint { Text("agentLibrary.restartHint").foregroundStyle(theme[.fgFaint]) }
            }
        } footer: {
            Button("agentLibrary.undo") { model.undo() }.disabled(model.lastChange == nil || model.running)
                .accessibilityIdentifier("agentLibrary.undo")
            Button("agentLibrary.refresh") { Task { await model.refresh() } }.disabled(model.running)
            Spacer()
            Button("agentInstall.done") { if let closeOverlay { closeOverlay() } else { dismiss() } }.accessibilityIdentifier("agentLibrary.close")
        }
        .webConfirm(isPresented: Binding(
            get: { model.pendingOverwrite != nil }, set: { if !$0 { model.pendingOverwrite = nil } }),
                    message: model.pendingOverwrite.map { String(format: String(localized: "agentLibrary.overwrite.message"), $0.fileName) } ?? "",
                    title: String(localized: "agentLibrary.overwrite.title"),
                    confirmTitle: String(localized: "agentLibrary.overwrite.confirm"), destructive: true) {
            if let template = model.pendingOverwrite { model.install(template, overwriteForeign: true) }
        }
        .webConfirm(isPresented: Binding(
            get: { model.pendingForeignRemoval != nil }, set: { if !$0 { model.pendingForeignRemoval = nil } }),
                    message: model.pendingForeignRemoval.map { String(format: String(localized: "agentLibrary.removeForeign.message"), "\($0.name).md") } ?? "",
                    title: String(localized: "agentLibrary.removeForeign.title"),
                    confirmTitle: String(localized: "agentLibrary.remove"), destructive: true) {
            if let agent = model.pendingForeignRemoval { model.remove(agent, force: true) }
        }
        .confirmationDialog("agentLibrary.overwrite.title", isPresented: Binding(
            get: { !metrics.isWebInterface && model.pendingOverwrite != nil }, set: { if !$0 { model.pendingOverwrite = nil } }
        ), presenting: model.pendingOverwrite) { template in
            Button("agentLibrary.overwrite.confirm", role: .destructive) { model.install(template, overwriteForeign: true) }
        } message: { template in
            Text(String(format: String(localized: "agentLibrary.overwrite.message"), template.fileName))
        }
        .confirmationDialog("agentLibrary.removeForeign.title", isPresented: Binding(
            get: { !metrics.isWebInterface && model.pendingForeignRemoval != nil }, set: { if !$0 { model.pendingForeignRemoval = nil } }
        ), presenting: model.pendingForeignRemoval) { agent in
            Button("agentLibrary.remove", role: .destructive) { model.remove(agent, force: true) }
        } message: { agent in
            Text(String(format: String(localized: "agentLibrary.removeForeign.message"), "\(agent.name).md"))
        }
    }

    private func webTemplate(_ template: AgentTemplate, _ model: AgentLibraryModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(6)) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "person.crop.circle").font(metrics.font(size: 14))
                    .frame(width: metrics.size(22), height: metrics.size(22))
                Text(verbatim: template.name).font(metrics.font(size: 12, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 0)
                CostBadge(cost: template.cost)
            }
            Text(template.summaryKey).font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
            HStack(spacing: metrics.size(6)) { libraryButtons(template, model) }
                .buttonStyle(AletheButtonStyle())
            if let installed = model.installed(template.name) {
                Text(installed.fromAlethe ? "agentLibrary.status.installed" : "agentLibrary.status.foreign")
                    .font(metrics.font(size: 10)).foregroundStyle(theme[.statusWorking])
                    .accessibilityIdentifier("agentLibrary.status.\(template.name)")
            }
        }
        .padding(metrics.size(8)).frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityElement(children: .contain).accessibilityIdentifier("agentLibrary.row.\(template.name)")
    }

    private func content(_ model: AgentLibraryModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(model)
            Divider()
            if model.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    Section("agentLibrary.section.library") {
                        ForEach(AgentLibraryCatalog.templates) { template in
                            AgentTemplateRow(template: template, installed: model.installed(template.name)) {
                                libraryButtons(template, model)
                            }
                        }
                    }
                    Section {
                        Toggle(isOn: Binding(get: { model.economyOn }, set: { model.setEconomy($0) })) {
                            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                                Text("agentLibrary.economy.toggle")
                                Text("agentLibrary.economy.detail")
                                    .font(metrics.font(.footnote))
                                    .foregroundStyle(theme[.textSecondary])
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .disabled(model.running)
                        .accessibilityIdentifier("agentLibrary.economy")
                        ForEach(EconomyAgents.templates) { template in
                            AgentTemplateRow(template: template, installed: model.installed(template.name)) { EmptyView() }
                        }
                    } header: { Text("agentLibrary.section.economy") }
                    if !model.otherAgents.isEmpty {
                        Section("agentLibrary.section.other") {
                            ForEach(model.otherAgents) { agent in
                                otherRow(agent, model)
                            }
                        }
                    }
                }
                .accessibilityIdentifier("agentLibrary.list")
            }
            Divider()
            footer(model)
        }
        .confirmationDialog("agentLibrary.overwrite.title", isPresented: Binding(
            get: { model.pendingOverwrite != nil }, set: { if !$0 { model.pendingOverwrite = nil } }
        ), presenting: model.pendingOverwrite) { template in
            Button("agentLibrary.overwrite.confirm", role: .destructive) { model.install(template, overwriteForeign: true) }
        } message: { template in
            Text(String(format: String(localized: "agentLibrary.overwrite.message"), template.fileName))
        }
        .confirmationDialog("agentLibrary.removeForeign.title", isPresented: Binding(
            get: { model.pendingForeignRemoval != nil }, set: { if !$0 { model.pendingForeignRemoval = nil } }
        ), presenting: model.pendingForeignRemoval) { agent in
            Button("agentLibrary.remove", role: .destructive) { model.remove(agent, force: true) }
        } message: { agent in
            Text(String(format: String(localized: "agentLibrary.removeForeign.message"), "\(agent.name).md"))
        }
    }

    private func header(_ model: AgentLibraryModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            Text("agentLibrary.title").font(metrics.font(.title3))
            Text("agentLibrary.subtitle")
                .font(metrics.font(.body))
                .foregroundStyle(theme[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            Picker("agentLibrary.scope", selection: Binding(get: { model.scopeChoice }, set: { model.select($0) })) {
                Text("agentLibrary.scope.project").tag(AgentLibraryModel.ScopeChoice.project)
                Text("agentLibrary.scope.user").tag(AgentLibraryModel.ScopeChoice.user)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(model.running)
            .accessibilityIdentifier("agentLibrary.scope")
            Text(verbatim: model.scope.agentsDirectory.path)
                .font(metrics.font(.caption).monospaced())
                .foregroundStyle(theme[.textTertiary])
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .accessibilityIdentifier("agentLibrary.path")
        }
        .padding(metrics.space(.l))
    }

    @ViewBuilder
    private func libraryButtons(_ template: AgentTemplate, _ model: AgentLibraryModel) -> some View {
        if let agent = model.installed(template.name) {
            if agent.fromAlethe {
                Button("agentLibrary.reinstall") { model.install(template) }
                    .disabled(model.running)
                    .accessibilityIdentifier("agentLibrary.reinstall.\(template.name)")
            }
            Button("agentLibrary.remove") { model.remove(agent) }
                .disabled(model.running)
                .accessibilityIdentifier("agentLibrary.remove.\(template.name)")
        } else {
            Button("agentLibrary.install") { model.install(template) }
                .disabled(model.running)
                .accessibilityIdentifier("agentLibrary.install.\(template.name)")
        }
    }

    private func otherRow(_ agent: InstalledAgent, _ model: AgentLibraryModel) -> some View {
        HStack(spacing: metrics.space(.s)) {
            Text(verbatim: agent.name).font(metrics.font(.body).monospaced())
            Text(agent.fromAlethe ? "agentLibrary.status.alethe" : "agentLibrary.status.foreign")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
            Spacer()
            Button("agentLibrary.remove") { model.remove(agent) }
                .disabled(model.running)
                .accessibilityIdentifier("agentLibrary.remove.\(agent.name)")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agentLibrary.row.\(agent.name)")
    }

    private func footer(_ model: AgentLibraryModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            if let error = model.error {
                Label { Text(verbatim: error).textSelection(.enabled) } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.statusStopped])
                .accessibilityIdentifier("agentLibrary.error")
            }
            if let note = model.note {
                Text(verbatim: note)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .accessibilityIdentifier("agentLibrary.note")
            }
            if model.restartHint {
                Text("agentLibrary.restartHint")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
            }
            HStack {
                if model.running { ProgressView().controlSize(.small) }
                Button("agentLibrary.undo") { model.undo() }
                    .disabled(model.lastChange == nil || model.running)
                    .accessibilityIdentifier("agentLibrary.undo")
                Button("agentLibrary.refresh") { Task { await model.refresh() } }
                    .disabled(model.running)
                Spacer()
                Button("agentInstall.done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("agentLibrary.close")
            }
        }
        .padding(metrics.space(.l))
    }
}

/// One template: name, category, cost badge, summary and installed state; `actions` trail.
private struct AgentTemplateRow<Actions: View>: View {
    let template: AgentTemplate
    let installed: InstalledAgent?
    @ViewBuilder let actions: () -> Actions
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(alignment: .top, spacing: metrics.space(.m)) {
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                HStack(spacing: metrics.space(.s)) {
                    Text(verbatim: template.name).font(metrics.font(.body).monospaced())
                    Text(template.category.title)
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textTertiary])
                    CostBadge(cost: template.cost)
                }
                Text(template.summaryKey)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                if let installed {
                    Text(installed.fromAlethe ? "agentLibrary.status.installed" : "agentLibrary.status.foreign")
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[installed.fromAlethe ? .statusActive : .statusWaiting])
                        .accessibilityIdentifier("agentLibrary.status.\(template.name)")
                }
            }
            Spacer()
            actions()
        }
        .padding(.vertical, metrics.space(.xxs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agentLibrary.row.\(template.name)")
    }
}

private struct CostBadge: View {
    let cost: AgentCost
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var tokens: (text: ThemeToken, fill: ThemeToken) {
        switch cost {
        case .cheap: (.statusWorking, .statusWorkingSoft)
        case .medium: (.statusWaiting, .statusWaitingSoft)
        case .expensive: (.statusStopped, .statusStoppedSoft)
        }
    }

    var body: some View {
        Text(cost.title)
            .font(metrics.font(.caption).weight(.medium))
            .foregroundStyle(theme[tokens.text])
            .padding(.horizontal, metrics.space(.xs))
            .padding(.vertical, metrics.space(.xxs))
            .background(theme[tokens.fill], in: Capsule())
    }
}

extension AgentCategory {
    var title: LocalizedStringKey {
        switch self {
        case .orchestration: LocalizedStringKey("agentLibrary.category.orchestration")
        case .frontend: LocalizedStringKey("agentLibrary.category.frontend")
        case .backend: LocalizedStringKey("agentLibrary.category.backend")
        case .qa: LocalizedStringKey("agentLibrary.category.qa")
        case .docs: LocalizedStringKey("agentLibrary.category.docs")
        case .economy: LocalizedStringKey("agentLibrary.category.economy")
        }
    }
}

extension AgentCost {
    var title: LocalizedStringKey {
        switch self {
        case .cheap: LocalizedStringKey("agentLibrary.cost.cheap")
        case .medium: LocalizedStringKey("agentLibrary.cost.medium")
        case .expensive: LocalizedStringKey("agentLibrary.cost.expensive")
        }
    }
}

extension AgentTemplate {
    /// The localized summary; the English one in the template is the fallback.
    var summaryKey: LocalizedStringKey {
        switch name {
        case "orchestrator": LocalizedStringKey("agentLibrary.summary.orchestrator")
        case "frontend-dev": LocalizedStringKey("agentLibrary.summary.frontendDev")
        case "backend-dev": LocalizedStringKey("agentLibrary.summary.backendDev")
        case "qa-reviewer": LocalizedStringKey("agentLibrary.summary.qaReviewer")
        case "docs-writer": LocalizedStringKey("agentLibrary.summary.docsWriter")
        case "haiku-summarizer": LocalizedStringKey("agentLibrary.summary.haikuSummarizer")
        case "haiku-mechanic": LocalizedStringKey("agentLibrary.summary.haikuMechanic")
        case "codex-executor": LocalizedStringKey("agentLibrary.summary.codexExecutor")
        default: LocalizedStringKey(stringLiteral: summary)
        }
    }
}
