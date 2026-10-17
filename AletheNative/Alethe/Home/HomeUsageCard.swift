import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// UsageStrip.tsx's provider cards, backed exclusively by UsageMonitor readings.
struct WebHomeUsageCard: View {
    let provider: AgentKind
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var width: CGFloat = 0

    private var usage: ProviderUsage? { environment.usage.usage[provider] }
    private var ready: Bool { usage?.status == .ready }
    private var enabled: Bool { environment.usage.shownProviders.contains(provider) }
    private var refreshing: Bool { environment.usage.refreshing.contains(provider) }
    private var accent: ThemeToken { AgentTokens.accent(for: provider.rawValue) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: metrics.size(9)) {
                AgentLogo(agent: provider.rawValue, size: 16)
                    .frame(width: metrics.size(16), height: metrics.size(16)).clipped()
                    .frame(width: metrics.size(26), height: metrics.size(26))
                    .background(theme[accent].opacity(0.14), in: RoundedRectangle(cornerRadius: metrics.size(7)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(7))
                        .strokeBorder(theme[accent].opacity(provider == .claude ? 0.26 : 0.28), lineWidth: metrics.size(1)))
                Text(verbatim: provider == .claude ? "claude code" : provider.rawValue)
                    .font(metrics.font(size: 13.5, weight: .medium)).tracking(metrics.size(-0.135))
                    .foregroundStyle(theme[.fg]).lineLimit(1)
                if width > metrics.size(216), ready, let plan = usage?.plan, !plan.isEmpty {
                    Text(verbatim: plan.lowercased()).font(metrics.monoFont(size: 9.5))
                        .foregroundStyle(theme[.textTertiary]).lineLimit(1)
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(5)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(5)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                }
                Spacer(minLength: 0)
                if enabled {
                    if ready, !environment.usage.stale.contains(provider), width > metrics.size(216) {
                        HStack(spacing: metrics.size(5)) {
                            AletheStatusDot(accent, side: 6)
                            Text("home.web.live").font(metrics.monoFont(size: 9.5)).foregroundStyle(theme[.textTertiary])
                        }.fixedSize()
                    }
                    HomeBottomRefreshButton(refreshing: refreshing) {
                        await environment.usage.refresh([provider])
                    }
                }
            }
            .frame(minHeight: metrics.size(26)).padding(.bottom, metrics.size(14))
            if let usage, ready, let headline = usage.windows.first {
                reading(usage, headline: headline)
                    .opacity(environment.usage.stale.contains(provider) ? 0.5 : 1)
            } else {
                empty
            }
        }
        .modifier(HomeWebCard())
        .onGeometryChange(for: CGFloat.self) { max(0, $0.size.width - metrics.size(28)) } action: { width = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.usage.\(provider.rawValue)")
    }

    private var emptyTitle: LocalizedStringKey {
        if !enabled { return "home.bottom.usageOff" }
        if let usage {
            switch usage.status {
            case .noCLI: return "usage.noCLI"
            case .unavailable: return "home.bottom.usageUnavailable"
            default: break
            }
        }
        return provider == .claude ? "home.web.noToken" : "home.web.notSignedIn"
    }

    private var emptyHint: String {
        if !enabled {
            return String(format: String(localized: "home.bottom.usageOffHint"),
                          AgentLabels.name(for: provider.rawValue), provider == .claude ? "Anthropic" : "OpenAI")
        }
        if let usage, case .unavailable = usage.status { return String(localized: "home.bottom.usageUnavailableHint") }
        return provider == .claude ? String(localized: "home.web.connectUsage") : String(localized: "home.web.codexLogin")
    }

    private var empty: some View {
        VStack(spacing: metrics.size(6)) {
            Text(emptyTitle).font(metrics.font(size: 12.5, weight: .medium)).foregroundStyle(theme[.textTertiary])
            Text(verbatim: emptyHint)
                .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.textQuaternary])
            if !enabled {
                Button("home.bottom.turnOnUsage") {
                    if let item = ToolbarItemKind.usagePill(for: provider.rawValue) {
                        environment.preferences?.update { $0.setToolbarItem(item, shown: true) }
                    }
                    Task { await environment.usage.refresh([provider]) }
                }
                .buttonStyle(AletheButtonStyle(size: .small)).padding(.top, metrics.size(6))
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: metrics.size(170), maxHeight: .infinity)
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
            .strokeBorder(theme[.borderStrong], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(3)])))
    }

    private func reading(_ usage: ProviderUsage, headline: UsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: metrics.size(10)) { hero(headline); Spacer(minLength: 0); resetChip(headline.resetsAt) }
                VStack(alignment: .leading, spacing: metrics.size(10)) { hero(headline); resetChip(headline.resetsAt) }
            }
            Group {
                if usage.rateLimited {
                    Text("home.bottom.limited")
                } else if headline.label == "5h" {
                    HStack(spacing: metrics.size(4)) {
                        Text("home.bottom.usage5h")
                        if let weekly = usage.windows.first(where: { $0.label == "7d" }) {
                            Text(verbatim: "·")
                            Text("home.bottom.week")
                            Text(verbatim: "\(Int(weekly.usedPercent.rounded()))%")
                        }
                    }
                } else { Text(verbatim: windowLabel(headline)) }
            }
            .font(metrics.monoFont(size: 11)).foregroundStyle(theme[usage.rateLimited || headline.usedPercent >= 80 ? .statusOffline : .textTertiary])
            .padding(.top, metrics.size(6)).lineLimit(2)
            VStack(spacing: metrics.size(13)) {
                ForEach(usage.windows) { window in
                    VStack(spacing: metrics.size(7)) {
                        HStack(alignment: .firstTextBaseline, spacing: metrics.size(8)) {
                            Text(verbatim: windowLabel(window)).font(metrics.font(size: 11.5))
                                .foregroundStyle(theme[.textSecondary]).lineLimit(1)
                            Spacer(minLength: 0)
                            Text(verbatim: "\(Int(window.usedPercent.rounded()))%")
                                .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                        }
                        GeometryReader { geometry in
                            RoundedRectangle(cornerRadius: metrics.size(3)).fill(theme[.bgElevated])
                                .overlay(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: metrics.size(3))
                                        .fill(theme[window.usedPercent >= 80 ? .statusOffline : window.usedPercent >= 50 ? .statusWaiting : accent])
                                        .frame(width: geometry.size.width * max(0, min(window.usedPercent, 100)) / 100)
                                        .animation(metrics.reducesMotion ? nil : Motion.animation(Motion.standard, reduceMotion: false), value: window.usedPercent)
                                }
                        }.frame(height: metrics.size(6))
                    }
                }
            }.padding(.top, metrics.size(16))
            LazyVGrid(columns: [GridItem(.flexible(), spacing: metrics.size(14)), GridItem(.flexible())],
                      alignment: .leading, spacing: metrics.size(9)) {
                ForEach(usage.windows) { window in
                    VStack(alignment: .leading, spacing: metrics.size(2)) {
                        Text(String(format: String(localized: "home.bottom.resetWindow"), windowLabel(window)))
                            .font(metrics.font(size: 10)).tracking(metrics.size(0.2)).foregroundStyle(theme[.textQuaternary])
                        Text(verbatim: resetText(window.resetsAt)).font(metrics.monoFont(size: 12))
                            .foregroundStyle(theme[.fgMuted]).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(provider == .codex ? "home.bottom.status" : "home.bottom.peak")
                        .font(metrics.font(size: 10)).foregroundStyle(theme[.textQuaternary])
                    if provider == .codex {
                        Text(usage.rateLimited ? "home.bottom.statusLimited" : "home.bottom.ok")
                            .font(metrics.monoFont(size: 12)).foregroundStyle(theme[usage.rateLimited ? .statusOffline : .fgMuted])
                    } else {
                        Text(verbatim: "\(Int((usage.peak?.usedPercent ?? 0).rounded()))%")
                            .font(metrics.monoFont(size: 12)).foregroundStyle(theme[(usage.peak?.usedPercent ?? 0) >= 80 ? .statusOffline : .fgMuted])
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, metrics.size(13)).overlay(alignment: .top) { theme[.borderSubtle].frame(height: metrics.size(1)) }
            .padding(.top, metrics.size(16))
            HStack(spacing: metrics.size(6)) {
                AletheStatusDot(accent, side: 6)
                Text(verbatim: usage.windows.map { windowLabel($0) }.joined(separator: " · ")).lineLimit(1)
                Spacer(minLength: 0)
                Text(String(format: String(localized: "home.bottom.peakValue"), Int((usage.peak?.usedPercent ?? 0).rounded())))
                    .foregroundStyle(theme[.textQuaternary]).lineLimit(1)
            }
            .font(metrics.monoFont(size: 10.5)).foregroundStyle(theme[.textTertiary])
            .padding(.top, metrics.size(12)).overlay(alignment: .top) { theme[.borderSubtle].frame(height: metrics.size(1)) }
            .padding(.top, metrics.size(14))
        }
    }

    private func hero(_ window: UsageWindow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: metrics.size(4)) {
            Text(verbatim: "\(Int(window.usedPercent.rounded()))")
                .font(metrics.monoFont(size: min(28, max(20, width / metrics.scale * 0.11)), weight: .semibold))
                .tracking(metrics.size(-0.56)).foregroundStyle(theme[.fg])
            Text(verbatim: "%").font(metrics.monoFont(size: min(16, max(11, width / metrics.scale * 0.06)), weight: .medium))
                .foregroundStyle(theme[.textQuaternary])
        }.fixedSize()
    }

    private func resetChip(_ date: Date?) -> some View {
        HStack(spacing: metrics.size(5)) {
            Image(systemName: "clock").webProfileSized(11).opacity(0.55)
            Text(verbatim: resetText(date)).font(metrics.monoFont(size: 10.5, weight: .medium))
        }
        .foregroundStyle(theme[.fg]).padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(4))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(7)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .fixedSize()
    }

    private func windowLabel(_ window: UsageWindow) -> String {
        switch window.label {
        case "7d": String(localized: "home.bottom.week")
        case "7d Opus": "opus"
        default: window.label.lowercased()
        }
    }

    private func resetText(_ date: Date?) -> String {
        guard let date else { return "—" }
        let seconds = date.timeIntervalSinceNow
        guard seconds > 0 else { return String(localized: "home.bottom.resetting") }
        let minutes = Int(seconds / 60), hours = minutes / 60
        if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
        return hours > 0 ? "\(hours)h \(minutes % 60)m" : "\(minutes)m"
    }
}

/// Matches iconBtn, including disabled refresh and hover feedback.
struct HomeBottomRefreshButton: View {
    let refreshing: Bool
    let refresh: () async -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovered = false

    var body: some View {
        Button { Task { await refresh() } } label: {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: !refreshing || metrics.reducesMotion)) { context in
                Image(systemName: "arrow.clockwise").webProfileSized(12)
                    .rotationEffect(.degrees(refreshing && !metrics.reducesMotion
                        ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.8) / 0.8 * 360 : 0))
            }
        }
        .buttonStyle(AletheHomeRefreshStyle())
        .background(theme[.accentSoft].opacity(hovered ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.size(6)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(6)).strokeBorder(theme[.borderStrong].opacity(hovered ? 1 : 0), lineWidth: metrics.size(1)))
        .onHover { hovered = $0 }.disabled(refreshing).opacity(refreshing ? 0.5 : 1)
        .help(Text("home.refresh")).accessibilityLabel(Text("home.refresh"))
    }
}
