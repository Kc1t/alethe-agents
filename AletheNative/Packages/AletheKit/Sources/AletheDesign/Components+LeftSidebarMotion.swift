import SwiftUI

extension Motion {
    /// CSS timings from origin/main's NormalProjectSidebar, Collapse, SidebarUpdate and UserProfile.
    public enum SidebarEffect: Sendable {
        case tabColor, tabFill, tabLift, layout, quickNavigation, rowSlot, status
        case chevron, collapse, collapseOpacity, panel, profile, profilePopover, cleanPopover

        public func animation(reduceMotion: Bool, clean: Bool = false) -> Animation? {
            guard !reduceMotion else { return nil }
            let duration: Double
            switch self {
            case .tabColor: duration = clean ? 0.12 : 0.14
            case .tabFill: duration = clean ? 0.12 : 0.16
            case .tabLift: duration = clean ? 0.12 : 0.18
            case .layout, .profile: duration = clean ? 0.12 : 0.10
            case .status: duration = 0.10
            case .quickNavigation: duration = clean ? 0.12 : 0.15
            case .rowSlot: duration = 0.12
            case .chevron: duration = 0.16
            case .collapse: duration = 0.17
            case .collapseOpacity: duration = 0.13
            case .panel: duration = 0.26
            case .profilePopover: duration = 0.12
            case .cleanPopover: duration = 0.18
            }
            switch self {
            case .tabLift, .chevron, .collapse, .panel, .cleanPopover:
                return .timingCurve(0.16, 1, 0.3, 1, duration: duration)
            case .profilePopover:
                return .timingCurve(0, 0, 0.58, 1, duration: duration)
            default:
                // CSS `ease`, which differs from SwiftUI's easeInOut.
                return .timingCurve(0.25, 0.1, 0.25, 1, duration: duration)
            }
        }
    }
}

/// The shared sidebar tab geometry with the web's independent color, fill and lift transitions.
public struct AletheSidebarMotionTabStyle: ButtonStyle {
    private let selected: Bool
    private let layout: Bool

    public init(isSelected: Bool, layout: Bool = false) {
        selected = isSelected
        self.layout = layout
    }

    public func makeBody(configuration: Configuration) -> some View {
        SidebarMotionTabBody(configuration: configuration, selected: selected, layout: layout)
    }
}

private struct SidebarMotionTabBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let layout: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    private func animation(_ effect: Motion.SidebarEffect) -> Animation? {
        effect.animation(reduceMotion: metrics.reducesMotion, clean: metrics.style == .clean)
    }

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 14))
            .foregroundStyle(theme[selected || hovering ? .fg : .fgMuted])
            .animation(animation(layout ? .layout : .tabColor), value: hovering)
            .animation(animation(layout ? .layout : .tabColor), value: selected)
            .frame(width: metrics.size(layout ? 24 : 28), height: metrics.size(layout ? 22 : 26))
            .background {
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .fill(theme[.panelHover].opacity(selected || (hovering && !layout) ? 1 : 0))
                    .animation(animation(layout ? .layout : .tabFill), value: hovering)
                    .animation(animation(layout ? .layout : .tabFill), value: selected)
            }
            .overlay {
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.border].opacity(selected && !layout ? 1 : 0), lineWidth: metrics.size(1))
                    .animation(animation(.tabFill), value: selected)
            }
            .contentShape(Rectangle())
            .offset(y: metrics.size(hovering && !layout ? -1 : 0))
            .animation(animation(.tabLift), value: hovering)
            .onHover { hovering = $0 && enabled }
    }
}
