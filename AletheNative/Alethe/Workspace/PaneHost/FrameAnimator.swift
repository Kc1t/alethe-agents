import AletheDesign
import AppKit
import QuartzCore

/// Moves views to new frames along a critically damped spring (`Motion.standard`), driven by the
/// host's display link. Retargeting mid-flight starts from where the view is drawn, so motion is
/// interruptible. Reduce Motion (or `animated: false`) jumps straight to the frame.
@MainActor
final class FrameAnimator {
    private struct Item {
        weak var view: NSView?
        var from: CGRect
        var to: CGRect
        var start: CFTimeInterval
    }

    private unowned let host: NSView
    private var items: [ObjectIdentifier: Item] = [:]
    private var link: CADisplayLink?
    private let spring = Motion.standard
    /// Reduced motion (preference or macOS setting): frames change without animation. Set by the
    /// pane host from its metrics.
    static var reducesMotion = false

    init(host: NSView) {
        self.host = host
    }

    func set(_ view: NSView, frame: CGRect, animated: Bool) {
        let key = ObjectIdentifier(view)
        if !Self.reducesMotion, let item = items[key], item.to == frame { return }
        if !animated || Self.reducesMotion || view.frame == .zero {
            items.removeValue(forKey: key)
            if view.frame != frame { view.frame = frame }
            return
        }
        guard view.frame != frame else {
            items.removeValue(forKey: key)
            return
        }
        items[key] = Item(view: view, from: view.frame, to: frame, start: CACurrentMediaTime())
        startLink()
    }

    /// Where `view` is headed (its final frame), even while it is still moving.
    func target(of view: NSView) -> CGRect {
        items[ObjectIdentifier(view)]?.to ?? view.frame
    }

    private func startLink() {
        guard link == nil else { return }
        let link = host.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        let omega = 2 * Double.pi / spring.response
        for (key, item) in items {
            guard let view = item.view else {
                items.removeValue(forKey: key)
                continue
            }
            let t = now - item.start
            // Critically damped, starting at rest: remaining = (1 + ωt)·e^(−ωt).
            let remaining = CGFloat((1 + omega * t) * exp(-omega * t))
            if remaining < 0.002 {
                view.frame = item.to
                items.removeValue(forKey: key)
                continue
            }
            view.frame = CGRect(
                x: item.to.minX + (item.from.minX - item.to.minX) * remaining,
                y: item.to.minY + (item.from.minY - item.to.minY) * remaining,
                width: item.to.width + (item.from.width - item.to.width) * remaining,
                height: item.to.height + (item.from.height - item.to.height) * remaining
            )
        }
        if items.isEmpty {
            link.invalidate()
            self.link = nil
        }
    }
}
