import AletheDesign
import AppKit
import SwiftUI

// src/App.module.css: panel layout and sidebar content transform.
extension Motion {
    static func webShellCurve(duration: Double, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: duration)
    }

    static func webShellEase(duration: Double, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.25, 0.1, 0.25, 1, duration: duration)
    }
}

/// Keep sidebar state and its full content width while the outer layout collapses.
struct WebShellPanel<Content: View>: View {
    let visible: Bool
    let width: CGFloat
    var trailing = false
    @ViewBuilder var content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        content()
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(theme[.bg])
            .opacity(visible ? 1 : 0)
            .animation(Motion.webShellEase(duration: 0.22, reduceMotion: metrics.reducesMotion), value: visible)
            // This scale is the CSS collapse transform, independent of interface zoom.
            .scaleEffect(visible ? 1 : 0.985)
            .offset(x: visible ? 0 : metrics.size(trailing ? 16 : -16))
            .animation(Motion.webShellCurve(duration: 0.28, reduceMotion: metrics.reducesMotion), value: visible)
            .frame(width: visible ? width : 0, alignment: trailing ? .trailing : .leading)
            .clipped()
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
    }
}

/// A one-point divider with the web's 19-point hit region and centered hover grip.
struct WebShellSeparator: View {
    @Binding var width: Double
    let limits: ClosedRange<Double>
    var trailing = false
    var visible = true
    @Binding var dragging: Bool
    @GestureState private var gestureActive = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    @State private var initialWidth: Double?

    var body: some View {
        theme[hovering || initialWidth != nil ? .borderStrong : .border]
            .animation(Motion.webShellEase(duration: 0.12, reduceMotion: metrics.reducesMotion),
                       value: hovering || initialWidth != nil)
            .frame(width: visible ? metrics.size(1) : 0)
            .overlay {
                RoundedRectangle(cornerRadius: metrics.size(999))
                    .fill(theme[.borderStrong])
                    .frame(width: metrics.size(3), height: metrics.size(30))
                    .opacity(hovering || initialWidth != nil ? 1 : 0)
            }
            .overlay {
                Color.clear
                    .frame(width: metrics.size(19))
                    .contentShape(Rectangle())
                    .onHover { inside in
                        hovering = inside
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                        .updating($gestureActive) { _, active, _ in active = true }
                        .onChanged { value in
                            if initialWidth == nil { initialWidth = width }
                            dragging = true
                            let delta = value.translation.width / metrics.scale * (trailing ? -1 : 1)
                            width = min(limits.upperBound, max(limits.lowerBound, (initialWidth ?? width) + delta))
                        }
                        .onEnded { _ in
                            initialWidth = nil
                            dragging = false
                        })
            }
            .opacity(visible ? 1 : 0)
            .animation(Motion.webShellEase(duration: 0.16, reduceMotion: metrics.reducesMotion), value: visible)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
            .onChange(of: gestureActive) { _, active in
                if !active {
                    initialWidth = nil
                    dragging = false
                }
            }
            .accessibilityLabel(Text(trailing ? "chrome.resizeRightSidebar" : "chrome.resizeLeftSidebar"))
            .accessibilityAdjustableAction { direction in
                width = min(limits.upperBound, max(limits.lowerBound, width + (direction == .increment ? 10 : -10)))
            }
    }
}
