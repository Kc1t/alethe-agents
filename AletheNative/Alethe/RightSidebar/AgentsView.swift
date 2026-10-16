import AletheDesign
import AletheModel
import AletheOrchestrator
import AlethePluginKit
import SwiftUI

/// Compact worker status, sharing the board's snapshots and native subagent tracker.
struct AgentsView: View {
    static let tabID = "agents"
    static let tab = SidebarTabContribution(id: tabID, title: "Agents", symbol: "person.3", side: .right, viewID: tabID)
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.undoManager) private var undoManager

    private var planner: String? {
        guard let document = environment.workspace?.document,
              let focused = document.workspace.focusedPaneID,
              let pane = document.pane(focused)?.pane, pane.content == .terminal else { return nil }
        return pane.activeTab?.id.rawValue
    }

    private var jobs: [JobSnapshot] {
        let all = environment.orchestrator.snapshot.jobs + environment.terminals.hooks.subagents.jobs()
        let scoped = planner.map { planner in all.filter { $0.plannerID == planner } } ?? all
        let order: [JobStatus] = [.blocked, .running, .queued, .interrupted, .failed, .done, .cancelled, .released]
        return scoped.enumerated().sorted {
            let lhs = order.firstIndex(of: $0.element.status) ?? order.count
            let rhs = order.firstIndex(of: $1.element.status) ?? order.count
            return lhs == rhs ? $0.offset < $1.offset : lhs < rhs
        }.map(\.element)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(spacing: metrics.space(.s)) {
                HStack(spacing: metrics.space(.xs)) {
                    Label("rightSidebar.agents", systemImage: "person.3").font(metrics.font(.headline))
                    Text((planner == nil ? "agents.scopeAll" : "agents.scopeFocused") as LocalizedStringKey)
                        .font(metrics.font(.caption))
                    Spacer(minLength: 0)
                    Text(verbatim: format("agents.running", jobs.filter { $0.status == .running }.count))
                        .font(metrics.font(.caption))
                    ContentPaneButton(symbol: "arrow.up.left.and.arrow.down.right", label: "rightSidebar.maximize", id: "agents.maximize") {
                        guard let model = environment.workspace, let project = model.document.workspace.selectedProjectID else { return }
                        model.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
                            $0.addPane(to: project, content: .orchestrator)
                        }
                    }.disabled(environment.workspace?.document.workspace.selectedProjectID == nil)
                }.padding(metrics.space(.s))
                if jobs.isEmpty {
                    ContentUnavailableView {
                        Label("agents.empty", systemImage: "person.3")
                    } description: { Text("agents.emptyDetail") }
                } else {
                    ScrollView {
                        LazyVStack(spacing: metrics.space(.s)) {
                            ForEach(jobs) { job in AgentSidebarCard(job: job, now: context.date) }
                        }.padding(metrics.space(.s))
                    }
                }
            }
        }
        .task { _ = await environment.orchestrator.prepared() }
    }
}

private struct AgentSidebarCard: View {
    let job: JobSnapshot
    let now: Date
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var snapshotTime = Date()
    @State private var acting = false
    @State private var failure: String?


    var body: some View {
        HStack(alignment: .top, spacing: metrics.space(.s)) {
            AletheStatusDot(job.status == .running ? .statusWorking : job.status == .blocked ? .statusWaiting : job.status == .failed ? .statusStopped : .statusIdle, side: 7)
                .padding(.top, metrics.space(.xs))
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                HStack {
                    Text(verbatim: job.spec.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                        .first { !$0.isEmpty } ?? job.runLabel ?? job.id).lineLimit(2)
                    Spacer(minLength: 0)
                    if let elapsed = BoardFormat.elapsed(job.seconds.map { $0 + (job.status == .running ? max(0, now.timeIntervalSince(snapshotTime)) : 0) }) { Text(verbatim: elapsed) }
                }
                Text(verbatim: job.agent).lineLimit(1).font(metrics.font(.caption))
                HStack {
                    Text(job.status.title)
                    Spacer(minLength: 0)
                    if let cost = job.costUSD { Text(verbatim: cost.formatted(.currency(code: "USD"))) }
                }.font(metrics.font(.caption)).foregroundStyle(theme[.textSecondary])
                if job.pendingApproval != nil && !job.native {
                    HStack {
                        Button("orchestrator.answerAccept") { act(decision: "accept") }
                        Button("orchestrator.answerDecline") { act(decision: "decline") }
                    }.disabled(acting)
                }
                if WorkerActions.canCancel(job) {
                    Button("orchestrator.cancelAction", systemImage: "stop") { act(decision: nil) }
                        .disabled(acting)
                }
                if let failure { Text(verbatim: failure).foregroundStyle(theme[.statusStopped]) }
            }
        }
        .font(metrics.font(.body))
        .padding(metrics.space(.s))
        .background(theme[.surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .accessibilityIdentifier("agents.job.\(job.id)")
        .onChange(of: job) { snapshotTime = Date() }
    }

    private func act(decision: String?) {
        acting = true
        failure = nil
        Task {
            defer { acting = false }
            do {
                if let decision { _ = try await environment.orchestrator.answer(job: job.id, decision: decision) }
                else { _ = try await environment.orchestrator.cancel(job: job.id) }
            } catch { failure = error.localizedDescription }
        }
    }
}
