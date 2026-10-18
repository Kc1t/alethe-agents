import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// TitleBar/index.tsx usageWidget: live provider windows on hover, details on click.
struct WebTitleBarUsagePill: View {
    let provider: AgentKind
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    @State private var detailsHovered = false
    @State private var showsDetails = false
    @State private var dismissal: Task<Void, Never>?

    var body: some View {
        if environment.usage.showsPill(provider) {
            let usage = environment.usage.usage[provider]
            let headline = usage.flatMap { self.headline($0) }
            Button {
                showsDetails = false
                environment.editorRequest = .aiUsage
            } label: {
                HStack(spacing: metrics.size(6)) {
                    AgentLogo(agent: provider.rawValue, size: 13)
                    Text(verbatim: headline.map { "\(Int($0.usedPercent.rounded()))%" } ?? "…")
                        .font(metrics.monoFont(size: 11, weight: metrics.style == .clean ? .medium : .semibold))
                }
                .foregroundStyle(theme[headline.map { level($0.usedPercent) } ?? .fgFaint])
                .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(2))
                .frame(minHeight: metrics.size(22))
                .background(theme[hovering ? .panelHover : .bgSunken].opacity(metrics.style == .clean && !hovering ? 0 : 1),
                            in: RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 8)))
            }
            .opacity(environment.usage.stale.contains(provider) ? 0.55 : 1)
            .buttonStyle(.plain)
            .fixedSize()
            .help(Text("usage.title"))
            .accessibilityIdentifier("usage.pill.\(provider.rawValue)")
            .onHover { value in
                hovering = value
                dismissal?.cancel()
                if value { showsDetails = true } else { scheduleDismissal() }
            }
            .webTitleBarPopover(isPresented: $showsDetails, width: 240) {
                Group {
                    if let usage, headline != nil { details(usage) }
                    else {
                        Text("usage.reading.pending")
                            .font(metrics.font(size: 11))
                            .foregroundStyle(theme[.fgFaint])
                            .padding(metrics.size(12))
                    }
                }
                    .onHover { value in
                        detailsHovered = value
                        dismissal?.cancel()
                        if !value { scheduleDismissal() }
                    }
            }
            .onDisappear { dismissal?.cancel() }
        }
    }

    private func headline(_ usage: ProviderUsage) -> UsageWindow? {
        // Claude's web pill shows the five-hour window; Codex falls back to its weekly window.
        provider == .antigravity ? usage.peak : usage.windows.first
    }

    private func level(_ percent: Double) -> ThemeToken {
        percent >= 80 ? .statusOffline : percent >= 50 ? .statusWaiting : .statusWorking
    }

    private func scheduleDismissal() {
        dismissal = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, !hovering, !detailsHovered else { return }
            showsDetails = false
        }
    }

    private func details(_ usage: ProviderUsage) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(2)) {
            HStack(spacing: metrics.size(6)) {
                AgentLogo(agent: provider.rawValue, size: 13)
                Text(verbatim: AgentLabels.name(for: provider.rawValue))
                    .font(metrics.font(size: 11, weight: .bold))
            }.padding(.bottom, metrics.size(6))
            ForEach(usage.windows) { window in
                HStack(alignment: .firstTextBaseline, spacing: metrics.size(12)) {
                    Text(verbatim: window.label).lineLimit(1).foregroundStyle(theme[.fgMuted])
                    Spacer(minLength: 0)
                    Text(verbatim: "\(Int(window.usedPercent.rounded()))%")
                        .font(metrics.font(size: 11, weight: .bold))
                }
            }
            if provider == .codex {
                HStack(spacing: metrics.size(12)) {
                    Text("titlebar.usage.status").foregroundStyle(theme[.fgMuted])
                    Spacer(minLength: 0)
                    Text(usage.rateLimited ? "titlebar.usage.limited" : "titlebar.usage.ok")
                        .font(metrics.font(size: 11, weight: .bold))
                }
                Text(verbatim: String(format: String(localized: "usage.credits"), usage.resetCredits.count))
                    .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                    .padding(.top, metrics.size(6))
            } else if let reset = headline(usage)?.resetsAt {
                HStack(spacing: metrics.size(4)) {
                    Text("usage.resets")
                    Text(reset, style: .relative)
                }
                .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                .padding(.top, metrics.size(6))
            }
        }
        .font(metrics.font(size: 11)).foregroundStyle(theme[.fg])
        .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10))
        .frame(width: metrics.size(240))
        .modifier(AletheTitleBarSurface(usage: true))
    }
}
