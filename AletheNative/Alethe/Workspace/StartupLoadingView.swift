import AletheDesign
import SwiftUI

/// Decorative boot animation; the accessible status stays stable as the cells cycle.
struct StartupLoadingView: View {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var appeared = false
    @State private var startedAt = Date.now

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: metrics.reducesMotion)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(startedAt))
            VStack(spacing: metrics.size(10)) {
                Text(verbatim: "ALETHE")
                    .font(metrics.monoFont(size: 12, weight: .semibold))
                    .tracking(metrics.size(12 * 0.52))
                    .padding(.leading, metrics.size(12 * 0.52))
                    .foregroundStyle(theme[.fg])
                HStack(spacing: metrics.size(7)) {
                    Text(verbatim: "›")
                        .font(metrics.monoFont(size: 10, weight: .bold))
                        .foregroundStyle(theme[.accent])
                    Text("loading.initializing")
                        .font(metrics.monoFont(size: 10))
                        .textCase(.uppercase)
                        .tracking(metrics.size(0.4))
                        .foregroundStyle(theme[.fgFaint])
                    Rectangle()
                        .fill(theme[.fgMuted])
                        .frame(width: metrics.size(5), height: metrics.size(10))
                        .opacity(metrics.reducesMotion || elapsed.truncatingRemainder(dividingBy: 0.9) < 0.45 ? 1 : 0)
                }
                .frame(minHeight: metrics.size(18))
                .padding(.top, metrics.size(5))
                HStack(spacing: metrics.size(4)) {
                    ForEach(0..<12) { index in
                        RoundedRectangle(cornerRadius: metrics.size(1))
                            .fill(theme[.borderStrong])
                            .overlay {
                                RoundedRectangle(cornerRadius: metrics.size(1))
                                    .fill(theme[.accent])
                                    .opacity(cellIntensity(elapsed, index: index))
                            }
                            .frame(width: metrics.size(3), height: metrics.size(3))
                    }
                }
                .frame(height: metrics.size(10))
                .padding(.top, metrics.size(2))
            }
            .padding(.top, metrics.size(22))
            .padding(.horizontal, metrics.size(26))
            .padding(.bottom, metrics.size(20))
            .frame(minWidth: metrics.size(320))
            .background(theme[.surfaceModal], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .shadow(color: metrics.isWebInterface && metrics.style == .clean ? .clear : theme.shadow(.lg).color.color, radius: metrics.size(theme.shadow(.lg).blur),
                    x: metrics.size(theme.shadow(.lg).x), y: metrics.size(theme.shadow(.lg).y))
            .opacity(appeared || metrics.reducesMotion ? 1 : 0)
            .offset(y: appeared || metrics.reducesMotion || (metrics.isWebInterface && metrics.style == .clean) ? 0 : metrics.size(5))
            .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.28), value: appeared)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bg].ignoresSafeArea())
        .onAppear { appeared = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("loading.initializing"))
        .accessibilityIdentifier("startup.loading")
    }

    private func cellIntensity(_ elapsed: TimeInterval, index: Int) -> Double {
        guard !metrics.reducesMotion else { return 0 }
        let delayed = elapsed - Double(index) * 0.07
        guard delayed >= 0 else { return 0 }
        let phase = delayed.truncatingRemainder(dividingBy: 1.15) / 1.15
        guard phase < 0.6 else { return 0 }
        return (1 - cos(phase / 0.6 * 2 * .pi)) / 2
    }
}
