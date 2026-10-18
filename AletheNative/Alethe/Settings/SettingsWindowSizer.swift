import AppKit
import SwiftUI

/// The `Settings` scene sizes its window to the content's minimum, ignoring the ideal size, and
/// restores whatever small frame it last had. Grows the window to the web size when it opens and
/// keeps it resizable.
struct SettingsWindowSizer: NSViewRepresentable {
    let size: CGSize

    func makeNSView(context: Context) -> NSView { SizerView(size: size) }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class SizerView: NSView {
        let size: CGSize
        init(size: CGSize) {
            self.size = size
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            // SwiftUI re-fits the window after the first layout, so apply again once it settles.
            for delay in [0.0, 0.25] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.grow() }
            }
        }

        private func grow() {
            guard let window else { return }
            window.styleMask.insert(.resizable)
            let visible = window.screen?.visibleFrame.size ?? size
            let target = CGSize(width: min(size.width, visible.width - 80), height: min(size.height, visible.height - 80))
            let content = window.contentRect(forFrameRect: window.frame).size
            guard content.width < target.width - 1 || content.height < target.height - 1 else { return }
            window.setContentSize(target)
            window.center()
        }
    }
}
