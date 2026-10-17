import SwiftUI

/// ImageInput's controls.module.css iconBtn: 36px, bordered sunken background.
public struct AletheImageInputButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        ImageInputButtonBody(configuration: configuration)
    }
}

private struct ImageInputButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .foregroundStyle(theme[.fg])
            .frame(width: metrics.size(36), height: metrics.size(36))
            .background(theme[hovering ? .panelHover : .bgSunken],
                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[hovering ? .borderStrong : .border], lineWidth: metrics.size(1)))
            .opacity(enabled ? 1 : 0.45)
            .onHover { hovering = $0 && enabled }
    }
}
