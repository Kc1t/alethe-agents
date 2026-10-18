import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// Tokens and cost of one agent session (upstream `get_session_cost`): totals, then one row per
/// model. Claude Code is priced from the table; OpenCode reports its own cost; Codex has tokens only.
struct SessionCostView: View {
    let cost: SessionCost?
    let loading: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if loading {
            ProgressView().controlSize(.small)
        } else if let cost, cost.totalTokens > 0 {
            VStack(alignment: .leading, spacing: metrics.space(.s)) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: cost.costUSD.map(Self.dollars) ?? String(localized: "cost.unpriced"))
                        .font(metrics.font(.title3).monospacedDigit())
                        .accessibilityIdentifier("cost.total")
                    Text(String(format: String(localized: "cost.tokens"), Self.tokens(cost.totalTokens)))
                        .foregroundStyle(theme[.textSecondary])
                }
                Grid(alignment: .trailing, horizontalSpacing: metrics.space(.l), verticalSpacing: metrics.space(.xxs)) {
                    GridRow {
                        Text("cost.model").gridColumnAlignment(.leading)
                        Text("cost.input")
                        Text("cost.output")
                        Text("cost.cacheRead")
                        Text("cost.cacheWrite")
                        Text("cost.cost")
                    }
                    .font(metrics.font(.caption).weight(.semibold))
                    .foregroundStyle(theme[.textTertiary])
                    ForEach(cost.byModel) { model in
                        GridRow {
                            Text(verbatim: model.model).lineLimit(1)
                            Text(verbatim: Self.tokens(model.input))
                            Text(verbatim: Self.tokens(model.output))
                            Text(verbatim: Self.tokens(model.cacheRead))
                            Text(verbatim: Self.tokens(model.cacheWrite5m + model.cacheWrite1h))
                            Text(verbatim: model.costUSD.map(Self.dollars) ?? "—")
                        }
                        .font(metrics.font(.footnote).monospacedDigit())
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("cost")
        } else {
            Text("cost.none")
                .foregroundStyle(theme[.textTertiary])
                .accessibilityIdentifier("cost.none")
        }
    }

    static func dollars(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(value < 1 ? 3 : 2)))
    }

    static func tokens(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName))
    }
}

/// Session Cost… for a tab (Terminal menu, pane menu).
struct SessionCostSheet: View {
    let workspace: WorkspaceModel
    let tabID: TabID
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.metrics) private var metrics
    @State private var cost: SessionCost?
    @State private var loading = true

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text("menu.terminal.sessionCost")
        } content: {
            VStack(alignment: .leading, spacing: metrics.space(.l)) {
                if let (project, pane) = workspace.document.paneHolding(tabID),
                   let tab = pane.tabs.first(where: { $0.id == tabID }) {
                    Text(verbatim: "\(tab.title ?? AgentLabels.name(for: tab.agent)) · \(project.name)")
                    ScrollView(.horizontal) { SessionCostView(cost: cost, loading: loading) }
                        .fixedSize(horizontal: false, vertical: true).webScrollStyle()
                }
            }
        } footer: {
            Spacer()
            Button("cost.refresh") { Task { await load() } }
            Button("agentInstall.done", action: dismiss).keyboardShortcut(.defaultAction)
        }
        .task { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sessionCost")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            if let (project, pane) = workspace.document.paneHolding(tabID),
               let tab = pane.tabs.first(where: { $0.id == tabID }) {
                Text(verbatim: "\(tab.title ?? AgentLabels.name(for: tab.agent)) · \(project.name)")
                    .font(metrics.font(.headline))
                SessionCostView(cost: cost, loading: loading)
            }
            HStack {
                Spacer()
                Button("cost.refresh") { Task { await load() } }
                Button("agentInstall.done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(metrics.space(.xl))
        .frame(minWidth: metrics.size(520))
        .task { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sessionCost")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        guard let (project, pane) = workspace.document.paneHolding(tabID),
              let tab = pane.tabs.first(where: { $0.id == tabID }), let session = tab.sessionID else {
            cost = nil
            return
        }
        let kind = AgentKind(rawValue: tab.agent)
        let cwd = tab.workingDirectory ?? project.folder
        let openCode = environment.launchers.resolve("opencode", override: environment.preferences?.document.cliPaths?["opencode"])
        cost = await Task.detached { await SessionCosts.cost(kind, sessionID: session, cwd: cwd, openCodeExecutable: openCode) }.value
    }
}
