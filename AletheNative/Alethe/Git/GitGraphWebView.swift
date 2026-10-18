import AletheDesign
import AletheGit
import SwiftUI

/// Web Commit graph (`plugins/git-control/GitGraphList.tsx`, `GitGraphCommitDetail.tsx`,
/// `GitGraph.module.css`): a 34pt-row lane graph with a filter field, and a commit detail screen
/// that replaces the list in place (with a Back button) instead of a split panel.
struct GitGraphWebView<RowMenu: View>: View {
    static var rowHeight: CGFloat { 34 }
    static var laneWidth: CGFloat { 18 }

    let history: GitHistoryModel
    @ViewBuilder let rowMenu: (GitCommit) -> RowMenu
    @State private var search = ""
    @State private var topRow: String?
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(spacing: 0) {
            if let hash = history.selection, let commit = history.rows.first(where: { $0.id == hash })?.commit {
                GitGraphWebDetail(history: history, commit: commit)
            } else {
                searchField
                if let error = history.error {
                    Text(verbatim: error)
                        .font(metrics.font(size: 12))
                        .foregroundStyle(theme[.statusOffline])
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, metrics.size(2)).padding(.vertical, metrics.size(4))
                        .accessibilityIdentifier("git.history.error")
                }
                list
            }
        }
        .onChange(of: history.rows.count) { _, _ in
            // The selected commit vanished after a reload: back to the list (upstream `onBack`).
            if let hash = history.selection, !history.rows.contains(where: { $0.id == hash }), !history.loading {
                history.select(nil)
            }
        }
        .accessibilityIdentifier("git.history.list")
    }

    private var searchField: some View {
        HStack(spacing: metrics.size(4)) {
            Image(systemName: "magnifyingglass").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
            TextField("git.graph.searchPlaceholder", text: $search)
                .textFieldStyle(.plain)
                .font(metrics.font(size: 11))
                .foregroundStyle(theme[.fg])
                .accessibilityIdentifier("git.history.search")
        }
        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
        .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(4)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(4)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .padding(.horizontal, metrics.size(4)).padding(.bottom, metrics.size(6))
    }

    /// Lanes of the whole graph: every row starts its text at the same X.
    private var laneCount: Int { history.rows.reduce(1) { max($0, $1.laneCount) } }

    private var matches: Set<String>? {
        let query = search.lowercased().trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return nil }
        return Set(history.rows.filter { row in
            let c = row.commit
            return c.subject.lowercased().contains(query) || c.hash.lowercased().contains(query)
                || c.authorName.lowercased().contains(query)
                || c.refs.contains { GitGraphWebRefs.label($0).lowercased().contains(query) }
        }.map(\.id))
    }

    @ViewBuilder
    private var list: some View {
        let matching = matches
        if let matching, matching.isEmpty {
            Text("git.graph.noSearchResults")
                .font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
                .padding(.horizontal, metrics.size(2)).padding(.vertical, metrics.size(4))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(history.rows) { row in
                    GitGraphWebRow(row: row, laneCount: laneCount, dimmed: matching.map { !$0.contains(row.id) } ?? false)
                        .contextMenu { rowMenu(row.commit) }
                        .onTapGesture { history.select(row.id) }
                        .onAppear {
                            if row.id == history.rows.last?.id { Task { await history.loadMore() } }
                        }
                }
                if history.loading {
                    Text("git.graph.loading")
                        .font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, metrics.size(2)).padding(.vertical, metrics.size(4))
                } else if history.rows.isEmpty {
                    Text("git.history.empty")
                        .font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, metrics.size(2)).padding(.vertical, metrics.size(4))
                }
            }
            .scrollTargetLayout()
            .padding(.top, metrics.size(4)).padding(.bottom, metrics.size(8))
        }
        .scrollPosition(id: $topRow, anchor: .top)
        .scrollIndicators(.automatic)
        .disabled(history.busy)
    }
}

enum GitGraphWebRefs {
    /// The decoration text as git prints it (`%D`): `HEAD -> main`, `tag: v1`, `origin/main`.
    static func label(_ ref: GitRef) -> String {
        switch ref.kind {
        case .head: "HEAD"
        case .tag: "tag: \(ref.name)"
        default: ref.isCurrent ? "HEAD -> \(ref.name)" : ref.name
        }
    }

    /// Decorations in the web's order; a lone `HEAD` entry is folded into `HEAD -> branch`.
    static func labels(_ refs: [GitRef]) -> [GitRef] {
        let hasCurrent = refs.contains { $0.isCurrent }
        return refs.filter { !($0.kind == .head && hasCurrent) }
    }

    static func relative(_ date: Date) -> String {
        let minutes = Int((Date().timeIntervalSince(date) / 60).rounded())
        if minutes < 1 { return String(localized: "git.graph.timeNow") }
        if minutes < 60 { return String(format: String(localized: "git.graph.timeMinutes"), minutes) }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return String(format: String(localized: "git.graph.timeHours"), hours) }
        let days = Int((Double(hours) / 24).rounded())
        if days < 30 { return String(format: String(localized: "git.graph.timeDays"), days) }
        return date.formatted(date: .numeric, time: .omitted)
    }
}

/// `RefBadges`: at most two badges plus a `+N` counter.
struct GitGraphWebRefBadges: View {
    let refs: [GitRef]
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let all = GitGraphWebRefs.labels(refs)
        if !all.isEmpty {
            HStack(spacing: metrics.size(3)) {
                ForEach(Array(all.prefix(2).enumerated()), id: \.offset) { _, ref in
                    let head = ref.kind == .head || ref.isCurrent
                    Text(verbatim: GitGraphWebRefs.label(ref))
                        .font(metrics.font(size: 9.5))
                        .foregroundStyle(theme[head ? .bg : .fgMuted])
                        .lineLimit(1).truncationMode(.tail)
                        .padding(.horizontal, metrics.size(5)).padding(.vertical, metrics.size(1))
                        .background(theme[head ? .agentShell : (ref.kind == .tag ? .statusWaiting : .accentSoft)],
                                    in: RoundedRectangle(cornerRadius: metrics.size(4)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(4))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .frame(maxWidth: metrics.size(110))
                }
                if all.count > 2 {
                    Text(verbatim: "+\(all.count - 2)")
                        .font(metrics.font(size: 9, weight: .semibold))
                        .foregroundStyle(theme[.accent])
                        .padding(.horizontal, metrics.size(4)).padding(.vertical, metrics.size(1))
                        .background(theme[.accentSoft], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(4))
                            .strokeBorder(theme[.accentBorder], lineWidth: metrics.size(1)))
                        .fixedSize()
                }
            }
            .frame(maxWidth: metrics.size(160), alignment: .leading)
            .clipped()
            .fixedSize(horizontal: true, vertical: false)
            .help(Text(verbatim: all.map(GitGraphWebRefs.label).joined(separator: "\n")))
        }
    }
}

private struct GitGraphWebRow: View {
    let row: GitGraphRow
    let laneCount: Int
    let dimmed: Bool
    @State private var hovering = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    /// `LANE_COLOR_VARS` (lane 0 is always `--status-working`).
    private static let palette: [ThemeToken] = [
        .agentClaude, .agentCodex, .agentOpencode, .agentFreebuff, .agentMimo, .agentAntigravity,
        .agentKiro, .agentCursor, .agentKimi, .agentGrok, .agentCodewhale,
    ]

    private func color(lane: Int, index: Int) -> Color {
        lane == 0 ? theme[.statusWorking] : theme[Self.palette[index % Self.palette.count]]
    }

    var body: some View {
        HStack(spacing: metrics.size(8)) {
            graph
                .frame(width: metrics.size(GitGraphWebView<EmptyView>.laneWidth) * CGFloat(laneCount),
                       height: metrics.size(GitGraphWebView<EmptyView>.rowHeight))
                .padding(.trailing, metrics.size(2))
            HStack(spacing: metrics.size(6)) {
                Text(verbatim: row.commit.subject)
                    .font(metrics.font(size: 11, weight: .medium))
                    .foregroundStyle(theme[.fg])
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                GitGraphWebRefBadges(refs: row.commit.refs)
                Text(verbatim: "\(row.commit.authorName) · \(GitGraphWebRefs.relative(row.commit.date))")
                    .font(metrics.font(size: 10))
                    .foregroundStyle(theme[.fgFaint])
                    .lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, metrics.size(6))
        .frame(height: metrics.size(GitGraphWebView<EmptyView>.rowHeight))
        .background(theme[.panelHover].opacity(hovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.size(4)))
        .opacity(dimmed ? 0.35 : 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .help(Text(verbatim: "\(row.commit.hash.prefix(10)) — \(row.commit.subject)"))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("git.history.commit.\(row.commit.hash)")
    }

    private var graph: some View {
        let mainWidth = metrics.size(3), sideWidth = metrics.size(2)
        let radius = metrics.size(row.lane == 0 ? 6.5 : 5)
        return Canvas { context, size in
            let lane = metrics.size(GitGraphWebView<EmptyView>.laneWidth)
            let mid = size.height / 2
            func x(_ l: Int) -> CGFloat { lane * CGFloat(l) + lane / 2 }
            func stroke(_ edge: GitGraphEdge, top: CGFloat, bottom: CGFloat, toward: Int) {
                var path = Path()
                let start = CGPoint(x: x(edge.from), y: top)
                let end = CGPoint(x: x(edge.to), y: bottom)
                path.move(to: start)
                if edge.from == edge.to {
                    path.addLine(to: end)
                } else {
                    let c = (top + bottom) / 2
                    path.addCurve(to: end, control1: CGPoint(x: start.x, y: c), control2: CGPoint(x: end.x, y: c))
                }
                context.stroke(path, with: .color(color(lane: toward, index: edge.colorIndex)),
                               style: StrokeStyle(lineWidth: toward == 0 ? mainWidth : sideWidth, lineCap: .round))
            }
            for edge in row.topEdges { stroke(edge, top: 0, bottom: mid, toward: edge.from) }
            if !row.isLastRow {
                for edge in row.bottomEdges { stroke(edge, top: mid, bottom: size.height, toward: edge.to) }
            }
            let rect = CGRect(x: x(row.lane) - radius, y: mid - radius, width: radius * 2, height: radius * 2)
            context.fill(Path(ellipseIn: rect), with: .color(color(lane: row.lane, index: row.colorIndex)))
            context.stroke(Path(ellipseIn: rect), with: .color(theme[.bg]), lineWidth: metrics.size(2))
        }
    }
}

/// `GitGraphCommitDetail`: the full message and changed files of one commit, with Back.
private struct GitGraphWebDetail: View {
    let history: GitHistoryModel
    let commit: GitCommit
    @State private var backHover = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.size(8)) {
                Button { history.select(nil) } label: {
                    HStack(spacing: metrics.size(5)) {
                        Image(systemName: "arrow.left").font(metrics.font(size: 13))
                        Text("git.graph.back").font(metrics.font(size: 11))
                    }
                    .foregroundStyle(theme[backHover ? .fg : .fgMuted])
                    .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(3))
                    .background(theme[backHover ? .panelHover : .panel], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(4))
                        .strokeBorder(theme[backHover ? .borderStrong : .border], lineWidth: metrics.size(1)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { backHover = $0 }
                .accessibilityIdentifier("git.history.back")
                HStack(spacing: metrics.size(6)) {
                    Text(verbatim: String(commit.hash.prefix(10)))
                        .font(metrics.monoFont(size: 12, weight: .semibold))
                        .foregroundStyle(theme[.fg])
                        .textSelection(.enabled)
                    GitGraphWebRefBadges(refs: commit.refs)
                }
                Text(verbatim: "\(commit.authorName) · \(GitGraphWebRefs.relative(commit.date))")
                    .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                if let error = history.error {
                    Text(verbatim: error).font(metrics.font(size: 12)).foregroundStyle(theme[.statusOffline])
                }
                Group {
                    if let message = history.detailMessage {
                        Text(verbatim: message)
                    } else {
                        Text("git.graph.detail.loadingMessage")
                    }
                }
                .font(metrics.font(size: 12))
                .lineSpacing(metrics.size(3))
                .foregroundStyle(theme[.fg])
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(metrics.size(8))
                .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                .overlay(RoundedRectangle(cornerRadius: metrics.size(4)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .accessibilityIdentifier("git.history.detail")
                Text("git.graph.detail.filesTitle")
                    .font(metrics.font(size: 11, weight: .semibold))
                    .tracking(metrics.size(0.44))
                    .textCase(.uppercase)
                    .foregroundStyle(theme[.fgMuted])
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    if history.detailMessage == nil {
                        note("git.graph.filesLoading")
                    } else if history.detailFiles.isEmpty {
                        note("git.graph.filesEmpty")
                    } else {
                        ForEach(history.detailFiles, id: \.path) { file in
                            HStack(spacing: metrics.size(8)) {
                                Text(verbatim: file.change.rawValue)
                                    .font(metrics.font(size: 10, weight: .bold))
                                    .foregroundStyle(theme[.fgFaint])
                                    .frame(width: metrics.size(14))
                                Text(verbatim: file.path)
                                    .font(metrics.font(size: 12))
                                    .foregroundStyle(theme[.fgMuted])
                                    .lineLimit(1).truncationMode(.tail)
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, metrics.size(2))
                            .help(Text(verbatim: file.path))
                        }
                    }
                }
            }
            .padding(.horizontal, metrics.size(6)).padding(.top, metrics.size(4)).padding(.bottom, metrics.size(10))
        }
    }

    private func note(_ key: LocalizedStringKey) -> some View {
        Text(key).font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
            .padding(.vertical, metrics.size(2))
    }
}
