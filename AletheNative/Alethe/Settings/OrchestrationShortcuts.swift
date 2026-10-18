import AletheDesign
import AletheModel
import AletheOrchestrator
import SwiftUI

/// Shortcuts type a draft into the lead's terminal; sending remains the user's action.
struct OrchestrationShortcuts: View {
    let job: JobSnapshot
    let project: ProjectID
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    private var shortcuts: [OrchestratorShortcut] {
        (environment.preferences?.document.orchestratorShortcuts ?? MultiagentWorkerSettings.defaults)
            .filter { $0.matches(done: job.status == .done, isolated: job.worktree != nil, native: job.native) }
    }
    private var planner: TabID? {
        guard let id = job.plannerID else { return nil }
        return environment.workspace?.document.projects.flatMap(\.panes).flatMap(\.tabs)
            .first { $0.id.rawValue == id }?.id
    }
    var body: some View {
        if metrics.isWebInterface, !shortcuts.isEmpty {
            FlowLayout(spacing: metrics.size(6), lineSpacing: metrics.size(6), leading: true) {
                ForEach(shortcuts) { shortcut in
                    Button {
                        guard let planner else { return }
                        let text = shortcut.render(jobID: job.id, agent: job.agent, worktree: job.worktree,
                            project: environment.workspace?.document.project(project)?.folder)
                        environment.workspace?.update { $0.activateTab(planner) }
                        _ = environment.terminals.typeInput("\u{1b}[200~" + text + "\u{1b}[201~", into: planner)
                    } label: { Text(verbatim: shortcut.name).font(metrics.font(size: 11)) }
                    .buttonStyle(AletheButtonStyle()).disabled(planner == nil)
                    .accessibilityIdentifier("orchestrator.worker.\(job.id).shortcut.\(shortcut.id)")
                }
            }
        }
    }
}
