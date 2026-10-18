import AletheAgents
import AletheDesign
import AletheGit
import AletheModel
import SwiftUI

struct ProjectAdvancedDraft {
    var validation = ""
    var healthCommand = ""
    var healthPath = ""
    var provider = "claude"
    var model = ""
    var gsdWatcher = false
    init(_ project: Project? = nil) {
        validation = project?.validationCommands?.joined(separator: "\n") ?? ""
        healthCommand = project?.healthCheckCommand ?? ""
        healthPath = project?.healthCheckPath ?? ""
        provider = project?.conflictAgentProvider ?? "claude"
        model = project?.conflictAgentModel ?? ""
        gsdWatcher = project?.gsdWatcherEnabled ?? false
    }
    func apply(to project: inout Project) {
        let commands = validation.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        project.validationCommands = commands.isEmpty ? nil : commands
        project.healthCheckCommand = optional(healthCommand)
        project.healthCheckPath = optional(healthPath)
        project.conflictAgentProvider = provider
        project.conflictAgentModel = optional(model)
        project.gsdWatcherEnabled = gsdWatcher
    }
    private func optional(_ value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

/// The additional web EditProjectAgentSettings fields; the native Form stays unchanged.
struct ProjectEditorAdvanced: View {
    @Binding var draft: ProjectAdvancedDraft
    let project: ProjectID?
    let mode: ProjectWorktreeMode
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var models: [String] = []
    @State private var confirming = false
    @State private var migrating = false
    @State private var failure: String?
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            ProjectGroupWebField(title: "editor.advanced.validation") {
                TextEditor(text: $draft.validation).font(metrics.monoFont(size: 11))
                    .scrollContentBackground(.hidden).padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(7))
                    .frame(minHeight: metrics.size(76)).background(theme[.bgSunken])
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .accessibilityLabel(Text("editor.advanced.validation"))
            }
            ProjectGroupWebField(title: "editor.advanced.healthCommand") {
                TextField(text: $draft.healthCommand, prompt: Text("editor.advanced.healthCommandPlaceholder")) {
                    Text("editor.advanced.healthCommand")
                }.modifier(ProjectGroupWebInput())
                Text("editor.advanced.healthHint").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            }
            if !draft.healthCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ProjectGroupWebField(title: "editor.advanced.healthPath") {
                    TextField(text: $draft.healthPath, prompt: Text(verbatim: "/")) { Text("editor.advanced.healthPath") }
                        .modifier(ProjectGroupWebInput())
                }
            }
            ProjectGroupWebField(title: "editor.advanced.provider") {
                AletheSelect(selection: $draft.provider, options: environment.agentRegistry.descriptors.filter { !$0.isShell }.map { $0.kind.rawValue }) { value in
                    Text(verbatim: environment.agentRegistry.descriptor(for: .init(rawValue: value))?.displayName ?? value)
                }.onChange(of: draft.provider) { _, _ in draft.model = "" }
            }
            ProjectGroupWebField(title: "editor.advanced.model") {
                HStack(spacing: metrics.size(6)) {
                    TextField(text: $draft.model) { Text("editor.advanced.model") }.modifier(ProjectGroupWebInput())
                    if !models.isEmpty {
                        Menu {
                            ForEach(models, id: \.self) { model in Button { draft.model = model } label: { Text(verbatim: model) } }
                        } label: { Image(systemName: "chevron.down").font(metrics.font(size: 12)) }
                        .accessibilityLabel(Text("editor.advanced.model"))
                    }
                }
            }
            if project != nil {
                Button(migrating ? "editor.advanced.migrating" : "editor.advanced.migrate") { confirming = true }.disabled(migrating)
                Text("editor.advanced.migrateHint").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            }
            if environment.features.isOn(.gsdSync) {
                Toggle("editor.advanced.gsdWatcher", isOn: $draft.gsdWatcher).toggleStyle(.checkbox).font(metrics.font(size: 11))
            }
            if let failure { Text(verbatim: failure).font(metrics.font(size: 11)).foregroundStyle(theme[.statusStopped]) }
        }
        .task(id: draft.provider) {
            let kind = AgentKind(rawValue: draft.provider)
            models = []
            if let cli = environment.agentRegistry.descriptor(for: kind)?.cliCommand,
               let executable = environment.launchers.resolve(cli, override: environment.preferences?.document.cliPaths?[draft.provider]) {
                let found = await ModelDiscovery.discover(kind, executable: executable)
                if !Task.isCancelled { models = found }
            }
        }
        .confirmationDialog("editor.advanced.migrateConfirm", isPresented: $confirming, titleVisibility: .visible) {
            Button("editor.advanced.migrate", role: .destructive) { migrate() }
            Button("editor.cancel", role: .cancel) {}
        }
    }
    private func migrate() {
        guard let project, let workspace = environment.workspace,
              let current = workspace.document.project(project), !migrating else { return }
        migrating = true; failure = nil
        let tabs = current.panes.flatMap(\.tabs).filter { $0.agent != "shell" && $0.worktreeAgentID == nil }
        let mode: WorktreeMode = mode == .localCopy ? .localCopy : .gitWorktree
        Task {
            defer { migrating = false }
            for tab in tabs {
                do {
                    let info = try await GitWorktrees().provision(repo: URL(filePath: current.folder), agentId: tab.id.rawValue, mode: mode)
                    // Only stop a running conversation after its replacement checkout exists.
                    environment.terminals.suspend(tab.id)
                    workspace.update { document in
                        document.updateTab(tab.id) {
                            $0.workingDirectory = info.path; $0.worktreeAgentID = info.agentId
                            $0.worktreeBranch = info.branch; $0.sessionID = nil
                        }
                    }
                    if let updated = workspace.document.project(project),
                       let replacement = updated.panes.flatMap(\.tabs).first(where: { $0.id == tab.id }) {
                        environment.terminals.restart(replacement, in: updated, environment: environment)
                    }
                } catch { failure = NewTerminalSheet.describe(error); return }
            }
        }
    }
}
