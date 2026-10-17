import SwiftUI

/// TerminalPane.module.css `.action`: 22pt pinned target, 12pt icon and accent hover fill.
public struct AlethePinnedPaneActionStyle: ButtonStyle {
    private let danger: Bool
    public init(danger: Bool = false) { self.danger = danger }
    public func makeBody(configuration: Configuration) -> some View {
        PinnedPaneActionBody(configuration: configuration, danger: danger)
    }
}

private struct PinnedPaneActionBody: View {
    let configuration: ButtonStyleConfiguration
    let danger: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 12))
            .frame(width: metrics.size(22), height: metrics.size(22))
            .foregroundStyle(theme[(hovering || configuration.isPressed) && enabled ? (danger ? .statusOffline : .fg) : .fgFaint])
            .background(theme[danger ? .statusOfflineSoft : .accentSoft].opacity((hovering || configuration.isPressed) && enabled ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.size(5)))
            .opacity(enabled ? 1 : 0.3)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(Motion.WorkspaceEffect.action.animation(reduceMotion: metrics.reducesMotion), value: hovering)
    }
}
