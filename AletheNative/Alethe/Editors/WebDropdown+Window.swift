import AppKit
import AletheDesign
import SwiftUI

/// A portal into the owning window, so choices are never clipped by a panel or scroll view.
struct WebDropdownPortal: NSViewRepresentable {
    let open: Bool
    let height: CGFloat
    let metrics: Metrics
    var minimumWidth: CGFloat = 220
    var maximumWidth: CGFloat = 320
    var gap: CGFloat = 5
    var rowSelect = false
    let content: AnyView
    let dismiss: (Bool) -> Void

    func makeNSView(context: Context) -> WebDropdownAnchor { WebDropdownAnchor() }
    func updateNSView(_ view: WebDropdownAnchor, context: Context) {
        view.dismiss = dismiss
        view.present(open: open, content: content, height: height, metrics: metrics, minimumWidth: minimumWidth, maximumWidth: maximumWidth, gap: gap, rowSelect: rowSelect)
    }
    static func dismantleNSView(_ view: WebDropdownAnchor, coordinator: ()) { view.close() }
}

@MainActor
final class WebDropdownAnchor: NSView {
    private var host: NSHostingView<AnyView>?
    private var monitor: Any?
    private var requestedHeight: CGFloat = 0
    private var metrics = Metrics()
    private var minimumWidth: CGFloat = 220
    private var maximumWidth: CGFloat = 320
    private var gap: CGFloat = 5
    private var rowSelect = false
    private weak var previousResponder: NSResponder?
    var dismiss: (Bool) -> Void = { _ in }

    override func layout() {
        super.layout()
        positionMenu()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { close() }
    }

    @objc private func viewportChanged(_ notification: Notification) { positionMenu() }

    func present(open: Bool, content: AnyView, height: CGFloat, metrics: Metrics, minimumWidth: CGFloat, maximumWidth: CGFloat, gap: CGFloat, rowSelect: Bool) {
        guard open else { close(); return }
        guard let container = window?.contentView else { return }
        requestedHeight = height
        self.metrics = metrics
        self.minimumWidth = minimumWidth
        self.maximumWidth = maximumWidth
        self.gap = gap
        self.rowSelect = rowSelect
        if let host { host.rootView = content } else {
            previousResponder = window?.firstResponder
            let hosted = NSHostingView(rootView: content)
            hosted.clipsToBounds = false
            hosted.sizingOptions = []
            host = hosted
            container.addSubview(hosted, positioned: .above, relativeTo: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(viewportChanged(_:)),
                name: NSView.boundsDidChangeNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(viewportChanged(_:)),
                name: NSWindow.didResizeNotification, object: window)
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
                guard let self, let window = self.window, event.window === window else { return event }
                if event.type == .keyDown {
                    if event.keyCode == 53 { self.dismiss(true); return nil }
                    if event.keyCode == 48 { self.dismiss(false) }
                } else if let host = self.host {
                    let point = event.locationInWindow
                    if !host.bounds.contains(host.convert(point, from: nil)),
                       !self.bounds.contains(self.convert(point, from: nil)) { self.dismiss(false) }
                }
                return event
            }
        }
        positionMenu()
    }

    private func positionMenu() {
        guard let host, let container = window?.contentView else { return }
        let rect = container.convert(convert(bounds, to: nil), from: nil)
        let viewport = container.bounds
        let top = container.isFlipped ? rect.minY : viewport.height - rect.maxY
        let bottom = top + rect.height
        let below = viewport.height - bottom - metrics.size(rowSelect ? 10 : 8)
        let above = top - metrics.size(rowSelect ? 10 : 8)
        let opensBelow = below >= min(requestedHeight, metrics.size(rowSelect ? 200 : 180)) || below >= above
        let height = min(requestedHeight, max(0, opensBelow ? below : above))
        let width = min(metrics.size(maximumWidth), max(metrics.size(minimumWidth), rect.width), max(0, viewport.width - metrics.size(16)))
        let left = max(metrics.size(8), min(rect.minX, viewport.width - width - metrics.size(8)))
        let menuTop = max(metrics.size(8), opensBelow ? bottom + metrics.size(gap) : top - height - metrics.size(gap))
        host.frame = CGRect(x: left, y: container.isFlipped ? menuTop : viewport.height - menuTop - height,
                            width: width, height: height)
    }

    func close() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        NotificationCenter.default.removeObserver(self)
        if let host, let responder = window?.firstResponder as? NSView, responder.isDescendant(of: host) {
            window?.makeFirstResponder(previousResponder)
        }
        host?.removeFromSuperview()
        host = nil
    }
}
