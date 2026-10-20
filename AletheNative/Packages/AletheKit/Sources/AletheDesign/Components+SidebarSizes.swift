import SwiftUI

/// Clean's final layout-button rules override the earlier 24 × 22 control.
public struct AletheSidebarSizeLayoutStyle: ButtonStyle {
    let isSelected: Bool
    @Environment(\.metrics) private var metrics

    public init(isSelected: Bool) { self.isSelected = isSelected }

    @ViewBuilder public func makeBody(configuration: Configuration) -> some View {
        if metrics.isWebInterface && metrics.style == .clean {
            SidebarSizeLayoutButton(configuration: configuration, isSelected: isSelected)
        } else {
            AletheSidebarMotionTabStyle(isSelected: isSelected, layout: true)
                .makeBody(configuration: configuration)
        }
    }
}

private struct SidebarSizeLayoutButton: View {
    let configuration: ButtonStyleConfiguration
    let isSelected: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 14))
            .foregroundStyle(theme[isSelected || hovering ? .fg : .fgMuted])
            .frame(width: metrics.size(24), height: metrics.size(24))
            .background(theme[.panelHover].opacity(isSelected ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.size(4)))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(Motion.SidebarEffect.layout.animation(reduceMotion: metrics.reducesMotion), value: hovering)
    }
}

/// Sidebar working indicators are 13 points in Clean and 14 in Normal.
public struct AletheSidebarSizeSpinner: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    public init() {}

    private var side: CGFloat { metrics.style == .clean ? 13 : 14 }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24, paused: metrics.reducesMotion)) { context in
            Canvas { canvas, _ in
                let ring = [1, 2, 3, 9, 14, 19, 23, 22, 21, 15, 10, 5]
                for index in 0..<25 {
                    let row = index / 5
                    let column = index % 5
                    if (row == 0 || row == 4) && (column == 0 || column == 4) { continue }
                    var alpha = index == 12 ? 0.4 : 0.08
                    var expansion = 1.0
                    if let order = ring.firstIndex(of: index) {
                        let phase = (context.date.timeIntervalSinceReferenceDate + Double(order) * 0.05 / 1.2)
                            .truncatingRemainder(dividingBy: 1.5) / 1.5
                        let step = Int(phase * 12) % 4
                        alpha = metrics.reducesMotion ? 0.4 : step == 0 ? 0.95 : step == 1 || step == 2 ? 0.4 : 0.08
                        expansion = !metrics.reducesMotion && step == 0 ? 1.12 : 1
                    }
                    let dot = metrics.size(2 * side / 14) * expansion
                    let centerX = metrics.size((1 + CGFloat(column) * 3) * side / 14)
                    let centerY = metrics.size((1 + CGFloat(row) * 3) * side / 14)
                    let rect = CGRect(x: centerX - dot / 2, y: centerY - dot / 2, width: dot, height: dot)
                    canvas.fill(Path(ellipseIn: rect), with: .color(theme[.statusWorking].opacity(alpha)))
                }
            }
            .frame(width: metrics.size(side), height: metrics.size(side))
            .shadow(color: theme[.statusWorking], radius: metrics.size(2))
        }
    }

}
