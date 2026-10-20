import AletheDesign
import AletheModel
import SwiftUI

/// NormalTerminalNode shows busy or unread completion; waiting does not occupy the end slot.
struct SidebarWebTerminalStatus: View {
    let tab: TabID
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if environment.terminals.activity[tab] == .working {
                AletheSidebarSizeSpinner()
                    .help(Text("agentStatus.working"))
                    .accessibilityLabel(Text("agentStatus.working"))
            } else if environment.terminals.unread.contains(tab) {
                Text(verbatim: "✓")
                    .font(metrics.monoFont(size: 11, weight: .bold))
                    .foregroundStyle(theme[.statusWorking].opacity(0.55))
                    .help(Text("agentStatus.done"))
                    .accessibilityLabel(Text("agentStatus.done"))
            }
        }
        .accessibilityIdentifier("agentStatus.\(tab.rawValue)")
    }
}
