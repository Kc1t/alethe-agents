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
            Text(verbatim: MemoryIndicator.pillText(count: environment.resources.aiTerminalCount,
                                                    totalMB: environment.resources.appMB + environment.resources.terminalsMB))
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
        // ramPillPulse: high pressure 1.5 s, critical 0.8 s (TitleBar.module.css).
        .webOpacityPulse(period: available < 256 ? 0.8 : 1.5, active: available < 512)
        .help(Text("titlebar.memory.open"))
        .accessibilityLabel(Text(MemoryIndicator.accessibilityText(
            memory: MemoryIndicator.format(environment.resources.appMB + environment.resources.terminalsMB),
            count: environment.resources.aiTerminalCount)))
        .accessibilityIdentifier("memory.indicator")
    }
}

/// `MemoryAnalyticsModal.tsx` / `MemoryAnalyticsModal.module.css` with real macOS readings. The
/// Windows-only working-set, private-commit and job-guard figures have no equivalent here.
struct WebTitleBarMemory: View {
    let close: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hoverIndex: Int?
    @State private var tab: MemoryTab = .overview

    private enum Level { case healthy, warning, critical }
    private var history: [ResourceMonitor.Sample] { environment.resources.history }
    private var latest: ResourceMonitor.Sample? { history.last }

    /// 10-minute window used by the average, the trend and the diagnostics.
    private var windowed: [ResourceMonitor.Sample] {
        guard let latest else { return [] }
        let recent = history.filter { latest.timestamp.timeIntervalSince($0.timestamp) <= 600 }
        return recent.count >= 2 ? recent : history
    }

    private var level: Level {
        guard let latest, latest.systemTotalMB > 0 else { return .healthy }
        if latest.systemAvailableMB <= max(512, latest.systemTotalMB * 0.05) { return .critical }
        if latest.systemAvailableMB <= max(1024, latest.systemTotalMB * 0.1) { return .warning }
        return .healthy
    }

    private var growth: Double {
        guard let first = windowed.first, let last = windowed.last, windowed.count >= 2 else { return 0 }
        return last.totalMB - first.totalMB
    }

    var body: some View {
        GitWebModal(close: close, closeIdentifier: "memory.close") {
            Text("memModal.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                tabStrip
                switch tab {
                case .overview: overview
                case .ai: aiPanel
                }
            }
        } footer: {
            Spacer(minLength: 0)
            Button { environment.resources.clearHistory() } label: {
                Label { Text("memModal.clear") } icon: { Image(systemName: "trash").font(metrics.font(size: 14)) }
                    .labelStyle(.titleAndIcon)
            }
            .disabled(history.isEmpty)
            .accessibilityIdentifier("memory.clearHistory")
        }
        .accessibilityIdentifier("memory.details")
    }

    // MARK: Tabs

    private var tabStrip: some View {
        HStack(spacing: metrics.size(4)) {
            ForEach(MemoryTab.allCases) { item in
                Button { tab = item } label: {
                    HStack(spacing: metrics.size(6)) {
                        Text(item.title)
                        if item == .ai {
                            Text(verbatim: "\(environment.resources.aiTerminalCount)")
                                .font(metrics.monoFont(size: 10, weight: .bold))
                                .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                                .background(theme[.bgSunken], in: Capsule())
                        }
                    }
                    .font(metrics.font(size: 12, weight: tab == item ? .semibold : .regular))
                    .foregroundStyle(theme[tab == item ? .fg : .fgMuted])
                    .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(6))
                    .background(tab == item ? theme[.bgSunken] : Color.clear, in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == item ? .isSelected : [])
                .accessibilityIdentifier("memory.tab.\(item.rawValue)")
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.tabs")
    }

    @ViewBuilder private var overview: some View {
        if let crash = environment.diagnostics.crashNotice { crashPanel(crash) }
        healthPanel
        summary
        historyPanel
        HStack(alignment: .top, spacing: metrics.size(12)) {
            bottlenecksPanel.frame(maxWidth: .infinity)
            compositionPanel.frame(maxWidth: .infinity)
        }
        runtimePanel
        samplesPanel
    }

    private var aiPanel: some View {
        let sessions = environment.resources.terminals.filter(\.isAgent)
        return panel {
            panelHeader("memModal.tab.ai", subtitle: format("memory.ai.header", "\(sessions.count)",
                                                           mb(sessions.reduce(0) { $0 + $1.memoryMB }))) {
                Image(systemName: "sparkles").font(metrics.font(size: 16))
            }
            AIProcessList()
        }
    }

    // MARK: Panels

    private func panel<Content: View>(border: ThemeToken = .border, tint: ThemeToken? = nil,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0, content: content)
            .padding(metrics.size(12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.map { theme[$0].opacity(0.08) } ?? theme[.bg],
                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[border], lineWidth: metrics.size(1)))
    }

    private func panelHeader<Trailing: View>(_ title: LocalizedStringKey, subtitle: String,
                                             @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .top, spacing: metrics.size(12)) {
            VStack(alignment: .leading, spacing: metrics.size(3)) {
                Text(title).font(metrics.font(size: 13, weight: 650)).foregroundStyle(theme[.fg])
                Text(verbatim: subtitle).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            trailing().foregroundStyle(theme[.fgMuted])
        }
        .padding(.bottom, metrics.size(10))
    }

    private func crashPanel(_ crash: CrashNotice) -> some View {
        panel(border: .statusOffline, tint: .statusOffline) {
            panelHeader("memModal.crash.title",
                        subtitle: format("memModal.crash.subtitle", crash.previous.startedAt.formatted(date: .abbreviated, time: .shortened))) {
                Image(systemName: "exclamationmark.triangle").font(metrics.font(size: 16))
                    .foregroundStyle(theme[.statusOffline])
            }
            Button { environment.diagnostics.openLogsFolder() } label: {
                Label { Text("memModal.openLogs") } icon: { Image(systemName: "folder").font(metrics.font(size: 14)) }
            }
            .accessibilityIdentifier("memory.openLogs")
        }
    }

    private var healthPanel: some View {
        let token: ThemeToken = switch level { case .healthy: .statusActive; case .warning: .statusWaiting; case .critical: .statusOffline }
        let title: LocalizedStringKey = switch level {
        case .healthy: "memModal.healthy.title"
        case .warning: "memModal.warning.title"
        case .critical: "memModal.critical.title"
        }
        let bodyFormat: String = switch level {
        case .healthy: String(localized: "memModal.healthy.body")
        case .warning: String(localized: "memModal.warning.body")
        case .critical: String(localized: "memModal.critical.body")
        }
        return panel(border: token, tint: token) {
            HStack(alignment: .top, spacing: metrics.size(12)) {
                VStack(alignment: .leading, spacing: metrics.size(3)) {
                    Text(title).font(metrics.font(size: 13, weight: 650)).foregroundStyle(theme[.fg])
                    if let latest {
                        Text(verbatim: String(format: bodyFormat, mb(latest.systemAvailableMB), mb(latest.systemTotalMB)))
                            .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("memModal.waiting").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: level == .healthy ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(metrics.font(size: 16)).foregroundStyle(theme[token])
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("memory.health")
    }

    private var summary: some View {
        let peak = history.map(\.totalMB).max()
        let average = windowed.isEmpty ? 0 : windowed.reduce(0) { $0 + $1.totalMB } / Double(windowed.count)
        let trendToken: ThemeToken = growth >= 120 ? .statusOffline : growth <= -80 ? .statusWorking : .fg
        return HStack(spacing: metrics.size(8)) {
            metric("memModal.now", "waveform.path.ecg", latest.map { mb($0.totalMB) } ?? "-")
            metric("memModal.peak", "display", peak.map(mb) ?? "-")
            metric("memModal.avg", "cpu", history.isEmpty ? "-" : mb(average))
            metric("memModal.trend", "square.3.layers.3d", (growth >= 0 ? "+" : "") + mb(growth), token: trendToken)
        }
    }

    private func metric(_ title: LocalizedStringKey, _ symbol: String, _ value: String, token: ThemeToken = .fg) -> some View {
        HStack(spacing: metrics.size(8)) {
            Image(systemName: symbol).font(metrics.font(size: 16)).foregroundStyle(theme[.fgMuted])
                .frame(width: metrics.size(18))
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Text(title).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted]).lineLimit(1)
                Text(verbatim: value).font(metrics.monoFont(size: 14, weight: .bold))
                    .foregroundStyle(theme[token]).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(metrics.size(10))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private var historyPanel: some View {
        panel {
            panelHeader("memModal.history", subtitle: format("memModal.historySubtitle", "\(history.count)")) {
                if let latest {
                    Text(verbatim: time(latest.timestamp)).font(metrics.monoFont(size: 11))
                }
            }
            chart
        }
    }

    /// `.chartWrap`: 150 points, three guide lines at 25/50/75 % and a smoothed total line.
    @ViewBuilder private var chart: some View {
        let samples = Array(history.suffix(90))
        if samples.count < 2 {
            Text("memModal.waitingMore").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                .frame(maxWidth: .infinity, minHeight: metrics.size(90))
        } else {
            let values = samples.map(\.totalMB)
            let low = values.min() ?? 0, high = values.max() ?? 0
            let range = max(high - low, 1)
            ZStack {
                GeometryReader { geometry in
                    let size = geometry.size
                    let points = samples.enumerated().map { index, sample in
                        CGPoint(x: CGFloat(index) / CGFloat(samples.count - 1) * size.width,
                                y: size.height - CGFloat((sample.totalMB - low) / range * 0.84 + 0.08) * size.height)
                    }
                    ForEach([0.25, 0.5, 0.75], id: \.self) { fraction in
                        theme[.border].frame(height: metrics.size(1)).offset(y: size.height * fraction)
                    }
                    MemoryChartPath(points: points, closed: true)
                        .fill(theme[.accent].opacity(0.14))
                    MemoryChartPath(points: points, closed: false)
                        .stroke(theme[.accent], style: StrokeStyle(lineWidth: metrics.size(2), lineCap: .round, lineJoin: .round))
                    if let hoverIndex, points.indices.contains(hoverIndex) {
                        Path { path in
                            path.move(to: CGPoint(x: points[hoverIndex].x, y: size.height * 0.04))
                            path.addLine(to: CGPoint(x: points[hoverIndex].x, y: size.height * 0.96))
                        }
                        .stroke(theme[.borderStrong], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(2), metrics.size(2)]))
                        Circle().fill(theme[.bgSunken])
                            .overlay(Circle().strokeBorder(theme[.accent], lineWidth: metrics.size(1.6)))
                            .frame(width: metrics.size(6), height: metrics.size(6))
                            .position(points[hoverIndex])
                    }
                    Color.clear.contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                let fraction = min(1, max(0, location.x / max(size.width, 1)))
                                hoverIndex = Int((fraction * CGFloat(samples.count - 1)).rounded())
                            case .ended: hoverIndex = nil
                            }
                        }
                    if let hoverIndex, samples.indices.contains(hoverIndex), points.indices.contains(hoverIndex) {
                        let x = min(0.9, max(0.02, points[hoverIndex].x / max(size.width, 1))) * size.width
                        VStack(spacing: metrics.size(1)) {
                            Text(verbatim: mb(samples[hoverIndex].totalMB)).font(metrics.font(size: 12, weight: .semibold))
                                .foregroundStyle(theme[.fg])
                            Text(verbatim: time(samples[hoverIndex].timestamp)).font(metrics.monoFont(size: 10))
                                .foregroundStyle(theme[.fgMuted])
                        }
                        .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(4))
                        .background(theme[.surfaceModal], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.borderAccent], lineWidth: metrics.size(1)))
                        .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(8), y: metrics.size(4))
                        .fixedSize()
                        .position(x: x, y: metrics.size(8) + metrics.size(18))
                        .allowsHitTesting(false)
                    }
                }
                VStack {
                    Text(verbatim: mb(high)); Spacer(); Text(verbatim: mb(low))
                }
                .font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgMuted])
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(8))
                .allowsHitTesting(false)
            }
            .frame(height: metrics.size(150))
            .background(theme[.bgSunken])
            .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .accessibilityIdentifier("memory.chart")
        }
    }

    private var bottlenecksPanel: some View {
        let top = dominant(latest)
        return panel {
            panelHeader("memModal.bottlenecks", subtitle: top.map { format("memModal.bottleneckLead", $0.label, mb($0.value)) }
                        ?? String(localized: "memModal.noReading")) {
                Image(systemName: "exclamationmark.triangle").font(metrics.font(size: 16))
            }
            VStack(spacing: metrics.size(6)) {
                ForEach(diagnostics, id: \.self) { item in
                    Text(verbatim: item).font(metrics.font(size: 12)).foregroundStyle(theme[.fg])
                        .lineSpacing(metrics.size(1.5))
                        .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(8))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                }
            }
        }
    }

    private var compositionPanel: some View {
        panel {
            panelHeader("memModal.composition", subtitle: latest.map { format("memModal.processes", "\($0.processCount)") }
                        ?? String(localized: "memModal.waiting")) {
                Image(systemName: "terminal").font(metrics.font(size: 16))
            }
            if let latest, latest.totalMB > 0 {
                VStack(spacing: metrics.size(10)) {
                    bucketRow("memModal.bucketApp", latest.appMB, latest.totalMB)
                    bucketRow("memModal.bucketPtys", latest.terminalsMB, latest.totalMB)
                }
            }
        }
    }

    private func bucketRow(_ title: LocalizedStringKey, _ value: Double, _ total: Double) -> some View {
        VStack(spacing: metrics.size(5)) {
            HStack {
                Text(title).foregroundStyle(theme[.fgMuted])
                Spacer()
                Text(verbatim: mb(value)).font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fg])
            }.font(metrics.font(size: 11))
            GeometryReader { geometry in
                RoundedRectangle(cornerRadius: metrics.size(4)).fill(theme[.accent])
                    .frame(width: geometry.size.width * CGFloat(max(0.02, value / total)))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: metrics.size(7))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.size(4)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(4)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        }
    }

    /// Live terminals, largest first (the web lists runtimes with their process tables).
    private var runtimePanel: some View {
        let rows = environment.resources.terminals
        return panel {
            panelHeader("memModal.runtime", subtitle: format("memModal.runtimeSubtitle", "\(rows.count)", mb(environment.resources.terminalsMB))) {
                Text(verbatim: pressureLabel).font(metrics.monoFont(size: 11)).textCase(.uppercase)
                    .padding(.horizontal, metrics.size(7)).padding(.vertical, metrics.size(4))
                    .foregroundStyle(theme[pressureToken])
                    .background(theme[.bgSunken], in: Capsule())
                    .overlay(Capsule().strokeBorder(theme[pressureToken == .fgMuted ? .border : pressureToken], lineWidth: metrics.size(1)))
            }
            VStack(spacing: metrics.size(6)) {
                if rows.isEmpty {
                    Text("memModal.noRuntimes").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(90))
                }
                ForEach(rows) { usage in
                    HStack(spacing: metrics.size(10)) {
                        Text(verbatim: terminalName(usage.tab)).foregroundStyle(theme[.fg]).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(verbatim: mb(usage.memoryMB)).foregroundStyle(theme[.fg]).fontWeight(.bold)
                    }
                    .font(metrics.monoFont(size: 11))
                    .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(9))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                }
            }
        }
    }

    private var samplesPanel: some View {
        let rows = Array(history.suffix(12).reversed())
        return panel {
            panelHeader("memModal.latest", subtitle: String(localized: "memModal.latestSubtitle")) { EmptyView() }
            VStack(spacing: 0) {
                tableRow(["memModal.colTime", "memModal.colTotal", "memModal.bucketApp", "memModal.bucketPtys", "memModal.colProc"].map {
                    Text(LocalizedStringKey($0)) }, head: true)
                if rows.isEmpty {
                    Text("memModal.waitingFirst").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(90))
                }
                ForEach(rows) { sample in
                    tableRow([Text(verbatim: time(sample.timestamp)), Text(verbatim: mb(sample.totalMB)).fontWeight(.semibold),
                              Text(verbatim: mb(sample.appMB)), Text(verbatim: mb(sample.terminalsMB)),
                              Text(verbatim: "\(sample.processCount)")], head: false)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        }
    }

    private func tableRow(_ cells: [Text], head: Bool) -> some View {
        HStack(spacing: metrics.size(8)) {
            ForEach(cells.indices, id: \.self) { index in
                cells[index].frame(maxWidth: .infinity, alignment: .leading).lineLimit(1)
            }
        }
        .font(head ? metrics.font(size: 11, weight: 650) : metrics.monoFont(size: 11))
        .foregroundStyle(theme[head ? .fg : .fgMuted])
        .padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(7))
        .background(head ? theme[.bgSunken] : Color.clear)
        .overlay(alignment: .top) { if !head { theme[.border].frame(height: metrics.size(1)) } }
    }

    // MARK: Derived

    private struct Bucket { let label: String; let value: Double; let share: Double }

    private func dominant(_ sample: ResourceMonitor.Sample?) -> Bucket? {
        guard let sample, sample.totalMB > 0 else { return nil }
        return [Bucket(label: String(localized: "memModal.bucketApp"), value: sample.appMB, share: sample.appMB / sample.totalMB),
                Bucket(label: String(localized: "memModal.bucketPtys"), value: sample.terminalsMB, share: sample.terminalsMB / sample.totalMB)]
            .max { $0.value < $1.value }
    }

    /// `buildDiagnostics` of the web modal.
    private var diagnostics: [String] {
        guard let latest else { return [String(localized: "memModal.noData")] }
        var items: [String] = []
        switch level {
        case .critical: items.append(String(localized: "memModal.diag.systemCritical"))
        case .warning: items.append(String(localized: "memModal.diag.systemWarning"))
        case .healthy: break
        }
        if growth >= 512 { items.append(format("memModal.diag.highGrowth", mb(growth))) }
        else if growth >= 256 { items.append(format("memModal.diag.moderate", mb(growth))) }
        if let first = windowed.first, let last = windowed.last, windowed.count >= 2 {
            let buckets = [(String(localized: "memModal.bucketApp"), last.appMB - first.appMB),
                           (String(localized: "memModal.bucketPtys"), last.terminalsMB - first.terminalsMB)]
            if let top = buckets.max(by: { $0.1 < $1.1 }), top.1 >= 192 {
                items.append(format("memModal.diag.bucket", top.0, mb(top.1)))
            }
        }
        if let top = dominant(latest), top.share >= 0.6 {
            items.append(format("memModal.diag.dominant", top.label, String(format: "%.0f", top.share * 100)))
        }
        if latest.processCount >= 50 { items.append(format("memModal.diag.many", "\(latest.processCount)")) }
        return items.isEmpty ? [String(localized: "memModal.diag.stable")] : items
    }

    private var pressureLabel: String {
        switch environment.resources.pressure {
        case .normal: String(localized: "memModal.pressure.normal")
        case .warning: String(localized: "memModal.pressure.warning")
        case .critical: String(localized: "memModal.pressure.critical")
        }
    }

    private var pressureToken: ThemeToken {
        switch environment.resources.pressure {
        case .normal: .fgMuted
        case .warning: .statusWaiting
        case .critical: .statusOffline
        }
    }

    private func mb(_ value: Double) -> String {
        guard value.isFinite else { return "-" }
        return String(format: abs(value) >= 100 ? "%.0f MB" : "%.1f MB", value)
    }

    private func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
    }

    private func terminalName(_ tab: AletheModel.TabID) -> String {
        guard let (project, pane) = environment.workspace?.document.paneHolding(tab),
              let item = pane.tabs.first(where: { $0.id == tab }) else { return tab.rawValue }
        return "\(item.title ?? AgentLabels.name(for: item.agent)) · \(project.name)"
    }
}

/// `smoothPath` of the web modal: a Catmull-Rom curve through the samples.
private struct MemoryChartPath: Shape {
    let points: [CGPoint]
    let closed: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard points.count >= 2 else { return path }
        path.move(to: points[0])
        if points.count == 2 {
            path.addLine(to: points[1])
        } else {
            for index in 0..<(points.count - 1) {
                let p0 = points[index == 0 ? 0 : index - 1], p1 = points[index], p2 = points[index + 1]
                let p3 = points[index + 2 < points.count ? index + 2 : index + 1]
                path.addCurve(to: p2,
                              control1: CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                              control2: CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6))
            }
        }
        if closed {
            path.addLine(to: CGPoint(x: points[points.count - 1].x, y: rect.height))
            path.addLine(to: CGPoint(x: 0, y: rect.height))
            path.closeSubpath()
        }
        return path
    }
}
