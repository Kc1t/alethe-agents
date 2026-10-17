import AletheDesign
import AletheModel
import SwiftUI

extension Notification.Name {
    static let aletheOpenTitleBarMemory = Notification.Name("alethe.openTitleBarMemory")
}

struct WebTitleBarMemoryPill: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        let available = environment.resources.system.availableMB
        let pressure: ThemeToken = available < 512 ? .statusOffline : available < 1024 ? .statusWorking : available < 2048 ? .statusWaiting : .borderStrong
        Button { NotificationCenter.default.post(name: .aletheOpenTitleBarMemory, object: nil) } label: {
            Text(verbatim: String(format: "%.0f MB", environment.resources.appMB + environment.resources.terminalsMB))
                .font(metrics.monoFont(size: 11)).monospacedDigit()
                .foregroundStyle(theme[hovering ? .fg : .fgMuted])
                .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(2))
                .frame(minHeight: metrics.size(22))
                .background(theme[available < 256 ? .statusOfflineSoft : .bgSunken].opacity(metrics.style == .clean ? 0 : 1),
                            in: RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 8)))
                .overlay(RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 8))
                    .strokeBorder(theme[hovering ? .borderStrong : pressure].opacity(metrics.style == .clean || (!hovering && available >= 2048) ? 0 : 1), lineWidth: metrics.size(1)))
        }
        .buttonStyle(.plain).fixedSize().onHover { hovering = $0 }
        .help(Text("titlebar.memory.open"))
        .accessibilityLabel(Text(verbatim: String(format: String(localized: "memory.indicator.accessibility"), MemoryIndicator.format(environment.resources.appMB + environment.resources.terminalsMB))))
        .accessibilityIdentifier("memory.indicator")
    }
}

/// MemoryAnalyticsModal: native process totals and terminal rows, without synthetic history samples.
struct WebTitleBarMemory: View {
    let close: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        WebTitleBarAnalytics(title: "titlebar.memory.title", close: close) {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(145)), spacing: metrics.size(8))], spacing: metrics.size(8)) {
                    metric("memory.app", "desktopcomputer", environment.resources.appMB)
                    metric("memory.terminals", "terminal", environment.resources.terminalsMB)
                }
                VStack(alignment: .leading, spacing: metrics.size(10)) {
                    HStack(spacing: metrics.size(12)) {
                        Image(systemName: "checkmark.circle").resizable().scaledToFit()
                            .frame(width: metrics.size(18), height: metrics.size(18))
                        Text(environment.resources.pressure.title).font(metrics.font(size: 13, weight: 650))
                        Spacer()
                    }.foregroundStyle(theme[environment.resources.pressure.token])
                    Text(verbatim: String(format: String(localized: "memory.available"), MemoryIndicator.format(environment.resources.system.availableMB), MemoryIndicator.format(environment.resources.system.totalMB)))
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
                .padding(metrics.size(12)).modifier(AletheTitleBarSurface())
                if environment.resources.terminals.isEmpty {
                    Text("memory.noTerminals").font(metrics.font(size: 12))
                        .foregroundStyle(theme[.fgMuted]).frame(maxWidth: .infinity, minHeight: metrics.size(90))
                }
                VStack(spacing: metrics.size(6)) {
                    ForEach(environment.resources.terminals) { usage in
                        HStack(spacing: metrics.size(10)) {
                            Text(verbatim: terminalName(usage.tab)).lineLimit(1)
                            Spacer()
                            Text(verbatim: String(format: "%.0f MB", usage.memoryMB))
                        }
                        .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                        .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(9))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    }
                }
                ResourcePolicyPicker().font(metrics.font(size: 12))
                Button("memory.settings") {
                    close()
                    environment.settingsTab = .resources
                    openSettings()
                }.buttonStyle(AletheButtonStyle())
            }
        }
        .accessibilityIdentifier("memory.details")
    }

    private func metric(_ title: LocalizedStringKey, _ symbol: String, _ value: Double) -> some View {
        HStack(spacing: metrics.size(8)) {
            Image(systemName: symbol).resizable().scaledToFit()
                .frame(width: metrics.size(18), height: metrics.size(18)).foregroundStyle(theme[.fgMuted])
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Text(title).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                Text(verbatim: String(format: "%.0f MB", value)).font(metrics.monoFont(size: 14, weight: .bold))
            }
            Spacer(minLength: 0)
        }
        .padding(metrics.size(10))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private func terminalName(_ tab: AletheModel.TabID) -> String {
        guard let (project, pane) = environment.workspace?.document.paneHolding(tab),
              let item = pane.tabs.first(where: { $0.id == tab }) else { return tab.rawValue }
        return "\(item.title ?? AgentLabels.name(for: item.agent)) · \(project.name)"
    }
}
