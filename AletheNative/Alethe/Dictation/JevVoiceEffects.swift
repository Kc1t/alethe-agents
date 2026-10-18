import AletheDesign
import SwiftUI

/// VoiceCommand.module.css timing and geometry, with solid theme colors instead of gradients.
struct JevVoiceEdge: View {
    let listening: Bool
    let processing: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: metrics.reducesMotion || !(listening || processing))) { timeline in
            Canvas { context, size in
                let time = metrics.reducesMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                let active = listening || processing
                let breath = (1 - cos(time / 1.8 * 2 * .pi)) / 2
                let height = metrics.size(2)
                let y = size.height - metrics.size(14) - height
                let width = max(0, size.width - metrics.size(36))
                let x = metrics.size(18)
                func bar(_ rect: CGRect, opacity: Double) {
                    context.fill(Path(roundedRect: rect, cornerRadius: height / 2),
                                 with: .color(theme[.accent].opacity(opacity)))
                }
                bar(CGRect(x: x, y: y, width: width, height: height), opacity: active ? 0.24 : 0.1)
                let glowWidth = width * 0.34 * (active ? 0.88 + breath * 0.16 : 1)
                bar(CGRect(x: x + (width - glowWidth) / 2, y: y, width: glowWidth, height: height),
                    opacity: active ? 0.72 + breath * 0.28 : 0.5)
                if active && !metrics.reducesMotion {
                    let scan = time.truncatingRemainder(dividingBy: processing ? 1.2 : 2.4) / (processing ? 1.2 : 2.4)
                    context.clip(to: Path(CGRect(x: x, y: y, width: width, height: height)))
                    bar(CGRect(x: x + width * (-0.32 + scan * 1.38), y: y, width: width * 0.2, height: height),
                        opacity: scan < 0.12 ? scan / 0.12 * 0.95 : (scan > 0.88 ? (1 - scan) / 0.12 * 0.8 : 0.95))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct JevVoiceBorder: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        GeometryReader { geometry in
            TimelineView(.animation(minimumInterval: 1 / 30, paused: metrics.reducesMotion)) { timeline in
                let perimeter = max(1, 2 * (geometry.size.width + geometry.size.height)
                                    - (8 - 2 * .pi) * metrics.size(32))
                let phase = metrics.reducesMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 6) / 6
                RoundedRectangle(cornerRadius: metrics.size(32))
                    .strokeBorder(theme[.accent].opacity(0.5), style: StrokeStyle(
                        lineWidth: metrics.size(1.25), lineCap: .round,
                        dash: [perimeter * 0.14, perimeter * 0.86], dashPhase: -perimeter * phase))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
