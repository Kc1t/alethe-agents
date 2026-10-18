import AppKit
import SwiftUI

/// The `Settings` scene sizes its window to the content's minimum, ignoring the ideal size, and
/// restores whatever small frame it last had. Grows the window to the web size once and keeps it resizable.
struct SettingsWindowSizer: NSViewRepresentable {
    let size: CGSize

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
            window.styleMask.insert(.resizable)
            let visible = window.screen?.visibleFrame.size ?? size
            let target = CGSize(width: min(size.width, visible.width - 80), height: min(size.height, visible.height - 80))
            guard window.frame.width < target.width - 1 || window.frame.height < target.height - 1 else { return }
            window.setContentSize(target)
            window.center()
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
