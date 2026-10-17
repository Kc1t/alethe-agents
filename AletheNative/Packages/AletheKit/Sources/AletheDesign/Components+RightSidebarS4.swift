import SwiftUI

/// McpPanel.module.css agentChip and TodoSidebar.module.css filterButton.
public struct AletheSidebarFilterStyle: ButtonStyle {
    public enum Kind { case agent, todo, segment, scope, add }
    let selected: Bool
    let kind: Kind
    @Environment(\.metrics) private var metrics

    public init(selected: Bool = false, kind: Kind) {
        self.selected = selected
        self.kind = kind
    }

    public func makeBody(configuration: Configuration) -> some View {
        SidebarFilterBody(configuration: configuration, selected: selected, kind: kind)
    }
}

private struct SidebarFilterBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let kind: AletheSidebarFilterStyle.Kind
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    private var token: ThemeToken {
        if kind == .scope { return selected ? .accent : hovering ? .fgMuted : .fgFaint }
        if kind == .add && hovering { return .accent }
        return selected || hovering ? .fg : kind == .todo ? .fgFaint : .fgMuted
    }

    var body: some View {
        configuration.label
            .font(metrics.font(size: kind == .scope || kind == .todo ? 11 : 12,
                               weight: kind == .scope && selected ? .medium : .regular))
            .foregroundStyle(theme[token])
            .padding(.horizontal, metrics.size(kind == .todo ? 9 : kind == .segment ? 8 : kind == .add ? 10 : 0))
            .padding(.vertical, metrics.size(kind == .segment ? 4 : kind == .add ? 7 : 0))
            .frame(width: kind == .agent ? metrics.size(24) : nil,
                   height: kind == .agent ? metrics.size(24) : kind == .todo ? metrics.size(25) : nil)
            .frame(maxWidth: kind == .segment || kind == .add ? .infinity : nil)
            .background {
                RoundedRectangle(cornerRadius: metrics.radius(kind == .add ? .md : .sm))
                    .fill(theme[kind == .segment ? .bgElevated : kind == .agent && selected ? .panel : .panelHover])
                    .opacity(kind == .scope || kind == .add ? 0 : selected || hovering && kind != .segment ? 1 : 0)
            }
            .overlay {
                if kind == .agent || kind == .add {
                    RoundedRectangle(cornerRadius: metrics.radius(kind == .add ? .md : .sm))
                        .strokeBorder(theme[kind == .add && hovering ? .accent : .borderStrong],
                                      style: StrokeStyle(lineWidth: metrics.size(1),
                                                         dash: kind == .add ? [metrics.size(3)] : []))
                        .opacity(kind == .add || selected ? 1 : 0)
                }
            }
            .opacity(!enabled ? (kind == .scope ? 0.4 : 0.55) : kind == .agent && !selected ? hovering ? 0.8 : 0.45 : 1)
            .contentShape(Rectangle())
            .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
            .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: selected)
            .onHover { hovering = $0 && enabled }
    }
}

/// Web inputs draw focus on their container rather than using AppKit's rounded field bezel.
public struct AletheSidebarFieldBorder: ViewModifier {
    let focused: Bool
    let composer: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    public init(focused: Bool, composer: Bool = false) {
        self.focused = focused
        self.composer = composer
    }

    public func body(content: Content) -> some View {
        content
            .background(theme[.bgSunken].opacity(!composer || focused ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay {
                RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[focused ? composer ? .fgFaint : .accent : composer ? .borderStrong : .border],
                                  style: StrokeStyle(lineWidth: metrics.size(1),
                                                     dash: composer && !focused ? [metrics.size(3)] : []))
            }
            .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: focused)
    }
}

public extension Motion {
    static func sidebarEntrance(duration: Double, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: duration)
    }
}

/// TodoSidebar.module.css: entrance offsets affect drawing, never the zoomed hit targets.
public struct AletheSidebarWebEntrance: ViewModifier {
    public enum Part { case sidebar, header, composer, content }
    let part: Part
    @Environment(\.metrics) private var metrics
    @State private var shown = false

    public init(_ part: Part) { self.part = part }

    private var duration: Double {
        switch part {
        case .sidebar: 0.26
        case .header: 0.24
        case .composer: 0.28
        case .content: 0.3
        }
    }

    public func body(content: Content) -> some View {
        content.opacity(shown || metrics.reducesMotion || metrics.style == .clean ? 1 : 0)
            .offset(x: !shown && !metrics.reducesMotion && metrics.style != .clean && part == .sidebar ? metrics.size(10) : 0,
                    y: !shown && !metrics.reducesMotion && metrics.style != .clean && part != .sidebar ? metrics.size(5) : 0)
            .onAppear {
                withAnimation(Motion.sidebarEntrance(duration: duration, reduceMotion: metrics.reducesMotion || metrics.style == .clean)) {
                    shown = true
                }
            }
    }
}

/// Unselected utility buttons have per-panel disabled colors/opacities in the web CSS.
public struct AletheSidebarUtilityStyle: ButtonStyle {
    let width: CGFloat
    let height: CGFloat
    let disabledOpacity: Double
    let faintWhenDisabled: Bool

    public init(width: CGFloat = 26, height: CGFloat = 26, disabledOpacity: Double = 0.6,
                faintWhenDisabled: Bool = false) {
        self.width = width; self.height = height
        self.disabledOpacity = disabledOpacity; self.faintWhenDisabled = faintWhenDisabled
    }

    public func makeBody(configuration: Configuration) -> some View {
        SidebarUtilityBody(label: configuration.label, width: width, height: height,
                           disabledOpacity: disabledOpacity, faintWhenDisabled: faintWhenDisabled)
    }
}

private struct SidebarUtilityBody<Content: View>: View {
    let label: Content
    let width: CGFloat
    let height: CGFloat
    let disabledOpacity: Double
    let faintWhenDisabled: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        label.labelStyle(.iconOnly)
            .foregroundStyle(theme[!enabled && faintWhenDisabled ? .fgFaint : hovering ? .fg : .fgMuted])
            .frame(width: metrics.size(width), height: metrics.size(height))
            .background(theme[.panelHover].opacity(hovering && enabled ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .contentShape(Rectangle()).opacity(enabled ? 1 : disabledOpacity)
            .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
            .onHover { hovering = $0 && enabled }
    }
}
