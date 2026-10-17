import SwiftUI

/// NormalProjectSidebar.module.css quickNavItem: 6×8 padding and a small hover radius.
public struct AletheSidebarSearchStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        SidebarSearchBody(configuration: configuration)
    }
}

private struct SidebarSearchBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .foregroundStyle(theme[hovering ? .fg : .fgMuted])
            .padding(.horizontal, metrics.size(8))
            .padding(.vertical, metrics.size(6))
            .background(theme[.panelHover].opacity(hovering ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.5)
            .animation(Motion.SidebarEffect.quickNavigation.animation(
                reduceMotion: metrics.reducesMotion, clean: metrics.style == .clean), value: hovering)
            .onHover { hovering = $0 && enabled }
    }
}
