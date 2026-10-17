import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// A tab's agent state at a glance (upstream sidebar busy/done glyph): the dot-matrix spinner while
/// working, a question bubble when it waits for an answer, a check when it finished unseen.
struct AgentStatusGlyph: View {
    let tab: TabID
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let activity = environment.terminals.activity[tab]
        let unread = environment.terminals.unread.contains(tab)
        Group {
            switch activity {
            case .working:
                AletheActivitySpinner()
                    .help(Text("agentStatus.working"))
                    .accessibilityLabel(Text("agentStatus.working"))
            case .needsInput:
                Image(systemName: "questionmark.bubble.fill").webProfileSized(14)
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.statusWaiting])
                    .help(Text("agentStatus.needsInput"))
                    .accessibilityLabel(Text("agentStatus.needsInput"))
            case .done where unread:
                Text(verbatim: "✓")
                    .font(metrics.monoFont(size: 11, weight: .bold))
                    .foregroundStyle(theme[.statusWorking])
                    .opacity(0.55)
                    .help(Text("agentStatus.done"))
                    .accessibilityLabel(Text("agentStatus.done"))
            default:
                EmptyView()
            }
        }
        .accessibilityIdentifier("agentStatus.\(tab.rawValue)")
    }
}
