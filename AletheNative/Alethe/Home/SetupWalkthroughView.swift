import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// First-run steps on Home (upstream `SetupWalkthrough`): an agent installed, a first project, a first
/// terminal, a look at the themes. Steps complete from what exists; the card can be hidden and comes
/// back from Help › Show Setup Steps.
struct SetupWalkthroughView: View {
    let workspace: WorkspaceModel
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var agentsFound = false

    var body: some View {
        let preferences = environment.preferences?.document
        let progress = SetupProgress(document: workspace.document, agentsFound: agentsFound, marked: preferences?.setupDone)
        if preferences?.setupHidden != true, !progress.isComplete {
            VStack(alignment: .leading, spacing: metrics.space(.m)) {
                HStack(spacing: metrics.space(.l)) {
                    VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                        Text("setup.title").font(metrics.font(.headline))
                        Text(String(format: String(localized: "setup.progress"), progress.count, progress.total))
                            .font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
                    }
                    ProgressView(value: Double(progress.count), total: Double(progress.total))
                        .tint(theme[.accent])
                        .accessibilityHidden(true)
                    Button("setup.hide") { environment.preferences?.update { $0.setupHidden = true } }
                        .buttonStyle(.link)
                        .accessibilityIdentifier("setup.hide")
                }
                ForEach(SetupStep.allCases, id: \.self) { step in
                    row(step, done: progress.done.contains(step))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .aletheCard()
            .task { await findAgents() }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("setup")
        }
    }

    private func row(_ step: SetupStep, done: Bool) -> some View {
        Button { start(step) } label: {
            HStack(spacing: metrics.space(.m)) {
                Image(systemName: done ? "checkmark.circle.fill" : icon(step))
                    .foregroundStyle(done ? theme[.statusActive] : theme[.textSecondary])
                    .frame(width: metrics.size(18))
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Text(title(step)).font(metrics.font(.body).weight(.medium))
                        .strikethrough(done, color: theme[.textTertiary])
                    Text(detail(step)).font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
                }
                Spacer()
                Image(systemName: "arrow.right").foregroundStyle(theme[.textTertiary])
            }
            .padding(.vertical, metrics.space(.xs))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(Text(done ? "setup.done" : "setup.todo"))
        .accessibilityIdentifier("setup.\(step.rawValue)")
    }

    private func start(_ step: SetupStep) {
        switch step {
        case .agents:
            environment.settingsTab = .agents
            openSettings()
        case .project:
            environment.editorRequest = .newProject(.ungrouped)
        case .terminal:
            environment.editorRequest = workspace.document.projects.isEmpty ? .newProject(.ungrouped) : .newTerminal(nil)
        case .appearance:
            environment.preferences?.update { preferences in
                var done = preferences.setupDone ?? []
                if !done.contains(step.rawValue) { done.append(step.rawValue) }
                preferences.setupDone = done
            }
            environment.settingsTab = .appearance
            openSettings()
        }
    }

    /// Whether any enabled agent's CLI resolves (the launcher cache re-checks hits on disk).
    private func findAgents() async {
        let overrides = environment.preferences?.document.cliPaths ?? [:]
        agentsFound = AgentRegistry.builtin.enabledKinds(environment.preferences?.document.enabledAgents).contains { kind in
            guard kind != .shell, let command = AgentRegistry.builtin.descriptor(for: kind)?.cliCommand else { return false }
            return environment.launchers.resolve(command, override: overrides[kind.rawValue]) != nil
        }
    }

    private func icon(_ step: SetupStep) -> String {
        switch step {
        case .agents: "sparkles"
        case .project: "folder.badge.plus"
        case .terminal: "terminal"
        case .appearance: "paintpalette"
        }
    }

    private func title(_ step: SetupStep) -> LocalizedStringKey {
        switch step {
        case .agents: "setup.agents"
        case .project: "setup.project"
        case .terminal: "setup.terminal"
        case .appearance: "setup.appearance"
        }
    }

    private func detail(_ step: SetupStep) -> LocalizedStringKey {
        switch step {
        case .agents: "setup.agents.detail"
        case .project: "setup.project.detail"
        case .terminal: "setup.terminal.detail"
        case .appearance: "setup.appearance.detail"
        }
    }
}
