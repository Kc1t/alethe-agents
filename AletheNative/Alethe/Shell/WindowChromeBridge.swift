import AppKit
import SwiftUI

extension Notification.Name {
    static let aletheToggleWebSidebar = Notification.Name("alethe.toggleWebSidebar")
}

/// Changes the existing window in place, so Interface settings apply without relaunching.
struct WindowChromeBridge: NSViewRepresentable {
    let web: Bool
    let barHeight: CGFloat

    func makeNSView(context: Context) -> ChromeView { ChromeView() }

    func updateNSView(_ view: ChromeView, context: Context) {
        view.web = web
        view.barHeight = barHeight
        view.apply()
    }

    final class ChromeView: NSView {
        var web = false
        var barHeight: CGFloat = 32
        private var previousWeb: Bool?
        private var savedToolbar: NSToolbar?
        private var savedTitleVisibility: NSWindow.TitleVisibility = .visible
        private var savedTransparent = false
        private var savedFullSize = false
        private var savedLightFrames: [NSWindow.ButtonType: NSRect] = [:]

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            previousWeb = nil
            apply()
        }

        override func layout() {
            super.layout()
            positionLights()
        }

        func apply() {
            guard let window else { return }
            if previousWeb != web {
                if web {
                    savedToolbar = window.toolbar
                    for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                        savedLightFrames[kind] = window.standardWindowButton(kind)?.frame
                    }
                    savedTitleVisibility = window.titleVisibility
                    savedTransparent = window.titlebarAppearsTransparent
                    savedFullSize = window.styleMask.contains(.fullSizeContentView)
                    window.toolbar = nil
                    window.titleVisibility = .hidden
                    window.titlebarAppearsTransparent = true
                    window.styleMask.insert(.fullSizeContentView)
                } else if previousWeb != nil {
                    window.titleVisibility = savedTitleVisibility
                    window.titlebarAppearsTransparent = savedTransparent
                    if !savedFullSize { window.styleMask.remove(.fullSizeContentView) }
                    if window.toolbar == nil { window.toolbar = savedToolbar }
                    for (kind, frame) in savedLightFrames {
                        window.standardWindowButton(kind)?.frame = frame
                    }
                }
                previousWeb = web
            }
            positionLights()
        }

        private func positionLights() {
            guard web, let window else { return }
            for (index, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
                guard let button = window.standardWindowButton(kind), let host = button.superview else { continue }
                let scale = barHeight / 32
                let y = host.isFlipped ? (barHeight - button.frame.height) / 2
                    : host.bounds.height - (barHeight + button.frame.height) / 2
                button.setFrameOrigin(NSPoint(x: (12 + CGFloat(index) * 20) * scale, y: y))
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
