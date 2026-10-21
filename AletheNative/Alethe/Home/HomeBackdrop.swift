import AletheDesign
import AppKit
import SwiftUI

/// HomeView.module.css and AsciiEffect: cover fit, theme ink, flow and a fading lower edge.
struct HomeBackdrop: View {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.scenePhase) private var scenePhase
    @State private var sample = Sample()
    @State private var pointer: CGPoint?

    private struct Sample {
        var columns = 0
        var rows = 0
        var values: [Double] = []
    }

    private struct SampleKey: Hashable {
        let size: CGSize
        let scale: CGFloat
    }

    // AsciiEffect uses the width of Arial's M, with an eight-pixel line height.
    private var cellWidth: CGFloat {
        ("M" as NSString).size(withAttributes: [.font: NSFont(name: "Arial", size: metrics.size(8))
                                              ?? NSFont.systemFont(ofSize: metrics.size(8))]).width
    }

    var body: some View {
        GeometryReader { geometry in
            // Every frame redraws ~26k glyphs on the main thread; 30 fps kept it busy enough to starve event handling in a
            // large window, so the ambient flow runs at 10 fps.
            TimelineView(.animation(minimumInterval: 1.0 / 10, paused: metrics.reducesMotion || scenePhase != .active)) { timeline in
                Canvas { context, _ in
                    draw(in: context, size: geometry.size,
                         time: metrics.reducesMotion ? nil : timeline.date.timeIntervalSinceReferenceDate * 1_000)
                }
            }
            .task(id: SampleKey(size: geometry.size, scale: metrics.scale)) {
                sample = sampleImage(size: geometry.size)
            }
            .onContinuousHover { phase in
                switch phase {
                case .active(let location): pointer = location
                case .ended: pointer = nil
                }
            }
        }
        .clipped()
        .accessibilityHidden(true)
    }

    private func draw(in context: GraphicsContext, size: CGSize, time: Double?) {
        guard sample.columns > 0, sample.rows > 0 else { return }
        let ramp = Array(" .:-=+*#%@")
        let muted = theme.nsColor(.fgMuted).usingColorSpace(.deviceRGB) ?? theme.nsColor(.fgMuted)
        let foreground = theme.nsColor(.fg).usingColorSpace(.deviceRGB) ?? theme.nsColor(.fg)
        // Resolve glyphs once per ink level, rather than measuring text for every cell.
        let glyphs = (0..<32).map { level in
            let mix = Double(level) / 31
            let ink = muted.blended(withFraction: mix, of: foreground) ?? foreground
            return context.resolve(Text(verbatim: String(ramp[min(9, Int(mix * 9))]))
                .font(metrics.font(size: 8)).foregroundStyle(Color(nsColor: ink)))
        }
        let width = cellWidth
        let height = metrics.size(8)
        let opacity = size.width <= metrics.size(900) ? 0.84 : 0.9
        for row in 0..<sample.rows {
            let y = CGFloat(row) * height
            var line = context
            // CSS mask: opaque through 70%, then fade; the bg overlay removes 32% of ink.
            line.opacity = opacity * 0.68 * min(1, max(0, (1 - y / size.height) / 0.3))
            for column in 0..<sample.columns {
                let x = CGFloat(column) * width
                var sourceColumn = Double(column)
                var sourceRow = Double(row)
                if let time {
                    let phase = x / metrics.scale * 0.018 + time * 0.16 * .pi * 0.002
                    sourceColumn -= sin(phase) * metrics.size(9) / width
                    if let pointer {
                        let mouseX = x - pointer.x
                        let mouseY = y - pointer.y
                        let distance = hypot(mouseX, mouseY)
                        let influence = max(0, 1 - distance / metrics.size(260))
                        if distance > 0, influence > 0 {
                            let ripple = sin(distance / metrics.scale * 0.055 - time * 1.2 * .pi * 0.002)
                            let force = influence * influence * metrics.size(16) * ripple
                            sourceColumn -= mouseX / distance * force / width
                            sourceRow -= mouseY / distance * force / height
                        }
                    }
                }
                let sampledColumn = min(sample.columns - 1, max(0, Int(sourceColumn.rounded())))
                let sampledRow = min(sample.rows - 1, max(0, Int(sourceRow.rounded())))
                let value = sample.values[sampledRow * sample.columns + sampledColumn]
                guard Int(value * 9) > 0 else { continue }
                line.draw(glyphs[min(31, max(0, Int((value * 31).rounded())))],
                          at: CGPoint(x: x - width, y: y - height), anchor: .topLeading)
            }
        }
    }

    private func sampleImage(size: CGSize) -> Sample {
        guard size.width > 0, size.height > 0,
              let source = NSImage(named: "HomeBackdrop")?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else { return Sample() }
        let columns = Int(ceil(size.width / cellWidth)) + 2
        let rows = Int(ceil(size.height / metrics.size(8))) + 2
        guard let bitmap = CGContext(data: nil, width: columns, height: rows, bitsPerComponent: 8,
                                     bytesPerRow: columns * 4, space: CGColorSpaceCreateDeviceRGB(),
                                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = bitmap.data else { return Sample() }
        let cover = max(size.width / CGFloat(source.width), size.height / CGFloat(source.height))
        let width = CGFloat(source.width) * cover / cellWidth
        let height = CGFloat(source.height) * cover / metrics.size(8)
        bitmap.draw(source, in: CGRect(x: (CGFloat(columns) - width) / 2,
                                      y: (CGFloat(rows) - height) / 2, width: width, height: height))
        let pixels = data.bindMemory(to: UInt8.self, capacity: columns * rows * 4)
        let values = (0..<(columns * rows)).map { cell -> Double in
            let row = cell / columns
            let column = cell % columns
            let index = (row * columns + column) * 4
            let alpha = Double(pixels[index + 3]) / 255
            guard alpha > 0 else { return 0 }
            // CGContext stores premultiplied channels; undo that before applying web contrast.
            let luminance = (Double(pixels[index]) * 0.2126 + Double(pixels[index + 1]) * 0.7152
                             + Double(pixels[index + 2]) * 0.0722) / (255 * alpha)
            let contrasted = min(1, max(0, (luminance - 0.5) * 1.15 + 0.5))
            let boosted = min(1, contrasted * 2.25 * alpha)
            let value = boosted <= 0.02 ? 0 : (boosted - 0.02) / 0.98
            let quantized = (value * 31).rounded() / 31
            return value + (quantized - value) * 0.8
        }
        return Sample(columns: columns, rows: rows, values: values)
    }
}
