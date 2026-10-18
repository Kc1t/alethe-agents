import AletheDesign
import AletheModel
import SwiftUI

/// Scene restoration keeps the pane and profile identity, never a second writable workspace copy.
struct DetachedBoardID: Hashable, Codable {
    var profile: ProfileID?
    var pane: PaneID
}

struct DetachedOrchestrationWindow: View {
    let target: DetachedBoardID?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if !environment.startupFinished {
                ProgressView()
            } else if metrics.isWebInterface, let target, target.profile == environment.profileID,
                      let (project, pane) = environment.workspace?.document.pane(target.pane),
                      pane.content == .orchestrator {
                OrchestratorPaneView(project: project.id, isFocused: true, onClose: { dismiss() }, onDrag: { _ in })
                    .environment(\.contentPaneID, target.pane)
                    .environment(\.detachedOrchestration, true)
            } else {
                Text("orchestrator.windowPaneGone").foregroundStyle(theme[.fgMuted])
            }
        }
        .font(metrics.font(size: 12))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bg])
        .accessibilityIdentifier("orchestrator.detachedWindow")
    }
}

extension EnvironmentValues {
    @Entry var detachedOrchestration = false
}
