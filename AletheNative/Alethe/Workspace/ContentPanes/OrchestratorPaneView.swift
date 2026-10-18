import AletheAgents
import AletheDesign
import AletheModel
import AletheOrchestrator
import SwiftUI

/// Orchestrator board pane (upstream `OrchestratorPane/index.tsx`): the planners of this project as
/// tabs, the open planner's runs and workers on the canvas, and the summary rail, live from the
/// orchestrator service plus the planners' own subagents. With the orchestrator feature off it says
/// so and offers to turn it on, since an imported or restored board can outlive the feature.
struct OrchestratorPaneView: View {
    let project: ProjectID
    let isFocused: Bool
    let onClose: () -> Void
    let onDrag: (CGSize?) -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.openWindow) private var openWindow
    @Environment(\.contentPaneID) private var paneID
    @Environment(\.detachedOrchestration) private var detached
    @State private var board = OrchestratorBoardModel()

    private var isOn: Bool { environment.features.isOn(.orchestrator) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Group {
                if !isOn {
                    featureOff
                } else if board.isReady, board.groups.isEmpty {
                    emptyState
                } else {
                    content
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme[.bg])
        .task(id: isOn) {
            // The core is prepared on first use: opening a board is a use.
            if isOn { _ = await environment.orchestrator.prepared() }
        }
        .onChange(of: inputs, initial: true) { _, inputs in
            board.update(source(inputs))
        }
        .onChange(of: metrics.reducesMotion, initial: true) { _, reduces in
            board.reducesMotion = reduces
        }
        .onAppear { board.resume() }
        .onDisappear { board.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.pane")
    }

    // MARK: Inputs

    /// Everything the board derives from, except the clock: a new value re-derives off main.
    private struct Inputs: Equatable {
        var snapshot: OrchestratorSnapshot
        var subagents: [NativeSubagent]
        var costs: [String: SessionCost]
        var projectTabs: Set<String>
        var openTabs: Set<String>
        var folder: String
    }

    private var inputs: Inputs {
        let tracker = environment.terminals.hooks.subagents
        let projects = environment.workspace?.document.projects ?? []
        let current = projects.first { $0.id == project }
        return Inputs(
            snapshot: environment.orchestrator.snapshot,
            subagents: isOn ? tracker.nodes : [],
            costs: isOn ? tracker.costs : [:],
            projectTabs: Set(current?.panes.flatMap(\.tabs).map(\.id.rawValue) ?? []),
            openTabs: Set(projects.flatMap(\.panes).flatMap(\.tabs).map(\.id.rawValue)),
            folder: current?.folder ?? ""
        )
    }

    private func source(_ inputs: Inputs) -> BoardSource {
        let native = environment.terminals.hooks.subagents.jobs()
        return BoardSource(
            jobs: inputs.subagents.isEmpty ? inputs.snapshot.jobs : inputs.snapshot.jobs + native,
            planners: inputs.snapshot.planners,
            projectTabs: inputs.projectTabs,
            openTabs: inputs.openTabs,
            folder: inputs.folder
        )
    }

    // MARK: Planners

    /// The planner's tab, when it is still open anywhere.
    private func plannerTab(_ id: String?) -> PaneTab? {
        guard let id else { return nil }
        return environment.workspace?.document.projects.lazy.flatMap(\.panes).flatMap(\.tabs)
            .first { $0.id.rawValue == id }
    }

    /// The live tab name when the tab is open, else what the planner registered with.
    private func label(_ group: PlannerGroup) -> String? {
        guard group.id != nil else { return nil }
        if let tab = plannerTab(group.id) { return environment.terminals.displayName(of: tab) }
        return group.label
    }

    private func isGone(_ group: PlannerGroup) -> Bool {
        guard let id = group.id else { return false }
        return plannerTab(id) == nil
    }

    /// Shows the planner's terminal tab (upstream `revealPlanner`).
    private func reveal(_ group: PlannerGroup) {
        guard let tab = plannerTab(group.id) else { return }
        environment.showingHome = false
        environment.workspace?.update { $0.activateTab(tab.id) }
    }

    /// A local image opens in an image pane, anything else in a web pane.
    private func open(_ item: MediaItem) {
        switch item.kind {
        case .imageLocal:
            environment.open(.image(path: (item.value as NSString).expandingTildeInPath), in: project)
        case .imageURL, .link:
            environment.open(.web(url: item.value, options: WebPaneOptions()), in: project)
        }
    }

    // MARK: Layout

    private var header: some View {
        HStack(spacing: metrics.space(.s)) {
            Image(systemName: "flowchart")
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textSecondary])
            Text("orchestrator.title")
                .font(metrics.font(.footnote).weight(.medium))
                .foregroundStyle(theme[isFocused ? .textPrimary : .textSecondary])
                .lineLimit(1)
            Spacer(minLength: 0)
            if isOn {
                counts
            }
            if metrics.isWebInterface && !detached, let paneID {
                ContentPaneButton(symbol: "macwindow", label: "orchestrator.openInWindow", id: "orchestrator.openInWindow", webSize: 22, webIconSize: 14) {
                    openWindow(id: "orchestration", value: DetachedBoardID(profile: environment.profileID, pane: paneID))
                }
            }
            ContentPaneButton(symbol: "xmark", label: "orchestrator.close", id: "pane.close", action: onClose)
        }
        .padding(.horizontal, metrics.space(.m))
        .frame(height: metrics.size(28))
        .background(theme[isFocused ? .bgElevated : .bgSunken])
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 4, coordinateSpace: .global)
                .onChanged { onDrag($0.translation) }
                .onEnded { _ in onDrag(nil) }
        )
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
    }

    /// Upstream `counts`: the open planner's spend (P6-17), what waits on the person anywhere on
    /// this board, and the core's slots.
    private var counts: some View {
        let snapshot = environment.orchestrator.snapshot
        let blocked = board.visibleJobs.filter { $0.status == .blocked }.count
        let interrupted = board.visibleJobs.filter { $0.status == .interrupted }.count
        return HStack(spacing: metrics.space(.m)) {
            OrchestratorSpendHeader(jobs: board.activeGroup?.jobs ?? [])
            if blocked > 0 {
                Text(verbatim: RunAttention(lane: .blocked, count: blocked).text)
                    .font(metrics.font(.caption).weight(.semibold))
                    .foregroundStyle(theme[.bg])
                    .padding(.horizontal, metrics.space(.xs))
                    .background(theme[.statusWaiting], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .help(Text("orchestrator.blockedTitle"))
            }
            if interrupted > 0 {
                Text(verbatim: RunAttention(lane: .interrupted, count: interrupted).text)
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.statusWaiting])
                    .help(Text("orchestrator.interruptedTitle"))
            }
            Group {
                Text(verbatim: String(format: String(localized: "orchestrator.running"), snapshot.running))
                Text(verbatim: String(format: String(localized: "orchestrator.queued"), snapshot.queued))
                Text(verbatim: String(format: String(localized: "orchestrator.limit"), snapshot.concurrencyLimit))
            }
            .font(metrics.font(.caption))
            .monospacedDigit()
            .foregroundStyle(theme[.textTertiary])
        }
        .lineLimit(1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.counts")
    }

    @ViewBuilder private var content: some View {
        if let group = board.activeGroup {
            VStack(spacing: 0) {
                BoardPlannerTabs(board: board, label: label, isGone: isGone,
                                 onAddPlanner: { environment.editorRequest = .newTerminal(project) })
                HStack(spacing: 0) {
                    BoardCanvasView(board: board, group: group, plannerGone: isGone(group), project: project,
                                    onRevealPlanner: { reveal(group) }, onOpenMedia: open)
                    BoardRail(board: board, snapshot: environment.orchestrator.snapshot,
                              plannerName: label(group), label: label)
                }
            }
        } else {
            // The first derivation has not landed yet.
            theme[.bgSunken]
        }
    }

    private var emptyState: some View {
        VStack(spacing: metrics.space(.s)) {
            Image(systemName: "flowchart")
                .font(metrics.font(.title2))
                .foregroundStyle(theme[.textTertiary])
            Text("orchestrator.empty.title")
                .font(metrics.font(.body).weight(.medium))
                .foregroundStyle(theme[.textPrimary])
            Text("orchestrator.empty.detail")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
        }
        .multilineTextAlignment(.center)
        .padding(metrics.space(.xl))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("orchestrator.empty")
    }

    private var featureOff: some View {
        VStack(spacing: metrics.space(.m)) {
            Text("orchestrator.featureOff")
                .font(metrics.font(.body))
                .foregroundStyle(theme[.textSecondary])
            Button("orchestrator.turnOn") {
                environment.preferences?.update { $0.features.set(.orchestrator, on: true) }
            }
            .accessibilityIdentifier("orchestrator.turnOn")
        }
        .multilineTextAlignment(.center)
        .padding(metrics.space(.xl))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.featureOff")
    }
}
