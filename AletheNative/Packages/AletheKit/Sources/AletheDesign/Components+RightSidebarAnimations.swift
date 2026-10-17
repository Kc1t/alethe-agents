import SwiftUI

/// CSS timings shared by the right sidebar; native spring behavior is unchanged.
public extension Motion {
    // src/styles/reset.css: CSS `ease` is cubic-bezier(.25, .1, .25, 1).
    static func sidebarColor(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.25, 0.1, 0.25, 1, duration: 0.14)
    }

    static func sidebarOpacity(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.25, 0.1, 0.25, 1, duration: 0.12)
    }

    // TodoSidebar.module.css: sectionChevron.
    static func sidebarChevron(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.16)
    }

    // TodoSidebar.module.css: todoRow transform.
    static func sidebarDrag(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.18)
    }

    // DotmCircular2.module.css: steps(12, end) applies between each pair of keyframes.
    static let sidebarDotPeriod = 1.8 / 1.2
    static func sidebarDotAppearance(elapsed: Double, order: Int) -> (opacity: Double, size: CGFloat) {
        let phase = (max(0, elapsed) + Double(order) * 0.05 / 1.2)
            .truncatingRemainder(dividingBy: sidebarDotPeriod) / sidebarDotPeriod
        let opacity = sidebarSteppedValue(phase, stops: [
            (0, 0.95), (0.08333, 0.95), (0.16666, 0.4), (0.25, 0.4),
            (0.25001, 0.08), (0.33333, 0.08), (0.33334, 0.95), (0.41666, 0.95),
            (0.5, 0.4), (0.58333, 0.4), (0.58334, 0.08), (0.66666, 0.08),
            (0.66667, 0.95), (0.75, 0.95), (0.83333, 0.4), (0.91666, 0.4),
            (0.91667, 0.08), (1, 0.08)
        ])
        let scale = sidebarSteppedValue(phase, stops: [
            (0, 1.12), (0.08333, 1.12), (0.16666, 1), (0.25, 1),
            (0.33334, 1.12), (0.41666, 1.12), (0.5, 1), (0.58333, 1),
            (0.66667, 1.12), (0.75, 1.12), (0.83333, 1), (0.91666, 1), (1, 1)
        ])
        return (opacity, CGFloat(2 * scale))
    }

    private static func sidebarSteppedValue(_ phase: Double, stops: [(Double, Double)]) -> Double {
        for index in 1..<stops.count where phase <= stops[index].0 {
            let (start, from) = stops[index - 1]
            let (end, to) = stops[index]
            let step = floor((phase - start) / (end - start) * 12) / 12
            return from + (to - from) * step
        }
        return stops.last?.1 ?? 0
    }

    enum SidebarSpinner: Sendable {
        case mcp, pullRequests
        public var period: Double {
            switch self {
            case .mcp: 0.9 // McpPanel.module.css: mcpSpin
            case .pullRequests: 1 // PullRequestsSidebar.module.css: prSpin
            }
        }
    }
}

/// Absolute phase avoids repeatForever state leaking across refreshes or Reduce Motion changes.
public struct AletheSidebarSpinner: ViewModifier {
    let active: Bool
    let kind: Motion.SidebarSpinner
    @Environment(\.metrics) private var metrics
    @State private var started = Date.now

    public init(active: Bool, kind: Motion.SidebarSpinner) {
        self.active = active
        self.kind = kind
    }

    public func body(content: Content) -> some View {
        TimelineView(.animation(paused: !active || metrics.reducesMotion)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(started))
            content.rotationEffect(.degrees(active && !metrics.reducesMotion
                ? elapsed.truncatingRemainder(dividingBy: kind.period) / kind.period * 360 : 0))
        }
        .onChange(of: active) { _, _ in started = .now }
        .onChange(of: metrics.reducesMotion) { _, _ in started = .now }
    }
}

/// Preserves the shared tab control's geometry, adding only web CSS color transitions.
public struct AletheAnimatedRightSidebarTabStyle: ButtonStyle {
    public var selected: Bool
    public var width: CGFloat
    public var height: CGFloat
    public init(selected: Bool = false, width: CGFloat = 28, height: CGFloat = 26) {
        self.selected = selected
        self.width = width
        self.height = height
    }
    @Environment(\.metrics) private var metrics
    @ViewBuilder public func makeBody(configuration: Configuration) -> some View {
        if metrics.isWebInterface {
            AnimatedRightSidebarTabBody(configuration: configuration, selected: selected, width: width, height: height)
        } else {
            AletheRightSidebarTabStyle(selected: selected, width: width, height: height)
                .makeBody(configuration: configuration)
        }
    }
}

private struct AnimatedRightSidebarTabBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let width: CGFloat
    let height: CGFloat
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 14))
            .foregroundStyle(theme[selected || hovering ? .fg : .fgMuted])
            .frame(width: metrics.size(width), height: metrics.size(height))
            .background(
                theme[selected ? .panel : .panelHover].opacity(selected || hovering ? 1 : 0),
                in: RoundedRectangle(cornerRadius: metrics.radius(.sm))
            )
            .overlay {
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.borderStrong].opacity(selected ? 1 : 0), lineWidth: metrics.size(1))
            }
            .shadow(
                color: theme[.bgSunken].opacity(selected ? 0.25 : 0),
                radius: metrics.size(2), y: metrics.size(1)
            )
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.5)
            .animation(metrics.isWebInterface ? Motion.sidebarColor(reduceMotion: metrics.reducesMotion) : nil, value: hovering)
            .animation(metrics.isWebInterface ? Motion.sidebarColor(reduceMotion: metrics.reducesMotion) : nil, value: selected)
            .animation(metrics.isWebInterface ? Motion.sidebarOpacity(reduceMotion: metrics.reducesMotion) : nil, value: enabled)
            .onHover { hovering = $0 }
    }
}

/// RightSidebar/index.tsx and ui/DotmCircular2.module.css: 13-point GSD busy indicator.
public struct AletheSidebarBusyMatrix: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var started = Date.now
    private let ring = [1, 2, 3, 9, 14, 19, 23, 22, 21, 15, 10, 5]

    public init() {}

    public var body: some View {
        TimelineView(.animation(paused: metrics.reducesMotion)) { context in
            let elapsed = context.date.timeIntervalSince(started)
            ZStack {
                ForEach(0..<25, id: \.self) { index in
                    let row = index / 5
                    let column = index % 5
                    if !((row == 0 || row == 4) && (column == 0 || column == 4)) {
                        let order = ring.firstIndex(of: index)
                        let appearance = order.map { order in
                            metrics.reducesMotion ? (opacity: 0.4, size: CGFloat(2))
                                : Motion.sidebarDotAppearance(elapsed: elapsed, order: order)
                        } ?? (opacity: index == 12 ? 0.4 : 0.08, size: CGFloat(2))
                        Circle().fill(theme[.statusWorking])
                            .frame(width: metrics.size(appearance.size), height: metrics.size(appearance.size))
                            .opacity(appearance.opacity)
                            .offset(x: metrics.size(CGFloat(column - 2) * 2.8), y: metrics.size(CGFloat(row - 2) * 2.8))
                    }
                }
            }
            .frame(width: metrics.size(13), height: metrics.size(13))
            .shadow(color: theme[.statusWorking], radius: metrics.size(2))
        }
    }
}

/// TodoSidebar's section toggle; content is conditional in the web source (no height tween).
public struct AletheSidebarTodoSection<Content: View>: View {
    let title: Text
    let count: Int
    let content: Content
    @State private var collapsed = false
    @State private var hovering = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    public init(title: Text, count: Int, @ViewBuilder content: () -> Content) {
        self.title = title
        self.count = count
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: metrics.size(2)) {
            Button { collapsed.toggle() } label: {
                HStack(spacing: metrics.size(7)) {
                    Image(systemName: "chevron.down")
                        .resizable().scaledToFit()
                        .frame(width: metrics.size(13), height: metrics.size(13))
                        .rotationEffect(.degrees(collapsed ? -90 : 0))
                        .animation(Motion.sidebarChevron(reduceMotion: metrics.reducesMotion), value: collapsed)
                    title.font(metrics.font(size: 11, weight: .medium)).lineLimit(1)
                    Text(verbatim: String(count))
                        .font(metrics.font(size: 9))
                        .padding(.horizontal, metrics.size(5))
                        .frame(minWidth: metrics.size(18), minHeight: metrics.size(16))
                        .background(theme[.bgElevated], in: Capsule())
                    Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
                }
                .foregroundStyle(theme[hovering ? .fgMuted : .fgFaint])
                .padding(.horizontal, metrics.size(5))
                .frame(height: metrics.size(26))
                .background(theme[.panelHover].opacity(hovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .contentShape(Rectangle())
                .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .accessibilityLabel(title)
            .accessibilityValue(Text(verbatim: String(count)))
            if !collapsed { content.transition(.identity) }
        }
    }
}

/// Drop feedback is an overlay, so it cannot change row or scroll geometry.
public struct AletheSidebarDropIndicator: ViewModifier {
    let targeted: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    public init(targeted: Bool) { self.targeted = targeted }
    public func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.overlay(alignment: .top) {
                Rectangle().fill(theme[.accent]).frame(height: metrics.size(2))
                    .opacity(targeted ? 1 : 0).allowsHitTesting(false).accessibilityHidden(true)
            }
            .offset(y: targeted ? metrics.size(-1) : 0)
            .animation(Motion.sidebarDrag(reduceMotion: metrics.reducesMotion), value: targeted)
        } else { content }
    }
}

/// TodoSidebar.module.css: reserve the row's geometry while the hover fill fades.
public struct AletheSidebarRowHover: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false
    public init() {}
    public func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .background(theme[.panelHover].opacity(hovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
                .onHover { hovering = $0 }
        } else { content }
    }
}
