import AppKit
import SwiftUI

extension Notification.Name {
    static let aletheToggleWebSidebar = Notification.Name("alethe.toggleWebSidebar")
}

/// Changes the existing window in place, so Interface settings apply without relaunching.
struct WindowChromeBridge: NSViewRepresentable {
    let web: Bool
    let barHeight: CGFloat
    @Binding var trafficLightTrailingEdge: CGFloat

    func makeNSView(context: Context) -> ChromeView { ChromeView() }

    func updateNSView(_ view: ChromeView, context: Context) {
        let trailingEdgeBinding = $trafficLightTrailingEdge
        view.trafficLightTrailingEdgeChanged = { value in
            // AppKit can notify during a SwiftUI update; publish on the next main turn.
            Task { @MainActor in
                if trailingEdgeBinding.wrappedValue != value { trailingEdgeBinding.wrappedValue = value }
            }
        }
        view.web = web
        view.barHeight = barHeight
        view.apply()
    }

    final class ChromeView: NSView {
        var web = false
        var barHeight: CGFloat = 40
        var trafficLightTrailingEdgeChanged: (@MainActor (CGFloat) -> Void)?
        private var previousTrailingEdge: CGFloat?
        private var hiddenBeforeFullScreen: [NSWindow.ButtonType: Bool] = [:]
        private var previousFullScreen: Bool?
        private var previousWeb: Bool?
        private var savedToolbar: NSToolbar?
        private var savedTitleVisibility: NSWindow.TitleVisibility = .visible
        private var savedTransparent = false
        private var savedFullSize = false
        private var savedLightFrames: [NSWindow.ButtonType: NSRect] = [:]
        private final class LightHost {
            weak var view: NSView?
            init(_ view: NSView?) { self.view = view }
        }
        private var savedLightHosts: [NSWindow.ButtonType: LightHost] = [:]
        private var savedLightVisibility: [NSWindow.ButtonType: Bool] = [:]
        private weak var observedWindow: NSWindow?

        override var isFlipped: Bool { true }

        // This overlay owns only the standard buttons; all other events reach SwiftUI below it.
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard web else { return nil }
            let hit = super.hitTest(point)
            return hit === self ? nil : hit
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if observedWindow !== window {
                NotificationCenter.default.removeObserver(self)
                observedWindow = window
                if let window {
                    for name in [NSWindow.didResizeNotification, NSWindow.didEnterFullScreenNotification,
                                 NSWindow.didExitFullScreenNotification, NSWindow.didUpdateNotification] {
                        NotificationCenter.default.addObserver(self, selector: #selector(windowChanged(_:)),
                                                               name: name, object: window)
                    }
                }
            }
            apply()
        }

        override func layout() {
            super.layout()
            positionLights()
        }

        @objc private func windowChanged(_ notification: Notification) {
            positionLights()
        }

        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            positionLights()
        }

        func apply() {
            guard let window else { return }
            if previousWeb != web {
                if web {
                    savedToolbar = window.toolbar
                    for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                        if let button = window.standardWindowButton(kind) {
                            savedLightFrames[kind] = button.frame
                            savedLightHosts[kind] = LightHost(button.superview)
                            savedLightVisibility[kind] = button.isHidden
                        }
                    }
                    savedTitleVisibility = window.titleVisibility
                    savedTransparent = window.titlebarAppearsTransparent
                    savedFullSize = window.styleMask.contains(.fullSizeContentView)
                    window.toolbar = nil
                    window.isMovableByWindowBackground = false
                    window.titleVisibility = .hidden
                    window.titlebarAppearsTransparent = true
                    window.styleMask.insert(.fullSizeContentView)
                } else if previousWeb != nil {
                    window.titleVisibility = savedTitleVisibility
                    window.titlebarAppearsTransparent = savedTransparent
                    if !savedFullSize { window.styleMask.remove(.fullSizeContentView) }
                    if window.toolbar == nil { window.toolbar = savedToolbar }
                    for (kind, frame) in savedLightFrames {
                        guard let button = window.standardWindowButton(kind) else { continue }
                        savedLightHosts[kind]?.view?.addSubview(button)
                        button.frame = frame
                        button.isHidden = savedLightVisibility[kind] ?? false
                    }
                    savedLightHosts.removeAll()
                    savedLightFrames.removeAll()
                    savedLightVisibility.removeAll()
                    hiddenBeforeFullScreen.removeAll()
                    previousFullScreen = nil
                }
                previousWeb = web
            }
            positionLights()
        }

        private func positionLights() {
            guard web, let window else { return }
            let fullScreen = window.styleMask.contains(.fullScreen)
            let fullScreenChanged = previousFullScreen != fullScreen
            defer { previousFullScreen = fullScreen }
            var trailingEdge: CGFloat = 0
            for (index, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
                guard let button = window.standardWindowButton(kind) else { continue }
                // SwiftUI hides the system title-bar host when its toolbar is hidden. Keep the
                // real buttons in our overlay so their target/actions and accessibility survive.
                if fullScreen {
                    // Give the buttons back to the system title bar so the menu-bar reveal still
                    // shows them (exit full screen, minimize); our overlay would hide them.
                    if let host = savedLightHosts[kind]?.view, button.superview !== host {
                        host.addSubview(button)
                        if let frame = savedLightFrames[kind] { button.frame = frame }
                    }
                    button.isHidden = savedLightVisibility[kind] ?? false
                    continue
                }
                if button.superview !== self { addSubview(button) }
                if fullScreenChanged, previousFullScreen == true {
                    button.isHidden = savedLightVisibility[kind] ?? false
                }
                let scale = barHeight / 40
                let origin = NSPoint(x: (12 + CGFloat(index) * 20) * scale,
                                     y: (barHeight - button.frame.height) / 2)
                if button.frame.origin != origin { button.setFrameOrigin(origin) }
                if !button.isHiddenOrHasHiddenAncestor, button.alphaValue > 0 {
                    trailingEdge = max(trailingEdge, button.frame.maxX)
                }
            }
            // Reserve only the actual visible buttons, never a nominal traffic-light width.
            if previousTrailingEdge != trailingEdge {
                previousTrailingEdge = trailingEdge
                trafficLightTrailingEdgeChanged?(trailingEdge)
            }
        }
    }
}

/// Only unhandled mouse events reach this background; buttons and tabs keep their own events.
struct WindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ view: DragView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                window?.performZoom(nil)
            } else {
                window?.performDrag(with: event)
            }
        }
    }
}
