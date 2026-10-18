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
    @State private var hoveredStep: SetupStep?

    var body: some View {
        let preferences = environment.preferences?.document
        let progress = SetupProgress(document: workspace.document, agentsFound: agentsFound, marked: preferences?.setupDone)
        if metrics.isWebInterface {
            let steps: [SetupStep] = [.project, .appearance]
            let count = steps.filter { progress.done.contains($0) }.count
            if preferences?.setupHidden != true, count < steps.count {
                webCard(progress: progress, steps: steps, count: count)
            }
        } else if preferences?.setupHidden != true, !progress.isComplete {
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

    private func webCard(progress: SetupProgress, steps: [SetupStep], count: Int) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(12)) {
                VStack(alignment: .leading, spacing: metrics.size(3)) {
                    Text("home.setup.title").font(metrics.font(size: 12.5, weight: .semibold))
                        .foregroundStyle(theme[.fg])
                    Text(verbatim: String(format: String(localized: "setup.progress"), count, steps.count))
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                GeometryReader { geometry in
                    RoundedRectangle(cornerRadius: metrics.size(2)).fill(theme[.panel])
                        .overlay(alignment: .leading) {
                            theme[.statusWorking].frame(width: geometry.size.width * CGFloat(count) / CGFloat(steps.count))
                        }
                        .clipShape(RoundedRectangle(cornerRadius: metrics.size(2)))
                }
                .frame(width: metrics.size(58), height: metrics.size(3))
                .accessibilityHidden(true)
                Button("setup.hide") { environment.preferences?.update { $0.setupHidden = true } }
                    .buttonStyle(.plain)
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                    .accessibilityIdentifier("setup.hide")
            }
            .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(12))
            .background(theme[.bgSunken])
            ForEach(steps, id: \.self) { step in
                webRow(step, done: progress.done.contains(step))
                    .overlay(alignment: .top) { theme[.border].frame(height: metrics.size(1)) }
            }
            Text("setup.footer")
                .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(10))
                .background(theme[.bgSunken])
                .overlay(alignment: .top) { theme[.border].frame(height: metrics.size(1)) }
        }
        .background(theme[.bgElevated])
        .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("setup")
    }

    private func webRow(_ step: SetupStep, done: Bool) -> some View {
        Button { start(step) } label: {
            HStack(alignment: .top, spacing: metrics.size(11)) {
                Image(systemName: done ? "checkmark" : icon(step)).webProfileSized(done ? 10 : 14)
                    .font(metrics.font(size: done ? 10 : 14))
                    .foregroundStyle(theme[done ? .bg : .fgMuted])
                    .frame(width: metrics.size(20), height: metrics.size(20))
                    .background(theme[done ? .statusWorking : .bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[done ? .statusWorking : .borderStrong], lineWidth: metrics.size(1)))
                    .padding(.top, metrics.size(1))
                VStack(alignment: .leading, spacing: metrics.size(3)) {
                    Text(step == .project ? "home.setup.project" : "home.setup.appearance").font(metrics.font(size: 12.5))
                        .foregroundStyle(theme[done ? .fgFaint : .fg])
                        .strikethrough(done)
                    Text(step == .project ? "home.setup.project.detail" : "home.setup.appearance.detail").font(metrics.font(size: 11))
                        .foregroundStyle(theme[.fgFaint])
                        .lineSpacing(metrics.size(5.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "arrow.right").webProfileSized(13)
                    .font(metrics.font(size: 13)).foregroundStyle(theme[.fgMuted])
                    .padding(.top, metrics.size(3))
            }
            .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(11))
            .opacity(done ? 0.6 : 1)
            .contentShape(Rectangle())
            .background(hoveredStep == step ? theme[.panel] : theme[.bgElevated])
        }
        .buttonStyle(.plain)
        .onHover { hoveredStep = $0 ? step : nil }
        .accessibilityValue(Text(done ? "setup.done" : "setup.todo"))
        .accessibilityIdentifier("setup.\(step.rawValue)")
    }

    private func row(_ step: SetupStep, done: Bool) -> some View {
        Button { start(step) } label: {
            HStack(spacing: metrics.space(.m)) {
                Image(systemName: done ? "checkmark.circle.fill" : icon(step)).webProfileSized(14)
                    .foregroundStyle(done ? theme[.statusActive] : theme[.textSecondary])
                    .frame(width: metrics.size(18))
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Text(title(step)).font(metrics.font(.body).weight(.medium))
                        .strikethrough(done, color: theme[.textTertiary])
                    Text(detail(step)).font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
                }
                Spacer()
                Image(systemName: "arrow.right").webProfileSized(14).foregroundStyle(theme[.textTertiary])
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
        case .appearance where metrics.isWebInterface:
            // The web opens its theme picker modal here; Done marks the step.
            environment.editorRequest = .themePicker
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
