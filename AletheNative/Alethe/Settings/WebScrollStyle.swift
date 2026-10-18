import AletheDesign
import AppKit
import SwiftUI

extension View {
    /// Applies only to the web interface; the native scroller preferences remain untouched.
    func webScrollStyle() -> some View { modifier(WebScrollStyle()) }
}

private struct WebScrollStyle: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.background(WebScrollProbe(tint: NSColor(theme[.fgMuted]), scale: metrics.scale))
        } else {
            content
        }
    }
}

/// reset.css: a transparent 10px track, 2px thumb inset, and 18/35/55% muted ink.
@MainActor
enum WebScrollConfigurator {
    static func configure(_ scroll: NSScrollView, tint: NSColor, scale: CGFloat) {
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        for horizontal in [false, true] {
            let current = horizontal ? scroll.horizontalScroller : scroll.verticalScroller
            guard let current else { continue }
            let scroller: WebPreferencesScroller
            if let existing = current as? WebPreferencesScroller {
                scroller = existing
            } else {
                scroller = WebPreferencesScroller(frame: current.frame)
                scroller.target = current.target
                scroller.action = current.action
                scroller.controlSize = .small
                scroller.scrollerStyle = .overlay
                if horizontal { scroll.horizontalScroller = scroller } else { scroll.verticalScroller = scroller }
            }
            scroller.ink = tint
            scroller.zoom = scale
            scroller.needsDisplay = true
        }
    }
}

private struct WebScrollProbe: NSViewRepresentable {
    let tint: NSColor
    let scale: CGFloat

    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {
        view.tint = tint
        view.scale = scale
        view.needsLayout = true
    }

    final class Probe: NSView {
        var tint: NSColor?
        var scale: CGFloat = 1

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            needsLayout = true
        }

        override func layout() {
            super.layout()
            // The probe is a background sibling of SwiftUI's scroll host. Search its containing
            // Settings subtree, including nested Lists, after AppKit has installed the hosts.
            var ancestor: NSView? = superview
            while let root = ancestor {
                let scrolls = descendants(root)
                if !scrolls.isEmpty {
                    for scroll in scrolls { if let tint { WebScrollConfigurator.configure(scroll, tint: tint, scale: scale) } }
                    break
                }
                ancestor = root.superview
            }
        }

        private func descendants(_ root: NSView) -> [NSScrollView] {
            var result = (root as? NSScrollView).map { [$0] } ?? []
            for child in root.subviews { result.append(contentsOf: descendants(child)) }
            return result
        }
    }
}

@MainActor
private final class WebPreferencesScroller: NSScroller {
    var ink: NSColor?
    var zoom: CGFloat = 1
    private var hovering = false
    private var tracking: NSTrackingArea?

    override class var isCompatibleWithOverlayScrollers: Bool { true }

    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override func drawKnob() {
        guard let ink else { return }
        var knob = rect(for: .knob)
        let horizontal = bounds.width > bounds.height
        let thickness = min(horizontal ? knob.height : knob.width, 6 * zoom)
        if horizontal {
            knob.origin.y = bounds.midY - thickness / 2
            knob.size.height = thickness
        } else {
            knob.origin.x = bounds.midX - thickness / 2
            knob.size.width = thickness
        }
        ink.withAlphaComponent(hitPart == .knob ? 0.55 : hovering ? 0.35 : 0.18).setFill()
        NSBezierPath(roundedRect: knob, xRadius: thickness / 2, yRadius: thickness / 2).fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
}
