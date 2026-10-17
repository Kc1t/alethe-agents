import SwiftUI

extension Motion {
    /// Timings from TitleBar, SubTabsLane and TerminalPane on origin/main.
    public enum WorkspaceEffect: Sendable {
        case tab, close, laneSelection, insertion, pane, action

        public func animation(reduceMotion: Bool) -> Animation? {
            guard !reduceMotion else { return nil }
            let duration: Double = switch self {
            case .tab: 0.14
            case .close: 0.12
            case .laneSelection: 0.16
            case .insertion: 0.18
            case .pane: 0.15
            case .action: 0.10
            }
            if self == .insertion {
                return .timingCurve(0.175, 0.885, 0.32, 1.275, duration: duration)
            }
            return .timingCurve(0.25, 0.1, 0.25, 1, duration: duration)
        }
    }
}

/// TerminalPane.module.css `.action`: 20pt target, 12pt icon and accent hover fill.
public struct AlethePaneActionStyle: ButtonStyle {
    private let danger: Bool
    public init(danger: Bool = false) { self.danger = danger }
    public func makeBody(configuration: Configuration) -> some View {
        PaneActionBody(configuration: configuration, danger: danger)
    }
}

private struct PaneActionBody: View {
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
            .frame(width: metrics.size(20), height: metrics.size(20))
            .foregroundStyle(theme[hovering && enabled ? (danger ? .statusOffline : .fg) : .fgFaint])
            .background(theme[danger ? .statusOfflineSoft : .accentSoft].opacity(hovering && enabled ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.size(5)))
            .opacity(enabled ? 1 : 0.3)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(Motion.WorkspaceEffect.action.animation(reduceMotion: metrics.reducesMotion), value: hovering)
    }
}
