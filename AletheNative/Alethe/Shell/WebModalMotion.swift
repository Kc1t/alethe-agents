import AletheDesign
import SwiftUI

/// src/components/modals/Modal.module.css: modalFadeIn/Out on the backdrop, modalSpringPop/Out on the
/// dialog, and the `clean` visual style's cleanModalIn/Out. One definition serves every web overlay.
enum WebModalMotion {
    static func backdrop(visible: Bool, clean: Bool, reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        return visible ? .timingCurve(0.16, 1, 0.3, 1, duration: 0.2) : .timingCurve(0.42, 0, 1, 1, duration: 0.15)
    }

    static func content(visible: Bool, clean: Bool, reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        if clean {
            return visible ? .timingCurve(0, 0, 0.58, 1, duration: 0.12) : .timingCurve(0.42, 0, 1, 1, duration: 0.09)
        }
        return visible ? .timingCurve(0.175, 0.885, 0.32, 1.275, duration: 0.25)
                       : .timingCurve(0.4, 0, 0.2, 1, duration: 0.15)
    }

    /// Resting-state offsets from the centred position, as a fraction of the dialog height, and scale.
    static func hidden(opening: Bool, clean: Bool) -> (offset: CGFloat, scale: CGFloat) {
        if clean { return (0.02, 1) }
        return opening ? (0.05, 0.92) : (0.04, 0.94)
    }
}

private struct WebModalContentMotion: ViewModifier {
    let visible: Bool
    let closing: Bool
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        let clean = metrics.style == .clean
        let hidden = WebModalMotion.hidden(opening: !closing, clean: clean)
        content
            .opacity(visible ? 1 : 0)
            .scaleEffect(visible || metrics.reducesMotion ? 1 : hidden.scale)
            .visualEffect { view, proxy in
                view.offset(y: visible || metrics.reducesMotion ? 0 : proxy.size.height * hidden.offset)
            }
            .animation(WebModalMotion.content(visible: visible, clean: clean, reduceMotion: metrics.reducesMotion),
                       value: visible)
    }
}

private struct WebModalBackdropMotion: ViewModifier {
    let visible: Bool
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .animation(WebModalMotion.backdrop(visible: visible, clean: metrics.style == .clean,
                                               reduceMotion: metrics.reducesMotion), value: visible)
    }
}

extension View {
    /// Web dialog enter/exit: spring pop (or the clean fade-slide). `closing` selects the exit offsets.
    func webModalContentMotion(visible: Bool, closing: Bool = false) -> some View {
        modifier(WebModalContentMotion(visible: visible, closing: closing))
    }

    /// Web backdrop fade (modalFadeIn/Out).
    func webModalBackdropMotion(visible: Bool) -> some View {
        modifier(WebModalBackdropMotion(visible: visible))
    }
}
