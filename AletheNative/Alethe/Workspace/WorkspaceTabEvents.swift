import AppKit
import SwiftUI

/// Handles pointer buttons and numbered shortcuts without intercepting terminal text input.
struct WorkspaceTabEvents: NSViewRepresentable {
    var number: Int? = nil
    var listensForMiddleClick = true
    let activate: () -> Void
    let close: () -> Void

    func makeNSView(context: Context) -> TabEventView { TabEventView() }

    func updateNSView(_ view: TabEventView, context: Context) {
        view.number = number
        view.listensForMiddleClick = listensForMiddleClick
        view.activate = activate
        view.close = close
        view.install()
    }

    static func dismantleNSView(_ view: TabEventView, coordinator: ()) { view.uninstall() }

    @MainActor
    final class TabEventView: NSView {
        var number: Int?
        var listensForMiddleClick = true
        var activate: () -> Void = {}
        var close: () -> Void = {}
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func install() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .keyDown]) { [weak self] event in
                let handled = MainActor.assumeIsolated {
                    guard let self, let window = self.window, window.isKeyWindow,
                          event.window === window else { return false }
                    if self.listensForMiddleClick, event.type == .otherMouseDown, event.buttonNumber == 2,
                       self.bounds.contains(self.convert(event.locationInWindow, from: nil)) {
                        self.close()
                        return true
                    }
                    if event.type == .keyDown, let number = self.number, number <= 9,
                       event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                       event.charactersIgnoringModifiers == String(number) {
                        self.activate()
                        return true
                    }
                    return false
                }
                return handled ? nil : event
            }
        }

        func uninstall() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}
