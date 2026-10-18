import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// A toolbar usage pill (upstream topbar pills): the provider's busiest window, tinted as it fills;
/// clicking opens AI Usage. Signed-in providers retain a placeholder while usage is unavailable.
struct UsagePill: View {
    let provider: AgentKind
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if environment.usage.showsPill(provider) {
            let peak = environment.usage.usage[provider]?.peak
            Button { environment.editorRequest = .aiUsage } label: {
                if metrics.isWebInterface {
                    HStack(spacing: metrics.size(6)) {
                        AgentLogo(agent: provider.rawValue, size: 13)
                        Text(verbatim: peak.map { "\(Int($0.usedPercent.rounded()))%" } ?? "…")
                            .font(metrics.monoFont(size: 11, weight: .semibold))
                            .lineLimit(1)
                    }
                    .padding(.horizontal, metrics.size(8))
                    .padding(.vertical, metrics.size(2))
                    .frame(minHeight: metrics.size(22))
                    .foregroundStyle(theme[peak.map { UsageLevel.token($0.usedPercent) } ?? .textTertiary])
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.size(8)))
                    .fixedSize()
                } else {
                    HStack(spacing: metrics.size(6)) {
                        AgentLogo(agent: provider.rawValue, size: 13)
                        Text(verbatim: peak.map { "\(Int($0.usedPercent.rounded()))%" } ?? "…")
                    }
                        .font(metrics.font(.caption).monospacedDigit())
                        .padding(.horizontal, metrics.space(.s))
                        .padding(.vertical, metrics.space(.xxs))
                        .background(theme[peak.map { UsageLevel.token($0.usedPercent) } ?? .textTertiary].opacity(0.18), in: Capsule())
                        .foregroundStyle(theme[peak.map { UsageLevel.token($0.usedPercent) } ?? .textTertiary])
                }
            }
            .opacity(environment.usage.stale.contains(provider) ? 0.55 : 1)
            .buttonStyle(.plain)
            .help(Text(String(format: String(localized: "usage.pill.help"), AgentLabels.name(for: provider.rawValue), peak?.label ?? "…")))
            .accessibilityIdentifier("usage.pill.\(provider.rawValue)")
        }
    }
}

/// Toolbar: opens AI Usage.
struct AIUsageButton: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        Button { environment.editorRequest = .aiUsage } label: {
            Label { Text("usage.title") } icon: { Image(systemName: "gauge.with.dots.needle.33percent").webProfileSized(14) }
        }
        .help(Text("usage.title"))
        .accessibilityIdentifier("usage.button")
    }
}

enum UsageLevel {
    static func token(_ percent: Double) -> ThemeToken {
        percent >= 90 ? .statusStopped : percent >= 70 ? .statusWaiting : .statusActive
    }
}

/// AI Usage (upstream `AiUsageModal` + `ResetCreditModal`): every provider's windows with when they
/// reset, Codex's plan and reset credits, and which providers show a pill.
struct AIUsageSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var confirmCredit: CodexResetCredit?
    @State private var creditFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            HStack {
                Text("usage.title").font(metrics.font(.title3))
                Spacer()
                if !environment.usage.refreshing.isEmpty { WebBusyIndicator() }
                Button("cost.refresh") { Task { await environment.usage.refresh() } }
            }
            ForEach(UsageMonitor.providers, id: \.self) { provider in
                section(provider)
                Divider()
            }
            Toggle("usage.notifyReset", isOn: Binding {
                environment.preferences?.document.notifyLimitReset != false
            } set: { value in
                environment.preferences?.update { $0.notifyLimitReset = value ? nil : false }
            })
            HStack {
                Spacer()
                Button("agentInstall.done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(520))
        .task { await environment.usage.refresh() }
        .webConfirm(isPresented: Binding { confirmCredit != nil } set: { if !$0 { confirmCredit = nil } },
                    message: confirmCredit.map { [$0.title, $0.detail].filter { !$0.isEmpty }.joined(separator: "\n") } ?? "",
                    title: String(localized: "usage.credit.confirm"),
                    confirmTitle: String(localized: "usage.credit.use")) {
            if let credit = confirmCredit { Task { creditFailed = !(await environment.usage.consumeResetCredit(credit)) } }
        }
        .confirmationDialog(Text("usage.credit.confirm"), isPresented: Binding { !metrics.isWebInterface && confirmCredit != nil } set: { if !$0 { confirmCredit = nil } },
                            presenting: confirmCredit) { credit in
            Button("usage.credit.use") {
                Task { creditFailed = !(await environment.usage.consumeResetCredit(credit)) }
            }
        } message: { credit in
            Text(verbatim: [credit.title, credit.detail].filter { !$0.isEmpty }.joined(separator: "\n"))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("usage.sheet")
    }

    @ViewBuilder
    private func section(_ provider: AgentKind) -> some View {
        let usage = environment.usage.usage[provider]
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            HStack {
                Text(verbatim: AgentLabels.name(for: provider.rawValue)).font(metrics.font(.headline))
                if let plan = usage?.plan { Text(verbatim: plan.capitalized).foregroundStyle(theme[.textTertiary]) }
                Spacer()
                Toggle("usage.showPill", isOn: pill(provider)).toggleStyle(.checkbox)
                    .accessibilityIdentifier("usage.pillToggle.\(provider.rawValue)")
            }
            switch usage?.status {
            case .ready?:
                ForEach(usage?.windows ?? []) { window in
                    VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                        HStack {
                            Text(verbatim: window.label)
                            Spacer()
                            Text(verbatim: "\(Int(window.usedPercent.rounded()))%").monospacedDigit()
                            if let reset = window.resetsAt {
                                Text("usage.resets") + Text(reset, format: .relative(presentation: .named))
                            }
                        }
                        .font(metrics.font(.footnote))
                        if metrics.isWebInterface {
                            WebProgressBar(value: min(window.usedPercent, 100), token: UsageLevel.token(window.usedPercent))
                        } else {
                            ProgressView(value: min(window.usedPercent, 100), total: 100)
                                .tint(theme[UsageLevel.token(window.usedPercent)])
                        }
                    }
                }
                if provider == .codex, let credits = usage?.resetCredits, !credits.isEmpty {
                    HStack {
                        Text(String(format: String(localized: "usage.credits"), credits.count)).font(metrics.font(.footnote))
                        Spacer()
                        Button("usage.credit.useEllipsis") { confirmCredit = credits.first }
                    }
                    if creditFailed { Text("usage.credit.failed").font(metrics.font(.footnote)).foregroundStyle(theme[.statusStopped]) }
                }
            case .noCLI?: Text("usage.noCLI").foregroundStyle(theme[.textTertiary])
            case .noAuth?: Text("usage.noAuth").foregroundStyle(theme[.textTertiary])
            case .unavailable(let reason)?:
                Text(String(format: String(localized: "usage.unavailable"), reason)).foregroundStyle(theme[.textTertiary])
            case nil: WebBusyIndicator()
            }
        }
    }

    /// The same choice as Settings › Toolbar.
    private func pill(_ provider: AgentKind) -> Binding<Bool> {
        let item = ToolbarItemKind.usagePill(for: provider.rawValue)
        return Binding {
            item.map { environment.preferences?.document.showsToolbarItem($0) == true } ?? false
        } set: { on in
            guard let item else { return }
            environment.preferences?.update { $0.setToolbarItem(item, shown: on) }
        }
    }
}
