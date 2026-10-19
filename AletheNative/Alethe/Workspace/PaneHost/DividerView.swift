import AppKit
import AletheDesign
import QuartzCore

/// An invisible resize handle over the gap between two tracks. Reports the pointer's travel since
/// mouse-down; the owner turns it into track sizes.
final class DividerView: NSView {
    enum Axis { case vertical, horizontal }

    let axis: Axis
    var onDrag: ((CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    var onDoubleClick: ((CGPoint) -> Void)?
    private var start: CGPoint?
    private var hasDragged = false
    private var context: PaneHostContext?
    private var hovering = false
    private var tracking: NSTrackingArea?

    private var gridHandle = false
    private let hoverFill = CALayer()
    private let centerLine = CALayer()
    private let grip = CALayer()

    func configure(context: PaneHostContext?, gridHandle: Bool = false) {
        self.context = context
        self.gridHandle = gridHandle
        updateAppearance(animated: false)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
        window?.invalidateCursorRects(for: self)
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; updateAppearance(animated: true) }
    override func mouseExited(with event: NSEvent) { hovering = false; updateAppearance(animated: true) }

    override func layout() {
        super.layout()
        updateAppearance(animated: false)
    }

    private func updateAppearance(animated: Bool) {
        guard let context else { return }
        let m = context.metrics
        let active = hovering || start != nil
        CATransaction.begin()
        CATransaction.setDisableActions(!animated || m.reducesMotion)
        CATransaction.setAnimationDuration(0.12)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.25, 0.1, 0.25, 1))
        hoverFill.frame = bounds
        hoverFill.backgroundColor = context.theme.nsColor(.accentSoft).cgColor
        // Split separators highlight their background only on hover, including during a drag.
        hoverFill.opacity = m.isWebInterface && hovering && (gridHandle || m.style != .clean) ? 1 : 0
        centerLine.backgroundColor = context.theme.nsColor(.borderStrong).cgColor
        centerLine.cornerRadius = m.size(2)
        centerLine.opacity = m.isWebInterface && !gridHandle && m.style != .clean && !active ? 0.7 : 0
        grip.backgroundColor = context.theme.nsColor(.accent).cgColor
        grip.cornerRadius = m.size(3)
        grip.opacity = m.isWebInterface && (gridHandle ? hovering : active) ? 1 : 0
        let thickness = m.size(1), gripWidth = m.size(3), gripLength = m.size(36)
        if axis == .vertical {
            centerLine.frame = CGRect(x: (bounds.width - thickness) / 2, y: 0, width: thickness, height: bounds.height)
            grip.frame = CGRect(x: (bounds.width - gripWidth) / 2, y: (bounds.height - gripLength) / 2, width: gripWidth, height: gripLength)
        } else {
            centerLine.frame = CGRect(x: 0, y: (bounds.height - thickness) / 2, width: bounds.width, height: thickness)
            grip.frame = CGRect(x: (bounds.width - gripLength) / 2, y: (bounds.height - gripWidth) / 2, width: gripLength, height: gripWidth)
        }
        CATransaction.commit()
    }

    init(axis: Axis) {
        self.axis = axis
        super.init(frame: .zero)
        wantsLayer = true
        layer?.addSublayer(hoverFill)
        layer?.addSublayer(centerLine)
        layer?.addSublayer(grip)
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
        if context?.metrics.isWebInterface == true, event.clickCount == 2, let onDoubleClick {
            onDoubleClick(convert(event.locationInWindow, from: nil))
            return
        }
        hasDragged = false
        start = event.locationInWindow
        updateAppearance(animated: true)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        hasDragged = true
        let point = event.locationInWindow
        // Window coordinates grow upward; the host is flipped.
        onDrag?(axis == .vertical ? point.x - start.x : start.y - point.y)
    }

    override func mouseUp(with event: NSEvent) {
        guard start != nil else { return }
        start = nil
        updateAppearance(animated: true)
        if hasDragged || context?.metrics.isWebInterface != true { onEnd?() }
    }
}
