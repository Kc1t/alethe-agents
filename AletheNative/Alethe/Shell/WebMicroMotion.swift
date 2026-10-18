import AletheDesign
import SwiftUI

/// `ramPillPulse` (TitleBar.module.css): opacity 1 to 0.55 and back, looping every `period` seconds.
private struct WebOpacityPulse: ViewModifier {
    let period: Double
    let active: Bool
    @Environment(\.metrics) private var metrics
    @State private var dimmed = false

    func body(content: Content) -> some View {
        let running = active && !metrics.reducesMotion
        content
            .opacity(running && dimmed ? 0.55 : 1)
            .onAppear { restart(running) }
            .onChange(of: running) { _, now in restart(now) }
            .onChange(of: period) { _, _ in restart(running) }
    }

    private func restart(_ running: Bool) {
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) { dimmed = false }
        guard running else { return }
        withAnimation(.easeInOut(duration: period / 2).repeatForever(autoreverses: true)) { dimmed = true }
    }
}

/// `avatarIn` (WelcomeModal.module.css): 520 ms, rises 12 points from 0.92 scale.
private struct WebAvatarIn: ViewModifier {
    @Environment(\.metrics) private var metrics
    @State private var appeared = false

    func body(content: Content) -> some View {
        content
            .opacity(appeared || metrics.reducesMotion ? 1 : 0)
            .scaleEffect(appeared || metrics.reducesMotion ? 1 : 0.92)
            .offset(y: appeared || metrics.reducesMotion ? 0 : metrics.size(12))
            .animation(metrics.reducesMotion ? nil : .timingCurve(0.2, 0.85, 0.2, 1, duration: 0.52), value: appeared)
            .onAppear { appeared = true }
    }
}

extension View {
    func webOpacityPulse(period: Double, active: Bool = true) -> some View {
        modifier(WebOpacityPulse(period: period, active: active))
    }

    func webAvatarIn() -> some View { modifier(WebAvatarIn()) }
}
