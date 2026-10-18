import AletheDesign
import SwiftUI

/// One in-app banner (upstream `InAppToast`). A toast that carries actions waits longer.
struct InAppToast: Identifiable {
    struct Action: Identifiable {
        let id = UUID()
        let label: String
        var quiet = false
        let run: @MainActor () -> Void
    }

    let id: UUID
    let title: String
    let body: String
    var agent: String?
    var actions: [Action] = []

    /// 20 s with actions, 6.5 s without (InAppNotifications.tsx).
    var lifetime: Duration { actions.isEmpty ? .milliseconds(6500) : .seconds(20) }
}

/// `InAppNotifications.tsx` + `.module.css`: a centred stack of pills 14 points from the top.
struct InAppToastHost: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(spacing: metrics.size(8)) {
            ForEach(environment.notifier.toasts) { toast in
                InAppToastPill(toast: toast)
                    .transition(metrics.reducesMotion ? .identity : .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.96)).combined(with: .offset(y: metrics.size(-8))),
                        removal: .opacity))
            }
        }
        .frame(maxWidth: min(metrics.size(640), .infinity))
        .padding(.top, metrics.size(14))
        .padding(.horizontal, metrics.size(16))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(metrics.reducesMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.2),
                   value: environment.notifier.toasts.map(\.id))
        .allowsHitTesting(!environment.notifier.toasts.isEmpty)
        .accessibilityElement(children: .contain)
    }
}

private struct InAppToastPill: View {
    let toast: InAppToast
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    @State private var closeHover = false
    @State private var remaining: Duration

    init(toast: InAppToast) {
        self.toast = toast
        _remaining = State(initialValue: toast.lifetime)
    }

    private var accent: ThemeToken { toast.agent.map(AgentTokens.accent(for:)) ?? .accent }

    var body: some View {
        HStack(spacing: metrics.size(9)) {
            icon
            HStack(alignment: .firstTextBaseline, spacing: metrics.size(6)) {
                Text(verbatim: toast.title)
                    .font(metrics.font(size: 12, weight: .semibold))
                    .foregroundStyle(theme[.fg])
                    .lineLimit(1).fixedSize()
                Text(verbatim: toast.body)
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .lineLimit(1).truncationMode(.tail)
                    .help(Text(verbatim: toast.body))
            }
            if !toast.actions.isEmpty { actions }
            Button { environment.notifier.dismissToast(toast.id) } label: {
                Image(systemName: "xmark").font(metrics.font(size: 10, weight: .medium))
                    .foregroundStyle(theme[closeHover ? .fg : .fgFaint])
                    .frame(width: metrics.size(20), height: metrics.size(20))
                    .background(theme[.panelHover].opacity(closeHover ? 1 : 0), in: Circle())
            }
            .buttonStyle(.plain)
            .onHover { closeHover = $0 }
            .help(Text("toast.close"))
            .accessibilityLabel(Text("toast.close"))
            .accessibilityIdentifier("toast.close")
        }
        .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(6))
        .background(theme[.surfaceModal], in: Capsule())
        .overlay(Capsule().strokeBorder(Self.mix(theme[accent], theme[.border], 0.3), lineWidth: metrics.size(1)))
        .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(theme.shadow(.md).blur),
                x: metrics.size(theme.shadow(.md).x), y: metrics.size(theme.shadow(.md).y))
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "\(toast.title) \(toast.body)"))
        .accessibilityIdentifier("toast.\(toast.id.uuidString)")
        .task(id: hovering) { await countDown() }
    }

    /// Hovering pauses the timer; leaving resumes with what was left.
    private func countDown() async {
        guard !hovering else { return }
        let clock = ContinuousClock()
        let start = clock.now
        do { try await clock.sleep(for: remaining) } catch {
            remaining = max(.zero, remaining - (clock.now - start))
            return
        }
        environment.notifier.dismissToast(toast.id)
    }

    private var icon: some View {
        Group {
            if let agent = toast.agent {
                AgentLogo(agent: agent, size: 16)
            } else {
                Image(systemName: "bell").font(metrics.font(size: 12))
                    .foregroundStyle(theme[accent])
            }
        }
        .frame(width: metrics.size(24), height: metrics.size(24))
        .background(theme[accent].opacity(0.16), in: Circle())
        .accessibilityHidden(true)
    }

    private var actions: some View {
        HStack(spacing: metrics.size(4)) {
            ForEach(Array(toast.actions.enumerated()), id: \.element.id) { index, action in
                InAppToastAction(label: action.label, kind: action.quiet ? .quiet : index == 0 ? .primary : .secondary,
                                 accent: accent) {
                    action.run()
                    environment.notifier.dismissToast(toast.id)
                }
            }
        }
        .padding(.leading, metrics.size(8))
        .overlay(alignment: .leading) { theme[.borderSubtle].frame(width: metrics.size(1)) }
        .padding(.leading, metrics.size(2))
    }

    /// `color-mix(in srgb, a pct%, b)`.
    private static func mix(_ a: Color, _ b: Color, _ amount: Double) -> Color {
        b.mix(with: a, by: amount, in: .device)
    }
}

private struct InAppToastAction: View {
    enum Kind { case primary, secondary, quiet }
    let label: String
    let kind: Kind
    let accent: ThemeToken
    let run: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    var body: some View {
        let shape = Capsule()
        Button(action: run) {
            Text(verbatim: label)
                .font(metrics.font(size: 11, weight: kind == .primary ? .semibold : .regular))
                .foregroundStyle(foreground)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(3))
                .background(background, in: shape)
                .overlay(shape.strokeBorder(border, lineWidth: metrics.size(1)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(metrics.reducesMotion ? nil : .timingCurve(0.25, 0.1, 0.25, 1, duration: 0.12), value: hovering)
        .accessibilityIdentifier("toast.action.\(label)")
    }

    private var foreground: Color {
        switch kind {
        case .primary: theme[.accentOn]
        case .secondary: theme[hovering ? .fg : .fgMuted]
        case .quiet: theme[hovering ? .fg : .fgFaint]
        }
    }

    private var background: Color {
        switch kind {
        case .primary: theme[hovering ? .accentStrong : accent]
        case .secondary: .clear
        case .quiet: hovering ? theme[.panelHover] : .clear
        }
    }

    private var border: Color {
        switch kind {
        case .primary: theme[hovering ? .accentStrong : accent]
        case .secondary: theme[hovering ? .borderStrong : .border]
        case .quiet: .clear
        }
    }
}
