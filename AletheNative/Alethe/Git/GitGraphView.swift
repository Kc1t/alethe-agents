import AletheDesign
import AletheGit
import AppKit
import SwiftUI

/// History tab of Git Control (P4-6; upstream `GitGraphList`): a lazily paginated commit graph,
/// the selected commit's detail and a context menu of commit actions.
struct GitGraphView: View {
    let history: GitHistoryModel
    @State private var branchTarget: String?
    @State private var branchName = ""
    @State private var hardResetTarget: String?
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if metrics.isWebInterface {
                GitGraphWebView(history: history) { menu($0) }
            } else {
                nativeBody
            }
        }
        .task { await history.reload() }
        .alert(Text("git.history.branch.title"), isPresented: Binding(get: { !metrics.isWebInterface && branchTarget != nil }, set: { if !$0 { branchTarget = nil } })) {
            TextField("git.history.branch.name", text: $branchName)
                .accessibilityIdentifier("git.history.branch.name")
            Button("git.history.branch.create") {
                if let hash = branchTarget { history.branch(branchName, at: hash) }
            }
            Button("editor.cancel", role: .cancel) {}
        }
        .confirmationDialog(Text("git.history.resetHard.title"), isPresented: Binding(get: { !metrics.isWebInterface && hardResetTarget != nil }, set: { if !$0 { hardResetTarget = nil } }),
                            presenting: hardResetTarget) { hash in
            Button("git.history.resetHard.confirm", role: .destructive) { history.reset(hash, mode: .hard) }
            Button("editor.cancel", role: .cancel) {}
        } message: { hash in
            Text(verbatim: format("git.history.resetHard.message", String(hash.prefix(7))))
        }
        .gitWebSheet(isPresented: Binding(get: { metrics.isWebInterface && branchTarget != nil },
                                         set: { if !$0 { branchTarget = nil } }), width: 440) {
            GitGraphBranchWebModal(name: $branchName) {
                if let hash = branchTarget { history.branch(branchName, at: hash) }
            }
        }
        .gitWebSheet(isPresented: Binding(get: { metrics.isWebInterface && hardResetTarget != nil },
                                         set: { if !$0 { hardResetTarget = nil } }), width: 440) {
            GitGraphResetWebModal(hash: hardResetTarget ?? "") {
                if let hash = hardResetTarget { history.reset(hash, mode: .hard) }
            }
        }
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            if let error = history.error {
                HStack(alignment: .top) {
                    Label {
                        Text(verbatim: error).textSelection(.enabled)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .font(.callout)
                    .foregroundStyle(theme[.statusStopped])
                    Spacer()
                    Button { history.dismissError() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text("git.dismissError"))
                }
                .padding(metrics.space(.m))
                .accessibilityIdentifier("git.history.error")
            }
            list
            if let hash = history.selection {
                Divider()
                detail(hash)
            }
        }
    }

    private var list: some View {
        List(selection: selectionBinding) {
            ForEach(history.rows) { row in
                GitGraphRowView(row: row)
                    .tag(row.id)
                    .listRowInsets(EdgeInsets(top: 0, leading: metrics.space(.s), bottom: 0, trailing: metrics.space(.s)))
                    .contextMenu { menu(row.commit) }
                    .onAppear {
                        if row.id == history.rows.last?.id { Task { await history.loadMore() } }
                    }
            }
            if history.loading {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            } else if history.rows.isEmpty {
                Text("git.history.empty").foregroundStyle(theme[.textSecondary])
            }
        }
        .listStyle(.inset)
        .environment(\.defaultMinListRowHeight, metrics.size(GitGraphRowView.rowHeight))
        .disabled(history.busy)
        .accessibilityIdentifier("git.history.list")
    }

    @ViewBuilder
    private func menu(_ commit: GitCommit) -> some View {
        Button("git.history.copySHA") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(commit.hash, forType: .string)
        }
        Divider()
        Button("git.history.cherryPick") { history.cherryPick(commit.hash) }
        Button("git.history.revert") { history.revert(commit.hash) }
        Button("git.history.branchFrom") {
            branchName = ""
            branchTarget = commit.hash
        }
        Divider()
        Button("git.history.resetSoft") { history.reset(commit.hash, mode: .soft) }
        Button("git.history.resetMixed") { history.reset(commit.hash, mode: .mixed) }
        Button("git.history.resetHard") { hardResetTarget = commit.hash }
    }

    private func detail(_ hash: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.space(.s)) {
                Text(verbatim: hash)
                    .font(metrics.font(.caption).monospaced())
                    .foregroundStyle(theme[.textSecondary])
                    .textSelection(.enabled)
                if let message = history.detailMessage {
                    Text(verbatim: message)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(history.detailFiles, id: \.path) { file in
                        HStack(spacing: metrics.space(.m)) {
                            Text(verbatim: badge(file.change))
                                .font(metrics.font(.caption).monospaced().weight(.semibold))
                                .foregroundStyle(theme[.textSecondary])
                                .frame(width: metrics.size(14))
                            Text(verbatim: file.path)
                                .font(metrics.font(.caption))
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(metrics.space(.l))
        }
        .frame(height: metrics.size(200))
        .accessibilityIdentifier("git.history.detail")
    }

    private func badge(_ change: GitChange) -> String { change.rawValue }

    private var selectionBinding: Binding<String?> {
        Binding { history.selection } set: { history.select($0) }
    }

    private var branchPresented: Binding<Bool> {
        Binding { branchTarget != nil } set: { if !$0 { branchTarget = nil } }
    }

    private var hardResetPresented: Binding<Bool> {
        Binding { hardResetTarget != nil } set: { if !$0 { hardResetTarget = nil } }
    }
}

/// One commit row: lanes drawn with a Canvas, ref badges, subject, author and relative date.
struct GitGraphRowView: View {
    static let rowHeight: CGFloat = 26
    static let laneWidth: CGFloat = 14
    static let maxRefs = 2

    let row: GitGraphRow
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    /// Lane colors from theme tokens; lane 0 always uses the accent.
    private static let palette: [ThemeToken] = [
        .agentClaude, .agentCodex, .agentOpencode, .agentCursor, .agentKiro,
        .agentAntigravity, .agentMimo, .agentFreebuff, .statusWaiting, .statusActive,
    ]

    private func color(lane: Int, index: Int) -> Color {
        lane == 0 ? theme[.accent] : theme[Self.palette[index % Self.palette.count]]
    }

    var body: some View {
        let lanes = CGFloat(max(row.laneCount, 1))
        HStack(spacing: metrics.space(.s)) {
            graph.frame(width: metrics.size(Self.laneWidth) * lanes, height: metrics.size(Self.rowHeight))
            refBadges
            Text(verbatim: row.commit.subject)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: metrics.space(.s))
            Text(verbatim: row.commit.authorName)
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textSecondary])
                .lineLimit(1)
            Text(row.commit.date, style: .relative)
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textSecondary])
                .lineLimit(1)
        }
        .help(Text(verbatim: "\(row.commit.hash.prefix(7)) · \(row.commit.authorName)"))
        .accessibilityIdentifier("git.history.commit.\(row.commit.hash)")
    }

    private var graph: some View {
        let lineWidth = metrics.size(1.5)
        let dot = metrics.size(7)
        return Canvas { context, size in
            let lane = size.width / CGFloat(max(row.laneCount, 1))
            let mid = size.height / 2
            func x(_ l: Int) -> CGFloat { lane * (CGFloat(l) + 0.5) }
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
                context.stroke(path, with: .color(color(lane: toward, index: edge.colorIndex)), lineWidth: lineWidth)
            }
            for edge in row.topEdges { stroke(edge, top: 0, bottom: mid, toward: edge.from) }
            for edge in row.bottomEdges { stroke(edge, top: mid, bottom: size.height, toward: edge.to) }
            let rect = CGRect(x: x(row.lane) - dot / 2, y: mid - dot / 2, width: dot, height: dot)
            let fill = color(lane: row.lane, index: row.colorIndex)
            if row.commit.isMerge {
                context.fill(Path(ellipseIn: rect), with: .color(theme[.bg]))
                context.stroke(Path(ellipseIn: rect), with: .color(fill), lineWidth: lineWidth)
            } else {
                context.fill(Path(ellipseIn: rect), with: .color(fill))
            }
        }
    }

    @ViewBuilder
    private var refBadges: some View {
        let refs = row.refs.filter { $0.kind != .head }
        ForEach(Array(refs.prefix(Self.maxRefs).enumerated()), id: \.offset) { _, ref in
            badge(ref.kind == .tag ? "tag" : "arrow.triangle.branch", ref.name, current: ref.isCurrent)
        }
        if refs.count > Self.maxRefs {
            Text(verbatim: "+\(refs.count - Self.maxRefs)")
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textSecondary])
                .help(Text(verbatim: refs.dropFirst(Self.maxRefs).map(\.name).joined(separator: ", ")))
        }
    }

    private func badge(_ symbol: String, _ name: String, current: Bool) -> some View {
        Label {
            Text(verbatim: name).lineLimit(1)
        } icon: {
            Image(systemName: symbol)
        }
        .labelStyle(.titleAndIcon)
        .font(metrics.font(.caption))
        .foregroundStyle(current ? theme[.accentOn] : theme[.accent])
        .padding(.horizontal, metrics.space(.s))
        .background(current ? theme[.accent] : theme[.accentSoft], in: Capsule())
        .fixedSize()
    }
}
