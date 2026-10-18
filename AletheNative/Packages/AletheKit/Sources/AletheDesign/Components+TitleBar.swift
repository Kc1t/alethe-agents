import SwiftUI

/// MainMenu.module.css: flat 13-point rows, 14-point icons and 7×10 padding.
public struct AletheTitleBarMenuRowStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        TitleBarMenuRow(configuration: configuration)
    }
}

private struct TitleBarMenuRow: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .font(metrics.font(size: 13))
            .foregroundStyle(theme[configuration.role == .destructive ? .statusStopped : .fg])
            .opacity(isEnabled ? 1 : 0.45)
            .padding(.horizontal, metrics.size(10))
            .padding(.vertical, metrics.size(metrics.style == .clean ? 5 : 7))
            .frame(maxWidth: .infinity, minHeight: metrics.size(28), alignment: .leading)
            .background(theme[.panelHover].opacity(hovering || configuration.isPressed ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: hovering)
    }
}

/// MainMenu and usagePopover share an elevated, bordered surface.
public struct AletheTitleBarSurface: ViewModifier {
    public var usage: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    public init(usage: Bool = false) { self.usage = usage }
    public func body(content: Content) -> some View {
        let radius = usage ? metrics.size(metrics.style == .clean ? 6 : 12) : metrics.radius(.md)
        content
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius)
                .strokeBorder(theme[usage && metrics.style != .clean ? .borderStrong : .border], lineWidth: metrics.size(1)))
    }
}
