import AletheDesign
import AletheOrchestrator
import AlethePluginKit
import SwiftUI

/// Native-only queue; web styling follows the adjacent Agents panel's cards and typography.
struct QueueView: View {
    static let tabID = "promptQueue"
    static let tab = SidebarTabContribution(id: tabID, title: "Queue", symbol: "list.bullet.rectangle",
                                            side: .right, viewID: tabID)
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var queue: PromptQueue?
    @State private var items: [QueueItem] = []
    @State private var persistenceFailed = false
    @State private var fitnessSession = UUID()
    @State private var dropTarget: String?

    var body: some View {
        VStack(spacing: 0) {
            if metrics.isWebInterface {
                WebSidebarHeader(trailing: 8) {
                    Image(systemName: "list.bullet.rectangle").resizable().scaledToFit()
                        .frame(width: metrics.size(15), height: metrics.size(15))
                    Text("queue.title")
                    Spacer(minLength: 0)
                }
            } else {
                HStack {
                    Label("queue.title", systemImage: "list.bullet.rectangle").font(metrics.font(.headline))
                    Spacer(minLength: 0)
                }.padding(metrics.space(.s))
            }
            if persistenceFailed {
                Text("queue.persistenceError").font(metrics.font(size: 11))
                    .foregroundStyle(theme[.statusOffline]).padding(metrics.size(8))
            }
            if items.isEmpty {
                if metrics.isWebInterface {
                    WebSidebarEmpty(title: "queue.empty", detail: "queue.emptyDetail", symbol: "list.bullet.rectangle")
                } else {
                    ContentUnavailableView {
                        Label("queue.empty", systemImage: "list.bullet.rectangle")
                    } description: { Text("queue.emptyDetail") }
                }
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    ScrollView {
                        LazyVStack(spacing: metrics.size(6)) {
                            ForEach(items) { item in
                                row(item, now: context.date)
                                    .modifier(AletheSidebarDropIndicator(targeted: dropTarget == item.id))
                                    .draggable(item.id)
                                    .dropDestination(for: String.self) { ids, _ in
                                        defer { dropTarget = nil }
                                        guard let dragged = ids.first, dragged != item.id,
                                              items.contains(where: { $0.id == dragged }) else { return false }
                                        var order = items.map(\.id).filter { $0 != dragged }
                                        guard let target = order.firstIndex(of: item.id) else { return false }
                                        order.insert(dragged, at: target)
                                        Task { await queue?.reorder(order) }
                                        return true
                                    } isTargeted: { targeted in
                                        if targeted { dropTarget = item.id }
                                        else if dropTarget == item.id { dropTarget = nil }
                                    }
                            }
                        }.padding(metrics.size(8))
                    }
                }
            }
        }
        .accessibilityIdentifier("queue.panel")
        .onAppear { OrchestratorQuotaFeed.shared.open(fitnessSession, environment: environment) }
        .onDisappear { OrchestratorQuotaFeed.shared.close(fitnessSession) }
        .task {
            guard let core = await environment.orchestrator.prepared() else { return }
            let prompts = await core.promptQueue()
            queue = prompts
            await prompts.tick()
            for await snapshot in await prompts.snapshots() {
                items = snapshot
                persistenceFailed = await prompts.persistenceError != nil
            }
        }
    }

    private func row(_ item: QueueItem, now: Date) -> some View {
        HStack(alignment: .top, spacing: metrics.size(8)) {
            AgentLogo(agent: item.agent, size: 16)
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                Text(verbatim: item.label ?? item.prompt.split(separator: "\n").first.map(String.init) ?? item.id)
                    .font(metrics.font(size: 11, weight: .semibold)).foregroundStyle(theme[.fg]).lineLimit(1)
                HStack(spacing: metrics.size(6)) {
                    Text(stateTitle(item.state))
                    if let date = item.resetsAt {
                        if let countdown = QuotaWarning.countdown(to: date, now: now) {
                            Text(verbatim: countdown).monospacedDigit()
                        } else { Text("queue.now") }
                    }
                    if case .afterJob(let id) = item.release, item.state.pending {
                        Text(verbatim: id).lineLimit(1)
                    }
                }
                .font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            }
            Spacer(minLength: 0)
        }
        .padding(metrics.size(8))
        .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .contentShape(Rectangle())
        .modifier(AletheSidebarRowHover())
        .contextMenu {
            Button {
                Task { await queue?.runNow([item.id]) }
            } label: { Label("queue.runNow", systemImage: "play.fill") }
                .disabled(!item.state.pending)
            Button(role: .destructive) {
                Task { await queue?.cancel([item.id]) }
            } label: { Label("queue.cancel", systemImage: "xmark") }
                .disabled(!canCancel(item.state))
        }
        .accessibilityIdentifier("queue.item.\(item.id)")
        .accessibilityAction(named: Text("queue.runNow")) { Task { await queue?.runNow([item.id]) } }
        .accessibilityAction(named: Text("queue.cancel")) { Task { await queue?.cancel([item.id]) } }
    }

    private func canCancel(_ state: QueueItem.State) -> Bool {
        if case .running = state { return true }
        return state.pending
    }

    private func stateTitle(_ state: QueueItem.State) -> LocalizedStringKey {
        switch state {
        case .queued: "queue.state.queued"
        case .waitingLimit: "queue.state.waitingLimit"
        case .running: "queue.state.running"
        case .done: "queue.state.done"
        case .failed: "queue.state.failed"
        case .cancelled: "queue.state.cancelled"
        }
    }
}
