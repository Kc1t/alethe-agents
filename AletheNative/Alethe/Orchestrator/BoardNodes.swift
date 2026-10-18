import AletheDesign
import AletheModel
import AletheOrchestrator
import ImageIO
import SwiftUI

/// The node cards on the board canvas (upstream `PlannerNode`, `RunNode`, `WorkerNode`,
/// `MediaCardNode`). Every size goes through `BoardUnits`, so the cards zoom with the canvas.
private struct BoardCard<Content: View>: View {
    let units: BoardUnits
    var fill: ThemeToken = .bgElevated
    var border: ThemeToken = .border
    var selected = false
    @ViewBuilder let content: Content
    @Environment(\.theme) private var theme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: units.radius(.md))
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[fill], in: shape)
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(theme[selected ? .accentBorder : border], lineWidth: selected ? 2 : 1)
            }
    }
}

/// A small upper-case label over a card's title (upstream `plannerKind`, `runKind`).
private struct Eyebrow: View {
    let text: LocalizedStringKey
    let units: BoardUnits
    @Environment(\.theme) private var theme

    var body: some View {
        Text(text)
            .textCase(.uppercase)
            .tracking(units.size(1.2))
            .font(units.font(.caption).weight(.medium))
            .foregroundStyle(theme[.textTertiary])
            .lineLimit(1)
    }
}

struct BoardPlannerNode: View {
    let group: PlannerGroup
    /// The tab this planner ran in is closed.
    let isGone: Bool
    let units: BoardUnits
    let onReveal: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        BoardCard(units: units, border: .borderStrong) {
            Button(action: onReveal) {
                HStack(spacing: units.space(.m)) {
                    BoardAgentGlyph(agent: group.agent, size: units.size(17))
                    VStack(alignment: .leading, spacing: units.size(2)) {
                        Eyebrow(text: "orchestrator.plannerEyebrow", units: units)
                        name
                            .font(units.font(.body).weight(.semibold))
                            .foregroundStyle(theme[.textPrimary])
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text(verbatim: String(format: String(localized: "orchestrator.runCount"), group.runs.count))
                        .font(units.font(.caption))
                        .monospacedDigit()
                        .foregroundStyle(theme[.textTertiary])
                }
                .padding(.horizontal, units.space(.l))
                .padding(.vertical, units.space(.m))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isGone || group.id == nil)
            .help(Text(isGone ? LocalizedStringKey("orchestrator.plannerGone") : "orchestrator.plannerNodeTitle"))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("orchestrator.node.planner")
    }

    private var name: Text {
        guard let label = group.label else { return Text("orchestrator.noPlanner") }
        return Text(verbatim: label)
    }
}

struct BoardRunNode: View {
    let run: BoardRun
    let units: BoardUnits
    let onClick: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let fill: ThemeToken = switch run.state {
        case .failed: .statusOfflineSoft
        case .blocked: .statusWaitingSoft
        default: .bgElevated
        }
        BoardCard(units: units, fill: fill, border: .borderStrong) {
            Button(action: onClick) {
                VStack(alignment: .leading, spacing: units.space(.s)) {
                    HStack(spacing: units.space(.m)) {
                        BoardLaneDot(lane: run.state, size: units.size(7))
                        Eyebrow(text: "orchestrator.runEyebrow", units: units)
                        Spacer(minLength: 0)
                        Text(run.state.title)
                            .textCase(.uppercase)
                            .font(units.font(.caption).weight(run.state == .blocked ? .bold : .medium))
                            .foregroundStyle(theme[run.state == .queued || run.state == .finished ? .textTertiary : run.state.token])
                            .lineLimit(1)
                            .help(run.state.explanation.map { Text($0) } ?? Text(verbatim: ""))
                    }
                    Text(verbatim: run.label)
                        .font(units.font(.body).weight(.semibold))
                        .foregroundStyle(theme[.textPrimary])
                        .lineLimit(1)
                    HStack(spacing: units.space(.m)) {
                        Text(verbatim: String(format: String(localized: "orchestrator.workerCount"), run.jobs.count))
                        if run.counts[.blocked] > 0 {
                            Text(verbatim: RunAttention(lane: .blocked, count: run.counts[.blocked]).text)
                                .font(units.font(.caption).weight(.semibold))
                                .foregroundStyle(theme[.bg])
                                .padding(.horizontal, units.space(.xs))
                                .background(theme[.statusWaiting], in: RoundedRectangle(cornerRadius: units.radius(.sm)))
                                .help(Text("orchestrator.blockedTitle"))
                        }
                        Spacer(minLength: 0)
                        Text(verbatim: String(format: String(localized: "orchestrator.runDone"),
                                              run.counts[.finished], run.jobs.count))
                            .foregroundStyle(theme[.textSecondary])
                    }
                    .font(units.font(.caption))
                    .monospacedDigit()
                    .foregroundStyle(theme[.textTertiary])
                }
                .padding(.horizontal, units.space(.l))
                .padding(.vertical, units.space(.l))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(Text("orchestrator.runNodeTitle"))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("orchestrator.node.run.\(run.id)")
    }
}

struct BoardWorkerNode: View {
    let job: JobSnapshot
    let selected: Bool
    let elapsed: Double?
    let units: BoardUnits
    let project: ProjectID
    let board: OrchestratorBoardModel
    let onSelect: () -> Void
    let onOpenMedia: (MediaItem) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let lane = RunLane(job.status)
        let fill: ThemeToken = switch job.status {
        case .failed: .statusOfflineSoft
        case .blocked: .statusWaitingSoft
        default: .bgElevated
        }
        let share = BoardFormat.contextShare(job)
        BoardCard(units: units, fill: fill, border: lane == .finished ? .borderSubtle : .border, selected: selected) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: onSelect) { card(lane: lane, share: share) }
                    .buttonStyle(.plain)
                    .help(Text(verbatim: job.spec))
                    .accessibilityIdentifier("orchestrator.worker.\(job.id).card")
                if job.status == .failed, let outcome = job.outcome, !outcome.isEmpty {
                    Text(verbatim: outcome)
                        .font(units.font(.caption))
                        .foregroundStyle(theme[.statusOffline])
                        .lineLimit(2)
                        .padding(.horizontal, units.space(.l))
                        .padding(.bottom, units.space(.s))
                        .help(Text(verbatim: outcome))
                }
                if selected {
                    BoardWorkerDetail(job: job, units: units, project: project, board: board, onOpenMedia: onOpenMedia)
                }
                if let share {
                    GeometryReader { proxy in
                        Rectangle()
                            .fill(theme[share >= 80 ? .statusWaiting : .accent])
                            .frame(width: proxy.size.width * CGFloat(share) / 100)
                    }
                    .frame(height: max(1, units.size(2)))
                    .background(theme[.borderSubtle])
                    .accessibilityHidden(true)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.node.worker.\(job.id)")
    }

    private func card(lane: RunLane, share: Int?) -> some View {
        VStack(alignment: .leading, spacing: units.space(.s)) {
            HStack(spacing: units.space(.s)) {
                BoardAgentGlyph(agent: job.agent, size: units.size(15))
                BoardLaneDot(lane: lane, size: units.size(7))
                Text(verbatim: job.id)
                    .font(units.font(.footnote).weight(.semibold).monospaced())
                    .foregroundStyle(theme[.textPrimary])
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let elapsed = BoardFormat.elapsed(elapsed) {
                    Text(verbatim: elapsed)
                        .font(units.font(.caption))
                        .monospacedDigit()
                        .foregroundStyle(theme[lane == .finished || lane == .queued ? .textTertiary : lane.token])
                }
            }
            let live = BoardFormat.latestLine(job.summary).isEmpty ? BoardFormat.latestLine(job.spec) : BoardFormat.latestLine(job.summary)
            if !live.isEmpty {
                Text(verbatim: live)
                    .font(units.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            meta(lane: lane, share: share)
        }
        .padding(.horizontal, units.space(.l))
        .padding(.vertical, units.space(.m))
        .contentShape(Rectangle())
    }

    private func meta(lane: RunLane, share: Int?) -> some View {
        let tokens = BoardFormat.tokens(BoardFormat.totalTokens(job))
        let cost = job.costUSD.map(SessionCostView.dollars) ?? (tokens != nil ? String(localized: "orchestrator.noPrice") : nil)
        return FlowLayout(spacing: units.space(.xs), lineSpacing: units.space(.xs), leading: true) {
            Text(job.status.title)
                .font(units.font(.caption).weight(.medium))
                .foregroundStyle(theme[lane == .finished || lane == .queued || lane == .running ? .textSecondary : lane.token])
                .help(lane.explanation.map { Text($0) } ?? Text(verbatim: ""))
            if let share {
                BoardChip(text: String(format: String(localized: "orchestrator.contextChip"), share),
                          help: String(format: String(localized: "orchestrator.contextTitle"), share), units: units)
            }
            if let tokens {
                BoardChip(text: tokens, help: String(localized: "orchestrator.tokensTitle"), units: units)
            }
            if let cost {
                BoardChip(text: cost, help: String(localized: "orchestrator.costTitle"), units: units)
            }
            if let worktree = job.worktree {
                BoardChip(text: String(localized: "orchestrator.isolated"), symbol: "arrow.triangle.branch",
                          help: worktree, units: units)
            }
            if job.hasDiff {
                BoardChip(text: String(localized: "orchestrator.hasDiff"), units: units)
            }
        }
    }
}

/// The selected worker's detail (upstream `WorkerNode`'s `detail`): its plan, its last report or
/// the live reply's tail, the routing note, the media the report points at, and the actions P6-15
/// and P6-16 add.
struct BoardWorkerDetail: View {
    let job: JobSnapshot
    let units: BoardUnits
    let project: ProjectID
    let board: OrchestratorBoardModel
    let onOpenMedia: (MediaItem) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let plan = job.plan.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let report = job.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: units.space(.s)) {
            if !plan.isEmpty {
                label("orchestrator.planLabel")
                VStack(alignment: .leading, spacing: units.space(.xxs)) {
                    ForEach(Array(plan.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .firstTextBaseline, spacing: units.space(.xs)) {
                            Text(verbatim: "\(index + 1).").monospacedDigit().foregroundStyle(theme[.textTertiary])
                            Text(verbatim: step).foregroundStyle(theme[.textSecondary])
                        }
                    }
                }
                .font(units.font(.footnote))
            }
            label(job.status == .running ? "orchestrator.liveLabel" : "orchestrator.summaryLabel")
            if report.isEmpty {
                Text("orchestrator.noReport")
                    .font(units.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
            } else {
                Text(Self.markdown(report))
                    .font(units.font(.footnote))
                    .foregroundStyle(theme[.textPrimary])
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("orchestrator.worker.\(job.id).report")
            }
            if let routing = routingNote {
                Text(verbatim: routing)
                    .font(units.font(.caption))
                    .foregroundStyle(theme[.textTertiary])
                    .accessibilityIdentifier("orchestrator.worker.\(job.id).routing")
            }
            let media = BoardMedia.remaining(job.summary)
            if !media.isEmpty {
                VStack(alignment: .leading, spacing: units.space(.xxs)) {
                    ForEach(media, id: \.value) { item in
                        Button { onOpenMedia(item) } label: {
                            HStack(spacing: units.space(.xs)) {
                                Image(systemName: item.kind == .link ? "globe" : "photo")
                                Text(verbatim: item.kind == .link ? item.value : (item.value as NSString).lastPathComponent)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .font(units.font(.caption))
                            .foregroundStyle(theme[.accent])
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(Text(verbatim: item.value))
                    }
                }
            }
            // Worker actions (P6-15) and applying its worktree (P6-16) plug in here.
            OrchestrationShortcuts(job: job, project: project)
            OrchestratorWorkerActions(job: job, project: project, board: board, units: units)
            OrchestratorApplyAction(job: job, project: project, board: board, units: units)
        }
        .padding(.horizontal, units.space(.l))
        .padding(.vertical, units.space(.m))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.bgSunken])
        .overlay(alignment: .top) { Rectangle().fill(theme[.borderSubtle]).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.worker.\(job.id).detail")
    }

    private func label(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .textCase(.uppercase)
            .tracking(units.size(1))
            .font(units.font(.caption).weight(.medium))
            .foregroundStyle(theme[.textTertiary])
    }

    /// Why this worker runs on its agent, when one side was running out as it spawned.
    private var routingNote: String? {
        guard let object = job.routing?.objectValue else { return nil }
        let verdict = object["verdict"]?.stringValue ?? ""
        return BoardText.routing(verdict: verdict, agent: object["agent"]?.stringValue ?? "",
                                 window: object["window"]?.stringValue ?? "", used: object["used"]?.doubleValue ?? 0)
    }

    /// Inline Markdown only: a report is a worker's prose, not a document.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

enum BoardText {
    /// `chosen · codex 5h 92%` (upstream `routingChosen`/`routingIgnored`).
    static func routing(verdict: String, agent: String, window: String, used: Double) -> String {
        let key: String.LocalizationValue = verdict == "ignored" ? "orchestrator.routingIgnored" : "orchestrator.routingChosen"
        let percent = used == used.rounded() ? String(Int(used)) : String(used)
        return String(format: String(localized: key), agent, window, percent)
    }
}

/// A worker's promoted image in its own card below it (upstream `MediaCardNode`).
struct BoardMediaNode: View {
    let jobID: String
    let item: MediaItem
    let units: BoardUnits
    let onOpen: () -> Void
    @Environment(\.theme) private var theme
    @State private var thumbnail: BoardThumbnail?

    var body: some View {
        BoardCard(units: units) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 0) {
                    preview
                        .frame(maxWidth: .infinity)
                        .frame(height: units.size(140))
                        .background(theme[.bgSunken])
                        .clipped()
                    Text(verbatim: (item.value as NSString).lastPathComponent)
                        .font(units.font(.caption))
                        .foregroundStyle(theme[.textSecondary])
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.horizontal, units.space(.m))
                        .padding(.vertical, units.space(.s))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(Text(verbatim: item.value))
        }
        .task(id: item.value) {
            guard item.kind == .imageLocal else { return }
            thumbnail = await BoardThumbnail.load(path: item.value)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("orchestrator.node.media.\(jobID)")
    }

    @ViewBuilder private var preview: some View {
        switch item.kind {
        case .imageLocal:
            if let thumbnail {
                Image(decorative: thumbnail.image, scale: 1).resizable().scaledToFill()
            } else {
                Image(systemName: "photo").foregroundStyle(theme[.textTertiary])
            }
        case .imageURL:
            AsyncImage(url: URL(string: item.value)) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Image(systemName: "photo").foregroundStyle(theme[.textTertiary])
            }
        case .link:
            Image(systemName: "globe").foregroundStyle(theme[.textTertiary])
        }
    }
}

/// A local image decoded off the main thread at card size.
struct BoardThumbnail: @unchecked Sendable {
    let image: CGImage

    static func load(path: String) async -> BoardThumbnail? {
        let expanded = (path as NSString).expandingTildeInPath
        return await Task.detached(priority: .utility) { () -> BoardThumbnail? in
            guard let source = CGImageSourceCreateWithURL(URL(filePath: expanded) as CFURL, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 640,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map(BoardThumbnail.init)
        }.value
    }
}
