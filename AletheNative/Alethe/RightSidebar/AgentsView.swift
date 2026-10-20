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
    @Environment(\.theme) private var theme
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
            VStack(spacing: metrics.isWebInterface ? 0 : metrics.space(.s)) {
                if metrics.isWebInterface {
                    WebSidebarHeader(trailing: 8) {
                        Image(systemName: "cpu").resizable().scaledToFit()
                            .frame(width: metrics.size(15), height: metrics.size(15))
                        Text("rightSidebar.agents").lineLimit(1)
                        Text((planner == nil ? "rightSidebar.agents.scopeAll" : "rightSidebar.agents.scopeFocused") as LocalizedStringKey)
                            .lineLimit(1).fixedSize()
                            .font(metrics.font(size: 9, weight: .semibold))
                            .foregroundStyle(theme[.fgMuted])
                            .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                            .overlay(Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        if jobs.contains(where: { $0.status == .running }) {
                            Text(verbatim: format("agents.running", jobs.filter { $0.status == .running }.count))
                                .font(metrics.font(size: 10, weight: .semibold)).foregroundStyle(theme[.statusWorking])
                        }
                        Spacer(minLength: 0)
                        Button {
                            guard let model = environment.workspace, let project = model.document.workspace.selectedProjectID else {
                                return
                            }
                            model.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
                                $0.addPane(to: project, content: .orchestrator)
                            }
                        } label: {
                            Label("rightSidebar.maximize", systemImage: "arrow.up.left.and.arrow.down.right").font(metrics.font(size: 13))
                        }
                        .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 24, height: 22))
                        .help(Text("rightSidebar.web.agentsExpand"))
                        .accessibilityIdentifier("agents.maximize")
                        .disabled(environment.workspace?.document.workspace.selectedProjectID == nil)
                    }
                } else { nativeHeader }
                if jobs.isEmpty {
                    if metrics.isWebInterface {
                        WebSidebarEmpty(title: "rightSidebar.agents.empty", detail: "rightSidebar.agents.emptyDetail", symbol: "cpu")
                    } else {
                        ContentUnavailableView {
                            Label("agents.empty", systemImage: "person.3")
                        } description: { Text("agents.emptyDetail") }
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: metrics.isWebInterface ? metrics.size(6) : metrics.space(.s)) {
                            ForEach(jobs) { job in AgentSidebarCard(job: job, now: context.date) }
                        }.padding(metrics.isWebInterface ? metrics.size(8) : metrics.space(.s))
                    }
                }
            }
        }
        .task { _ = await environment.orchestrator.prepared() }
    }

    private var nativeHeader: some View {
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
        Group {
            if metrics.isWebInterface {
                webCard
            } else {
                nativeCard
            }
        }
    }

    private var nativeCard: some View {
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

    private var webCard: some View {
        HStack(alignment: .top, spacing: metrics.size(8)) {
            Circle()
                .fill(theme[statusToken].opacity(job.status == .interrupted ? 0 : 1))
                .frame(width: metrics.size(8), height: metrics.size(8))
                .overlay {
                    if job.status == .interrupted {
                        Circle().strokeBorder(theme[.statusWaiting], lineWidth: metrics.size(1.5))
                    } else if job.status == .blocked {
                        Circle().stroke(theme[.statusWaitingSoft], lineWidth: metrics.size(2))
                            .padding(-metrics.size(1))
                    }
                }
                .padding(.top, metrics.size(4)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                HStack(alignment: .firstTextBaseline, spacing: metrics.size(6)) {
                    Text(
                        verbatim: job.spec.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                            .first { !$0.isEmpty } ?? job.runLabel ?? job.id
                    )
                    .font(metrics.font(size: 11, weight: .semibold)).lineLimit(1).help(job.spec)
                    Spacer(minLength: 0)
                    if let elapsed = BoardFormat.elapsed(
                        job.seconds.map { $0 + (job.status == .running ? max(0, now.timeIntervalSince(snapshotTime)) : 0) })
                    {
                        Text(verbatim: elapsed).monospacedDigit().fixedSize().font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                    }
                }
                HStack(spacing: metrics.size(6)) {
                    Text(verbatim: job.agent).font(metrics.font(size: 10, weight: .semibold)).lineLimit(1)
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                        .overlay(Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    Text(job.status.title).lineLimit(1)
                        .font(metrics.font(size: 10, weight: job.status == .blocked ? .bold : .regular)).foregroundStyle(
                        theme[job.status == .blocked ? .statusWaiting : job.status == .failed ? .statusOffline : .fgMuted])
                    Spacer(minLength: 0)
                    if let cost = job.costUSD { Text(verbatim: cost.formatted(.currency(code: "USD"))).foregroundStyle(theme[.fgFaint]) }
                }.font(metrics.font(size: 10))
                if job.pendingApproval != nil && !job.native {
                    HStack(spacing: metrics.size(6)) {
                        Button { act(decision: "accept") } label: {
                            Label("orchestrator.answerAccept", systemImage: "checkmark").font(metrics.font(size: 10, weight: .semibold))
                        }
                        Button { act(decision: "decline") } label: {
                            Label("orchestrator.answerDecline", systemImage: "xmark").font(metrics.font(size: 10, weight: .semibold))
                        }
                    }.buttonStyle(AlethePanelActionStyle(approval: true)).disabled(acting)
                }
                if let failure { Text(verbatim: failure).foregroundStyle(theme[.statusOffline]) }
            }
            if WorkerActions.canCancel(job) && !job.native {
                Button {
                    act(decision: nil)
                } label: {
                    Label("orchestrator.cancelAction", systemImage: "stop").font(metrics.font(size: 11))
                }
                .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 24, height: 22)).disabled(acting)
                .help(Text("orchestrator.cancelAction"))
            }
        }
        .foregroundStyle(theme[.fg])
        .padding(metrics.size(8))
        .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityIdentifier("agents.job.\(job.id)")
        .onChange(of: job) { snapshotTime = Date() }
    }

    private var statusToken: ThemeToken {
        switch job.status {
        case .running: .statusWorking
        case .blocked, .queued, .interrupted: .statusWaiting
        case .failed: .statusOffline
        default: .statusStopped
        }
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
