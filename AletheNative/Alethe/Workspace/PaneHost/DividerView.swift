import AppKit
import AletheDesign

/// An invisible resize handle over the gap between two tracks. Reports the pointer's travel since
/// mouse-down; the owner turns it into track sizes.
final class DividerView: NSView {
    enum Axis { case vertical, horizontal }

    let axis: Axis
    var onDrag: ((CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    private var start: CGPoint?
    private var context: PaneHostContext?
    private var hovering = false
    private var tracking: NSTrackingArea?

    func configure(context: PaneHostContext?) {
        self.context = context
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        guard let context, context.metrics.isWebInterface else { return }
        let active = hovering || start != nil
        if active && context.metrics.style != .clean { context.theme.nsColor(.accentSoft).setFill(); bounds.fill() }
        context.theme.nsColor(active ? .accent : .borderStrong).withAlphaComponent(active ? 1 : 0.7).setFill()
        if !active && context.metrics.style == .clean { return }
        let thickness = context.metrics.size(active ? 3 : 1)
        let length = active ? context.metrics.size(36) : (axis == .vertical ? bounds.height : bounds.width)
        let rect = axis == .vertical
            ? CGRect(x: (bounds.width - thickness) / 2, y: (bounds.height - length) / 2, width: thickness, height: length)
            : CGRect(x: (bounds.width - length) / 2, y: (bounds.height - thickness) / 2, width: length, height: thickness)
        NSBezierPath(roundedRect: rect, xRadius: context.metrics.size(active ? 3 : 2), yRadius: context.metrics.size(active ? 3 : 2)).fill()
    }

    init(axis: Axis) {
        self.axis = axis
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: axis == .vertical ? .resizeLeftRight : .resizeUpDown)
    }

    override func mouseDown(with event: NSEvent) {
        start = event.locationInWindow
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let point = event.locationInWindow
        // Window coordinates grow upward; the host is flipped.
        onDrag?(axis == .vertical ? point.x - start.x : start.y - point.y)
    }

    override func mouseUp(with event: NSEvent) {
        guard start != nil else { return }
        start = nil
        needsDisplay = true
        onEnd?()
    }
}
