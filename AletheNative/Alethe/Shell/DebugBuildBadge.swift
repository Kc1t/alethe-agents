import AletheDesign
import AletheFoundation
import SwiftUI

struct DebugBuildBadge: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        Text(verbatim: "DEBUG")
            .font(metrics.font(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, metrics.size(7))
            .frame(height: metrics.size(18))
            .background(theme[.statusOffline], in: Capsule())
            .help(Text(verbatim: "Debug build · data in \(AppIdentity.bundleIdentifier)"))
            .accessibilityIdentifier("chrome.debugBadge")
    }
}
