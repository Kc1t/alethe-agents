import AletheDesign
import SwiftUI

struct PaneStackHeader: View {
    let orchestration: Bool
    let ungroup: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            Text(orchestration ? "paneGroup.orchestrationTitle" : "paneGroup.title")
                .textCase(.uppercase)
                .font(metrics.font(size: 11, weight: .semibold))
                .tracking(metrics.size(0.22))
            Spacer(minLength: 0)
            Button(action: ungroup) {
                Image(systemName: "rectangle.3.group")
                    .font(metrics.font(size: 14))
                    .frame(width: metrics.size(22), height: metrics.size(22))
            }
            .buttonStyle(.borderless)
            .help(Text("paneGroup.ungroup"))
            .accessibilityLabel(Text("paneGroup.ungroup"))
            .accessibilityIdentifier("paneGroup.ungroup")
        }
        .foregroundStyle(theme[.fgMuted])
        .padding(.leading, metrics.size(10))
        .padding(.trailing, metrics.size(8))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.panel])
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
    }
}
