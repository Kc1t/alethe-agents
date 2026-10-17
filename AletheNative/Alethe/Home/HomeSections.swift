import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

// MARK: - Usage

/// Home's usage strip (upstream `UsageStrip`): each provider's windows. Providers without a toolbar pill
/// are only read after usage access is enabled in preferences.
struct UsageStrip: View {
    var homeActivityDays: Binding<[ActivityDays.Day]>?
    var webContainerWidth: CGFloat?
    @State private var activityDays: [ActivityDays.Day] = []
    @State private var contentWidth: CGFloat = 0
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack {
                HomeSectionHeader(title: "home.usage")
                Spacer()
                Button {
                    Task { await environment.usage.refresh(UsageMonitor.providers) }
                } label: { Image(systemName: "arrow.clockwise").webProfileSized(14) }
                    .buttonStyle(.borderless)
                    .help(Text("home.refresh"))
                    .accessibilityLabel(Text("home.refresh"))
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

    private var webBody: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            HomeSectionHeader(title: "home.web.usageActivity").accessibilityIdentifier("home.usage.details")
            LazyVGrid(columns: webColumns, alignment: .leading, spacing: metrics.size(6)) {
                ForEach([AgentKind.claude, .codex], id: \.self) { webCard($0) }
                ActivityGraph(days: homeActivityDays ?? $activityDays)
            }
            .padding(metrics.size(6))
            .background(theme[.bgSunken].opacity(0.72), in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
        .task { await environment.usage.refresh(environment.usage.shownProviders) }
    }

    private var webColumns: [GridItem] {
        let paneWidth = webContainerWidth ?? contentWidth
        let gap = metrics.size(6)
        if paneWidth <= metrics.size(720) { return [GridItem(.flexible())] }
        if paneWidth <= metrics.size(1100) {
            return [GridItem(.flexible(), spacing: gap), GridItem(.flexible())]
        }
        // The activity column is 1.15fr; the two provider columns are each 1fr.
        let providerWidth = max(0, contentWidth - metrics.size(24)) / 3.15
        return [GridItem(.fixed(providerWidth), spacing: gap),
                GridItem(.fixed(providerWidth), spacing: gap), GridItem(.flexible())]
    }

    private func webCard(_ provider: AgentKind) -> some View {
        WebHomeUsageCard(provider: provider)
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
                    if let reset = window.resetsAt {
                        HStack(spacing: metrics.space(.xs)) {
                            Text("home.usage.resets")
                            Text(reset, format: .relative(presentation: .named))
                        }
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textTertiary])
                    }
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
    @Binding var days: [ActivityDays.Day]
    @State private var loading = true
    nonisolated static let dayCount = 91

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack(spacing: metrics.space(.m)) {
                HomeSectionHeader(title: "home.activity")
                if !days.isEmpty {
                    Text(String(format: String(localized: "home.activity.total"), days.reduce(0) { $0 + $1.count }))
                    Label { Text(String(format: String(localized: "home.activity.streak"), ActivityDays.streak(days))) } icon: { Image(systemName: "flame").webProfileSized(14) }
                        .accessibilityIdentifier("home.activity.streak")
                }
                if let delta {
                    Text(verbatim: "\(delta >= 0 ? "▲" : "▼") \(Int(abs(delta).rounded()))%")
                        .padding(.horizontal, metrics.space(.s))
                        .padding(.vertical, metrics.space(.xxs))
                        .background(theme[.bgSunken], in: Capsule())
                        .help(Text("home.activity.delta"))
                }
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise").webProfileSized(14) }
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

    private var webBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                webHeader(detailed: true)
                webHeader(detailed: false)
            }.padding(.bottom, metrics.size(14))
            HStack(alignment: .firstTextBaseline, spacing: metrics.size(4)) {
                Text(verbatim: loading ? "—" : days.reduce(0) { $0 + $1.count }.formatted())
                    .font(metrics.monoFont(size: 28, weight: .semibold)).tracking(metrics.size(-0.56))
                Text("home.web.messages").font(metrics.monoFont(size: 16, weight: .medium))
                    .foregroundStyle(theme[.textQuaternary]).lineLimit(1)
                Spacer(minLength: 0)
                if let delta {
                    Text(verbatim: "\(delta >= 0 ? "▲" : "▼") \(Int(abs(delta).rounded()))%")
                        .font(metrics.monoFont(size: 10.5, weight: .medium))
                        .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(4))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(7))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                }
            }
            Text("home.web.lastDays").font(metrics.monoFont(size: 11)).foregroundStyle(theme[.textTertiary])
                .padding(.top, metrics.size(6))
            VStack(spacing: metrics.size(9)) {
                if loading || days.isEmpty {
                    Text(loading ? "home.bottom.activityLoading" : "home.bottom.activityEmpty")
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.textQuaternary])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(88))
                } else {
                    webGrid
                    HStack(spacing: metrics.size(3)) {
                        Spacer()
                        Text("home.activity.less")
                        ForEach(0..<5) { level in
                            RoundedRectangle(cornerRadius: metrics.size(2))
                                .fill(theme[level == 0 ? .bgElevated : .statusWorking].opacity(level == 0 ? 1 : Double(level) * 0.25))
                                .frame(width: metrics.size(8), height: metrics.size(8))
                        }
                        Text("home.activity.more")
                    }.font(metrics.font(size: 9)).foregroundStyle(theme[.textQuaternary])
                }
            }.padding(.top, metrics.size(16))
            HStack(spacing: metrics.size(6)) {
                AletheStatusDot(.statusWorking, side: 6)
                Text(String(format: String(localized: "home.activity.streak"), ActivityDays.streak(days)))
                    .accessibilityIdentifier("home.activity.streak").lineLimit(1)
                Spacer(minLength: 0)
                Text(String(format: String(localized: "home.activity.total"), days.reduce(0) { $0 + $1.count }))
                    .foregroundStyle(theme[.textQuaternary]).lineLimit(1)
            }
            .font(metrics.monoFont(size: 10.5)).foregroundStyle(theme[.textTertiary])
            .padding(.top, metrics.size(12))
            .overlay(alignment: .top) { theme[.borderSubtle].frame(height: metrics.size(1)) }
            .padding(.top, metrics.size(14))
        }
        .modifier(HomeWebCard())
        .task { await load() }
        .accessibilityElement(children: .contain).accessibilityIdentifier("home.activity")
    }

    private func webHeader(detailed: Bool) -> some View {
        HStack(spacing: metrics.size(9)) {
            HomeWebBadge(symbol: "waveform.path", token: .statusWorking)
            Text("home.activity").textCase(.lowercase).font(metrics.font(size: 13.5, weight: .medium))
                .tracking(metrics.size(-0.135)).lineLimit(1)
            if detailed {
                Text("home.web.range").font(metrics.monoFont(size: 9.5))
                    .foregroundStyle(theme[.textTertiary])
                    .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(5)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(5))
                        .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            }
            Spacer(minLength: 0)
            if detailed, !loading, !days.isEmpty {
                HStack(spacing: metrics.size(5)) {
                    AletheStatusDot(.statusWorking, side: 6)
                    Text("home.web.live").font(metrics.monoFont(size: 9.5)).foregroundStyle(theme[.textTertiary])
                }.fixedSize()
            }
            HomeBottomRefreshButton(refreshing: loading) { await load() }
        }.frame(minHeight: metrics.size(26))
    }

    private var webGrid: some View {
        let peak = days.map(\.count).max() ?? 0
        return HStack(alignment: .top, spacing: metrics.size(4)) {
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                ForEach(0..<7) { weekday in
                    Text(verbatim: weekday % 2 == 1 ? Calendar.current.shortWeekdaySymbols[weekday].lowercased() : "")
                        .font(metrics.monoFont(size: 9)).foregroundStyle(theme[.textQuaternary])
                        .frame(height: metrics.size(11))
                }
            }.padding(.trailing, metrics.size(2))
            HStack(alignment: .top, spacing: metrics.size(2)) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    VStack(spacing: metrics.size(2)) {
                        ForEach(Array(column.enumerated()), id: \.offset) { _, day in
                            if let day {
                                HomeActivityCell(level: Self.level(day.count, peak: peak))
                                    .help(Text(String(format: String(localized: "home.activity.tooltip"), day.count, day.date)))
                            } else {
                                Color.clear.frame(height: metrics.size(11))
                            }
                        }
                    }.frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(String(format: String(localized: "home.activity.summary"),
                                        days.reduce(0) { $0 + $1.count }, ActivityDays.streak(days))))
    }

    /// Compare the last seven days with the seven days immediately before them, as on the web.
    private var delta: Double? {
        guard days.count >= 14 else { return nil }
        let recent = days.suffix(7).reduce(0) { $0 + $1.count }
        let previous = days.dropLast(7).suffix(7).reduce(0) { $0 + $1.count }
        return previous == 0 ? (recent > 0 ? 100 : 0) : Double(recent - previous) / Double(previous) * 100
    }

    private var grid: some View {
        let peak = days.map(\.count).max() ?? 0
        return HStack(alignment: .top, spacing: metrics.space(.xxs)) {
            VStack(alignment: .trailing, spacing: metrics.space(.xxs)) {
                ForEach(0..<7) { weekday in
                    Text(verbatim: metrics.isWebInterface ? (weekday % 2 == 1 ? Calendar.current.shortWeekdaySymbols[weekday].lowercased() : "") : Calendar.current.shortWeekdaySymbols[weekday])
                        .font(metrics.font(size: 8))
                        .foregroundStyle(theme[.textTertiary])
                        .frame(height: metrics.size(11))
                }
            }
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
            .fill(level.map { $0 == 0 ? theme[metrics.isWebInterface ? .bgElevated : .panelHover] : theme[metrics.isWebInterface ? .statusWorking : .accent].opacity((metrics.isWebInterface ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.3, 0.5, 0.75, 1])[$0]) } ?? .clear)
            .frame(width: metrics.isWebInterface ? nil : metrics.size(11), height: metrics.size(11))
            .frame(maxWidth: metrics.isWebInterface ? .infinity : nil)
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
    @State private var contentWidth: CGFloat = 0

    var body: some View {
        let totals = summary.totals
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            HStack {
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Group {
                        if metrics.isWebInterface {
                            Text("home.time").textCase(.lowercase).font(metrics.font(size: 12, weight: .semibold))
                        } else { HomeSectionHeader(title: "home.time") }
                    }
                    Text("home.time.subtitle").font(metrics.isWebInterface ? metrics.font(size: 9) : metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
                }
                Spacer()
                Button {
                    Task { await refresh() }
                } label: { Image(systemName: "arrow.clockwise").webProfileSized(14) }
                    .buttonStyle(.borderless)
                    .help(Text("home.refresh"))
                    .accessibilityLabel(Text("home.refresh"))
                if metrics.isWebInterface {
                    HStack(spacing: metrics.size(2)) {
                        ForEach(Range.allCases) { option in
                            Button { range = option } label: {
                                Text(option.title).font(metrics.monoFont(size: 9))
                                    .padding(.horizontal, metrics.size(8)).frame(height: metrics.size(26))
                                    .foregroundStyle(theme[range == option ? .fg : .textTertiary])
                                    .background(theme[.accentSoft].opacity(range == option ? 1 : 0),
                                                in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                                        .strokeBorder(theme[.accentBorder].opacity(range == option ? 1 : 0), lineWidth: metrics.size(1)))
                            }.buttonStyle(.plain)
                        }
                    }
                    .accessibilityIdentifier("home.time.range")
                } else {
                    Picker("home.time", selection: $range) {
                        ForEach(Range.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .accessibilityIdentifier("home.time.range")
                }
            }
            (metrics.isWebInterface
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: metrics.size(7)))
                : AnyLayout(HStackLayout(alignment: .top, spacing: metrics.space(.m)))) {
                if metrics.isWebInterface {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: metrics.size(7)), count: contentWidth > metrics.size(900) ? 4 : 2), spacing: metrics.size(7)) {
                        metric("home.time.active", totals.userActiveMs,
                               detail: String(format: String(localized: "home.time.focused"), HomeFormat.duration(ms: totals.appFocusedMs)))
                        metric("home.time.agents", totals.agentWallMs,
                               detail: String(format: String(localized: "home.time.agentSum"), HomeFormat.duration(ms: totals.agentSumMs)))
                        metric("home.time.background", totals.agentBackgroundMs,
                               detail: String(format: String(localized: "home.time.parallel"), HomeFormat.duration(ms: totals.parallelMs), Int(totals.peakConcurrent)))
                        metric("home.time.idle", totals.userIdleMs,
                               detail: String(format: String(localized: "home.time.noAgent"), HomeFormat.duration(ms: totals.appOpenMs &- min(totals.agentWallMs, totals.appOpenMs))))
                    }
                } else {
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
            }
            (metrics.isWebInterface && contentWidth <= metrics.size(900)
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: metrics.size(14)))
                : AnyLayout(HStackLayout(alignment: .top, spacing: metrics.space(.xxl)))) {
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
        .modifier(HomeTimeSurface())
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
        .task(id: TaskKey(range: range, revision: environment.activity.revision)) {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.time")
    }

    private func refresh() async {
        summary = await environment.activity.currentSummary(
            dates: range.days.map { ActivityStats.lastDays($0) } ?? [])
    }

    private struct TaskKey: Hashable { var range: Range; var revision: Int }

    private func projectName(_ id: String) -> String {
        if id == ActivityStats.unassigned { return String(localized: "home.time.unassigned") }
        return environment.workspace?.document.project(ProjectID(rawValue: id))?.name ?? String(localized: "home.time.removedProject")
    }

    private func metric(_ title: LocalizedStringKey, _ ms: UInt64, detail: String) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(metrics.isWebInterface ? 4 : 2)) {
            Text(title).textCase(metrics.isWebInterface ? .uppercase : nil).font(metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)).foregroundStyle(theme[.textSecondary])
            Text(verbatim: HomeFormat.duration(ms: ms)).font(metrics.isWebInterface ? metrics.monoFont(size: 20, weight: .semibold) : metrics.font(.title2).monospacedDigit())
            Text(verbatim: detail).font(metrics.isWebInterface ? metrics.font(size: 9) : metrics.font(.caption)).foregroundStyle(theme[.textTertiary])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(metrics.size(metrics.isWebInterface ? 10 : 12))
        .background(theme[metrics.isWebInterface ? .bg : .bgSunken].opacity(metrics.isWebInterface ? 0.72 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay {
            if metrics.isWebInterface {
                RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[.borderSubtle], lineWidth: metrics.size(1))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func breakdown(_ title: LocalizedStringKey, rows: [(String, UInt64, String)]) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            Text(title).textCase(metrics.isWebInterface ? .uppercase : nil).font(metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote).weight(.medium)).foregroundStyle(theme[.textSecondary])
            if rows.isEmpty {
                Text("home.time.empty").font(metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)).foregroundStyle(theme[.textTertiary])
                    .frame(maxWidth: .infinity, alignment: metrics.isWebInterface ? .center : .leading)
                    .padding(.vertical, metrics.isWebInterface ? metrics.size(13) : 0)
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

/// HomeView.module.css `.usageCard`; kept local so native cards retain their existing style.
struct HomeWebCard: ViewModifier {
    @State private var hovered = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(13))
            .frame(maxWidth: .infinity, minHeight: metrics.size(244), maxHeight: .infinity, alignment: .topLeading)
            .background(theme[hovered ? .bgElevated : .bg].opacity(hovered ? 1 : 0.82), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[hovered ? .borderStrong : .borderSubtle], lineWidth: metrics.size(1)))
            .onHover { hovered = $0 }
            .animation(metrics.reducesMotion ? nil : Motion.animation(Motion.quick, reduceMotion: false), value: hovered)
    }
}

private struct HomeWebBadge: View {
    let symbol: String
    let token: ThemeToken
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Image(systemName: symbol).webProfileSized(15).font(metrics.font(size: 15))
            .foregroundStyle(theme[token])
            .frame(width: metrics.size(26), height: metrics.size(26))
            .background(theme[token].opacity(0.14), in: RoundedRectangle(cornerRadius: metrics.size(7)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(7))
                .strokeBorder(theme[token].opacity(0.26), lineWidth: metrics.size(1)))
    }
}

private struct HomeTimeSurface: ViewModifier {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(13))
                .background(theme[.bgSunken].opacity(0.82), in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        } else { content.aletheCard() }
    }
}

private struct HomeActivityCell: View {
    let level: Int
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovered = false

    var body: some View {
        RoundedRectangle(cornerRadius: metrics.size(2))
            .fill(theme[level == 0 ? .bgElevated : .statusWorking].opacity(level == 0 ? 1 : Double(level) * 0.25))
            .frame(height: metrics.size(11))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(2))
                .strokeBorder(theme[.borderStrong].opacity(hovered ? 1 : 0), lineWidth: metrics.size(1)))
            .onHover { hovered = $0 }
    }
}
