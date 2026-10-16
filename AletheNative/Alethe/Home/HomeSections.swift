import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

// MARK: - Usage

/// Home's usage strip (upstream `UsageStrip`): each provider's windows. Providers without a toolbar pill
/// are only read on request, since reading their sign-in can make macOS ask for Keychain access.
struct UsageStrip: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack {
                HomeSectionHeader(title: "home.usage")
                Spacer()
                Button("home.usage.details") { environment.editorRequest = .aiUsage }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("home.usage.details")
            }
            HStack(alignment: .top, spacing: metrics.space(.m)) {
                ForEach(UsageMonitor.providers, id: \.self) { provider in
                    card(provider).frame(maxWidth: .infinity)
                }
            }
        }
        .task { await environment.usage.refresh(environment.usage.shownProviders) }
    }

    private func card(_ provider: AgentKind) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            Text(verbatim: AgentLabels.name(for: provider.rawValue)).font(metrics.font(.body).weight(.medium))
            if let usage = environment.usage.usage[provider], usage.status == .ready {
                ForEach(usage.windows.prefix(3)) { window in
                    HStack {
                        Text(verbatim: window.label).font(metrics.font(.footnote))
                        Spacer()
                        Text(verbatim: "\(Int(window.usedPercent.rounded()))%").font(metrics.font(.footnote).monospacedDigit())
                    }
                    ProgressView(value: min(window.usedPercent, 100), total: 100)
                        .tint(theme[UsageLevel.token(window.usedPercent)])
                }
            } else if environment.usage.refreshing.contains(provider) {
                ProgressView().controlSize(.small)
            } else if let usage = environment.usage.usage[provider] {
                Text(usage.status == .noCLI ? "usage.noCLI" : usage.status == .noAuth ? "usage.noAuth" : "home.usage.unavailable")
                    .font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
            } else {
                Button("home.usage.check") { Task { await environment.usage.refresh([provider]) } }
                    .buttonStyle(.link)
                    .font(metrics.font(.footnote))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .aletheCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.usage.\(provider.rawValue)")
    }
}

// MARK: - Activity graph

/// Messages per day over 13 weeks (upstream `ActivityGraph`), from Claude Code, Codex and OpenCode.
struct ActivityGraph: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var days: [ActivityDays.Day] = []
    @State private var loading = true
    nonisolated static let dayCount = 91

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack(spacing: metrics.space(.m)) {
                HomeSectionHeader(title: "home.activity")
                if !days.isEmpty {
                    Text(String(format: String(localized: "home.activity.total"), days.reduce(0) { $0 + $1.count }))
                    Label(String(format: String(localized: "home.activity.streak"), ActivityDays.streak(days)), systemImage: "flame")
                        .accessibilityIdentifier("home.activity.streak")
                }
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help(Text("home.refresh"))
                    .accessibilityLabel(Text("home.refresh"))
            }
            .font(metrics.font(.footnote))
            .foregroundStyle(theme[.textSecondary])
            grid
            HStack(spacing: metrics.space(.xs)) {
                Text("home.activity.days")
                Spacer()
                Text("home.activity.less")
                ForEach(0..<5) { level in cell(level) }
                Text("home.activity.more")
            }
            .font(metrics.font(.caption))
            .foregroundStyle(theme[.textTertiary])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .aletheCard()
        .task { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.activity")
    }

    private var grid: some View {
        let peak = days.map(\.count).max() ?? 0
        return HStack(alignment: .top, spacing: metrics.space(.xxs)) {
            ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                VStack(spacing: metrics.space(.xxs)) {
                    ForEach(Array(column.enumerated()), id: \.offset) { _, day in
                        if let day {
                            cell(Self.level(day.count, peak: peak))
                                .help(Text(String(format: String(localized: "home.activity.tooltip"), day.count, day.date)))
                        } else {
                            cell(nil)
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(String(format: String(localized: "home.activity.summary"),
                                        days.reduce(0) { $0 + $1.count }, ActivityDays.streak(days))))
    }

    /// Weeks as columns, weekdays as rows (Sunday first, like upstream), padded at the start.
    private var columns: [[ActivityDays.Day?]] {
        guard let first = days.first else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = ISO8601DateFormatter().date(from: first.date + "T00:00:00Z") ?? Date()
        let padding = calendar.component(.weekday, from: date) - 1
        let cells: [ActivityDays.Day?] = Array(repeating: nil, count: padding) + days.map(Optional.some)
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<min($0 + 7, cells.count)]) }
    }

    private func cell(_ level: Int?) -> some View {
        RoundedRectangle(cornerRadius: metrics.size(2))
            .fill(level.map { $0 == 0 ? theme[.panelHover] : theme[.accent].opacity([0, 0.3, 0.5, 0.75, 1][$0]) } ?? .clear)
            .frame(width: metrics.size(11), height: metrics.size(11))
    }

    static func level(_ count: Int, peak: Int) -> Int {
        guard count > 0, peak > 0 else { return 0 }
        let ratio = Double(count) / Double(peak)
        return ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
    }

    private func load() async {
        loading = true
        let executable = environment.launchers.resolve("opencode", override: environment.preferences?.document.cliPaths?["opencode"])
        let database = await SessionCosts.openCodeDatabase(executable: executable)
        days = await Task.detached(priority: .utility) {
            ActivityDays.collect(days: Self.dayCount, openCodeDatabase: database)
        }.value
        loading = false
    }
}

// MARK: - Time analytics

/// Where the time went (upstream `TimeAnalytics`), from the activity tracker (P3-14).
struct TimeAnalytics: View {
    enum Range: String, CaseIterable, Identifiable {
        case today, week, month, all
        var id: Self { self }
        var days: Int? { switch self { case .today: 1; case .week: 7; case .month: 30; case .all: nil } }
        var title: LocalizedStringKey {
            switch self {
            case .today: "home.time.today"
            case .week: "home.time.7d"
            case .month: "home.time.30d"
            case .all: "home.time.all"
            }
        }
    }

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var range = Range.today
    @State private var summary = ActivityTotals()

    var body: some View {
        let totals = summary.totals
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            HStack {
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    HomeSectionHeader(title: "home.time")
                    Text("home.time.subtitle").font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
                }
                Spacer()
                Picker("home.time", selection: $range) {
                    ForEach(Range.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("home.time.range")
            }
            HStack(alignment: .top, spacing: metrics.space(.m)) {
                metric("home.time.active", totals.userActiveMs,
                       detail: String(format: String(localized: "home.time.focused"), HomeFormat.duration(ms: totals.appFocusedMs)))
                metric("home.time.agents", totals.agentWallMs,
                       detail: String(format: String(localized: "home.time.agentSum"), HomeFormat.duration(ms: totals.agentSumMs)))
                metric("home.time.background", totals.agentBackgroundMs,
                       detail: String(format: String(localized: "home.time.parallel"), HomeFormat.duration(ms: totals.parallelMs), Int(totals.peakConcurrent)))
                metric("home.time.idle", totals.userIdleMs,
                       detail: String(format: String(localized: "home.time.noAgent"),
                                      HomeFormat.duration(ms: totals.appOpenMs &- min(totals.agentWallMs, totals.appOpenMs))))
            }
            HStack(alignment: .top, spacing: metrics.space(.xxl)) {
                breakdown("home.time.byAgent", rows: summary.agents.sorted { $0.value.workingMs > $1.value.workingMs }.map { key, value in
                    (AgentLabels.name(for: key), value.workingMs,
                     String(format: String(localized: "home.time.backgroundShort"), HomeFormat.duration(ms: value.backgroundMs)))
                })
                breakdown("home.time.byProject", rows: summary.projects
                    .sorted { $0.value.activeMs + $0.value.agentSumMs > $1.value.activeMs + $1.value.agentSumMs }
                    .prefix(5).map { key, value in
                        (projectName(key), value.activeMs + value.agentWallMs,
                         String(format: String(localized: "home.time.projectDetail"),
                                HomeFormat.duration(ms: value.activeMs), HomeFormat.duration(ms: value.agentSumMs)))
                    })
            }
            Text(String(format: String(localized: "home.time.localNote"), TimeZone.current.identifier))
                .font(metrics.font(.caption)).foregroundStyle(theme[.textTertiary])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .aletheCard()
        .task(id: TaskKey(range: range, revision: environment.activity.revision)) {
            while !Task.isCancelled {
                summary = await environment.activity.currentSummary(
                    dates: range.days.map { ActivityStats.lastDays($0) } ?? [])
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.time")
    }

    private struct TaskKey: Hashable { var range: Range; var revision: Int }

    private func projectName(_ id: String) -> String {
        if id == ActivityStats.unassigned { return String(localized: "home.time.unassigned") }
        return environment.workspace?.document.project(ProjectID(rawValue: id))?.name ?? String(localized: "home.time.removedProject")
    }

    private func metric(_ title: LocalizedStringKey, _ ms: UInt64, detail: String) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            Text(title).font(metrics.font(.footnote)).foregroundStyle(theme[.textSecondary])
            Text(verbatim: HomeFormat.duration(ms: ms)).font(metrics.font(.title2).monospacedDigit())
            Text(verbatim: detail).font(metrics.font(.caption)).foregroundStyle(theme[.textTertiary])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(metrics.space(.l))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .accessibilityElement(children: .combine)
    }

    private func breakdown(_ title: LocalizedStringKey, rows: [(String, UInt64, String)]) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            Text(title).font(metrics.font(.footnote).weight(.medium)).foregroundStyle(theme[.textSecondary])
            if rows.isEmpty {
                Text("home.time.empty").font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack {
                    Text(verbatim: row.0).lineLimit(1)
                    Spacer()
                    Text(verbatim: HomeFormat.duration(ms: row.1)).monospacedDigit()
                    Text(verbatim: row.2).foregroundStyle(theme[.textTertiary])
                }
                .font(metrics.font(.footnote))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
