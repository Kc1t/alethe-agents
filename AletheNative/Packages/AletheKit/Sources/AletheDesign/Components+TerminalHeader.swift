import SwiftUI

/// Web TerminalPane actions: 20-point floating or 22-point pinned targets, 12-point icons.
public struct AletheTerminalHeaderActionStyle: ButtonStyle {
    let pinned: Bool
    let active: Bool
    let danger: Bool
    public init(pinned: Bool, active: Bool = false, danger: Bool = false) {
        self.pinned = pinned
        self.active = active
        self.danger = danger
    }
    public func makeBody(configuration: Configuration) -> some View {
        TerminalHeaderActionBody(configuration: configuration, pinned: pinned, active: active, danger: danger)
    }
}

private struct TerminalHeaderActionBody: View {
    let configuration: ButtonStyleConfiguration
    let pinned: Bool
    let active: Bool
    let danger: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovered = false

    var body: some View {
        let highlighted = enabled && (hovered || configuration.isPressed)
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 12))
            .frame(width: metrics.size(pinned ? 22 : 20), height: metrics.size(pinned ? 22 : 20))
            .foregroundStyle(theme[highlighted && danger ? .statusOffline : highlighted || active ? .fg : .fgFaint])
            .background(theme[highlighted && danger ? .statusOfflineSoft : .accentSoft].opacity(highlighted || active ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.size(5)))
            .opacity(enabled ? 1 : 0.3)
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            .animation(.easeInOut(duration: metrics.reducesMotion ? 0 : 0.1), value: hovered)
    }
}

/// The exited terminal's web `.restartBtn`.
public struct AletheTerminalRestartStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        TerminalRestartBody(configuration: configuration)
    }
}

private struct TerminalRestartBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovered = false
    var body: some View {
        configuration.label
            .font(metrics.font(size: 13, weight: .medium))
            .foregroundStyle(theme[.fg])
            .padding(.horizontal, metrics.size(18))
            .padding(.vertical, metrics.size(7))
            .background(theme[hovered ? .panelHover : .bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[hovered ? .accent : .borderStrong], lineWidth: metrics.size(1)))
            .onHover { hovered = $0 }
    }
}
