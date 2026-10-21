import AletheDesign
import SwiftUI

/// HomeView.module.css: the 30px details summaries retain their compact trigger design.
struct HomeChoiceTrigger: ViewModifier {
    let open: Bool
    var agent = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content
            .font(agent ? metrics.font(size: 10) : metrics.monoFont(size: 10))
            .foregroundStyle(theme[.fgMuted])
            .padding(.horizontal, metrics.size(8)).frame(height: metrics.size(30))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[open && !agent ? .panelHover : .bgSunken].opacity(open && !agent ? 1 : 0.72),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[open ? (agent ? .accent : .accentBorder) : .border], lineWidth: metrics.size(1)))
    }
}
