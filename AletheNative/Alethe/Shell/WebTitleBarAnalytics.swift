import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

struct WebTitleBarAnalytics<Content: View>: View {
    let title: LocalizedStringKey
    let close: () -> Void
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @State private var height: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(metrics.font(size: 15, weight: .semibold))
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark").resizable().scaledToFit()
                        .frame(width: metrics.size(16), height: metrics.size(16))
                }
                .buttonStyle(AletheIconButtonStyle(side: 26))
                .accessibilityLabel(Text("editor.cancel"))
            }
            .padding(.horizontal, metrics.size(20)).padding(.top, metrics.size(16))
            ScrollView {
                content()
                    .padding(.horizontal, metrics.size(20))
                    .padding(.top, metrics.size(14)).padding(.bottom, metrics.size(18))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(height, max(metrics.size(60), maximumHeight - metrics.size(58))))
        }
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
    }
}

struct WebTitleBarUsage: View {
    let close: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var editing = false

    var body: some View {
        WebTitleBarAnalytics(title: "usage.title", close: close) {
            VStack(alignment: .leading, spacing: metrics.size(16)) {
                HStack {
                    Text("titlebar.usage.description").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    Spacer()
                    Button { editing.toggle() } label: {
                        Image(systemName: "slider.horizontal.3").resizable().scaledToFit()
                            .frame(width: metrics.size(15), height: metrics.size(15))
                    }
                    .buttonStyle(AletheIconButtonStyle(side: 26, isOn: editing))
                    .help(Text("settings.toolbar"))
                }
                if editing {
                    VStack(spacing: metrics.size(2)) {
                        ForEach(UsageMonitor.providers, id: \.self) { provider in
                            HStack(spacing: metrics.size(8)) {
                                AgentLogo(agent: provider.rawValue, size: 16)
                                Text(verbatim: AgentLabels.name(for: provider.rawValue)).font(metrics.font(size: 13))
                                Spacer()
                                Toggle("usage.showPill", isOn: pill(provider)).toggleStyle(.switch)
                                    .font(metrics.font(size: 11))
                                    .accessibilityIdentifier("usage.pillToggle.\(provider.rawValue)")
                            }.padding(.horizontal, metrics.size(8)).frame(minHeight: metrics.size(36))
                        }
                    }.padding(metrics.size(8)).modifier(AletheTitleBarSurface())
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(260)), spacing: metrics.size(6))], spacing: metrics.size(6)) {
                    ForEach(UsageMonitor.providers, id: \.self) { provider in card(provider) }
                }
                .padding(metrics.size(6))
                .background(theme[.bgSunken].opacity(0.72), in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                Toggle("usage.notifyReset", isOn: Binding {
                    environment.preferences?.document.notifyLimitReset != false
                } set: { value in environment.preferences?.update { $0.notifyLimitReset = value ? nil : false } })
                .font(metrics.font(size: 12))
            }
        }
        .task { await environment.usage.refresh() }
        .accessibilityIdentifier("usage.sheet")
    }

    private func card(_ provider: AgentKind) -> some View {
        let usage = environment.usage.usage[provider]
        let accent = AgentTokens.accent(for: provider.rawValue)
        return VStack(alignment: .leading, spacing: metrics.size(14)) {
            HStack(spacing: metrics.size(9)) {
                AgentLogo(agent: provider.rawValue, size: 16)
                    .frame(width: metrics.size(26), height: metrics.size(26))
                    .background(theme[accent].opacity(0.14), in: RoundedRectangle(cornerRadius: metrics.size(7)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(7)).strokeBorder(theme[accent].opacity(0.26), lineWidth: metrics.size(1)))
                Text(verbatim: AgentLabels.name(for: provider.rawValue)).font(metrics.font(size: 13.5, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
                Button { Task { await environment.usage.refresh([provider]) } } label: {
                    Image(systemName: "arrow.clockwise").resizable().scaledToFit()
                        .frame(width: metrics.size(12), height: metrics.size(12))
                }.buttonStyle(AletheIconButtonStyle(side: 24)).help(Text("cost.refresh"))
            }
            if let plan = usage?.plan {
                Text(verbatim: plan.lowercased()).font(metrics.monoFont(size: 9.5))
                    .foregroundStyle(theme[.textTertiary])
            }
            switch usage?.status {
            case .ready?:
                ForEach(usage?.windows ?? []) { window in
                    VStack(spacing: metrics.size(7)) {
                        HStack(alignment: .firstTextBaseline, spacing: metrics.size(8)) {
                            Text(verbatim: window.label).font(metrics.font(size: 11.5)).foregroundStyle(theme[.textSecondary])
                            Spacer(minLength: 0)
                            Text(verbatim: "\(Int(window.usedPercent.rounded()))%")
                                .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                        }
                        GeometryReader { geometry in
                            RoundedRectangle(cornerRadius: metrics.size(3)).fill(theme[.bgElevated])
                            RoundedRectangle(cornerRadius: metrics.size(3))
                                .fill(theme[window.usedPercent >= 80 ? .statusOffline : window.usedPercent >= 50 ? .statusWaiting : accent])
                                .frame(width: geometry.size.width * min(1, max(0, window.usedPercent / 100)))
                        }.frame(height: metrics.size(6))
                        if let reset = window.resetsAt {
                            HStack(spacing: metrics.size(4)) {
                                Text("usage.resets"); Text(reset, style: .relative)
                                Spacer(minLength: 0)
                            }.font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint])
                        }
                    }
                }
                if let credits = usage?.resetCredits, !credits.isEmpty {
                    resetCreditBox(count: credits.count)
                }
            case .noCLI?: Text("usage.noCLI").font(metrics.font(size: 12))
            case .noAuth?: Text("usage.noAuth").font(metrics.font(size: 12))
            case .unavailable(let reason)?: Text(verbatim: String(format: String(localized: "usage.unavailable"), reason)).font(metrics.font(size: 12))
            case nil: ProgressView().controlSize(.small)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(13))
        .frame(maxWidth: .infinity, minHeight: metrics.size(244), alignment: .topLeading)
        .background(theme[.bg].opacity(0.82), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.borderSubtle], lineWidth: metrics.size(1)))
    }

    /// `HomeView.module.css` resetCreditBox: opens the nested credit dialog.
    private func resetCreditBox(count: Int) -> some View {
        HStack(spacing: metrics.size(8)) {
            Text("usage.web.credit.heading").font(metrics.font(size: 12, weight: .semibold))
                .foregroundStyle(theme[.fgMuted])
            Spacer(minLength: 0)
            Button {
                Task {
                    _ = await WebDialogCenter.shared.present(width: 560) { finish in ResetCreditWebModal(finish: finish) }
                }
            } label: {
                Text(verbatim: format("usage.web.credit.box", count))
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(6))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("usage.credit.open")
        }
        .padding(.top, metrics.size(10))
        .overlay(alignment: .top) { theme[.borderSubtle].frame(height: metrics.size(1)) }
        .padding(.top, metrics.size(3))
    }

    private func pill(_ provider: AgentKind) -> Binding<Bool> {
        let item = ToolbarItemKind.usagePill(for: provider.rawValue)
        return Binding {
            item.map { environment.preferences?.document.showsToolbarItem($0) == true } ?? false
        } set: { value in
            guard let item else { return }
            environment.preferences?.update { $0.setToolbarItem(item, shown: value) }
        }
    }
}
