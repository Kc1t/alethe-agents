import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// Live PTYs with known sessions, polled at the web HUD's four-second interval.
struct TokenHud: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var collapsed = false
    @State private var pillHovered = false
    @State private var collapseHovered = false
    @State private var entries: [Entry] = []

    private struct Entry: Identifiable, Sendable {
        var id: TabID
        var agent: String
        var session: String
        var cwd: String
        var cost: SessionCost?
    }

    private var live: [Entry] {
        (environment.workspace?.document.projects ?? []).flatMap { project in
            project.panes.flatMap { pane in
                pane.tabs.compactMap { tab -> Entry? in
                    guard ["claude", "codex", "opencode"].contains(tab.agent),
                          environment.terminals.states[tab.id] == .running, let session = tab.sessionID else { return nil }
                    return Entry(id: tab.id, agent: tab.agent, session: session,
                                 cwd: tab.workingDirectory ?? project.folder)
                }
            }
        }
    }

    private var total: Double { entries.compactMap { $0.cost?.costUSD }.reduce(0, +) }

    var body: some View {
        Group {
            if !entries.isEmpty {
                if collapsed { pill } else { panel }
            }
        }
        .task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(4)) } catch { break }
            }
        }
        .accessibilityIdentifier("tokenHud")
    }

    private var panel: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(6)) {
                Image(systemName: "dollarsign.circle").webProfileSized(13)
                Text("hud.title").font(metrics.font(size: 12, weight: .semibold))
                Spacer(minLength: 0)
                Button { collapsed = true } label: { Image(systemName: "chevron.down").webProfileSized(14) }
                    .buttonStyle(.plain)
                    .frame(width: metrics.size(22), height: metrics.size(22))
                    .background(theme[.panelHover].opacity(collapseHovered ? 1 : 0))
                    .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .onHover { collapseHovered = $0 }
                    .accessibilityLabel(Text("hud.collapse"))
                    .help(Text("hud.collapse"))
            }
            .foregroundStyle(theme[.fgMuted])
            .padding(.vertical, metrics.size(8)).padding(.horizontal, metrics.size(10))
            rule
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(entries) { entry in row(entry) }
                }.padding(metrics.size(4))
            }
            .webScrollStyle()
            .frame(height: min(metrics.size(260), metrics.size(CGFloat(entries.count) * 39 + 8)))
            rule
            HStack {
                Text("hud.total").foregroundStyle(theme[.fgMuted])
                Spacer(minLength: 0)
                Text(verbatim: dollars(total)).fontWeight(.bold).foregroundStyle(costColor(total))
            }
            .font(metrics.font(size: 12))
            .padding(.vertical, metrics.size(8)).padding(.horizontal, metrics.size(10))
        }
        .frame(width: metrics.size(280))
        .background(theme[.panel])
        .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay { RoundedRectangle(cornerRadius: metrics.radius(.md)).stroke(theme[.border], lineWidth: metrics.size(1)) }
        .shadow(color: theme.shadow(.lg).color.color, radius: metrics.size(theme.shadow(.lg).blur / 2),
                x: metrics.size(theme.shadow(.lg).x), y: metrics.size(theme.shadow(.lg).y))
        .accessibilityLabel(Text("hud.title"))
    }

    private var pill: some View {
        Button { collapsed = false } label: {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "dollarsign.circle").webProfileSized(13)
                Text(verbatim: dollars(total)).font(metrics.font(size: 12, weight: .bold)).foregroundStyle(costColor(total))
                Text(verbatim: String(format: String(localized: "hud.agentsRunning"), entries.count))
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
            }
            .padding(.vertical, metrics.size(7)).padding(.horizontal, metrics.size(11))
            .background(theme[.panel])
            .clipShape(RoundedRectangle(cornerRadius: pillRadius))
            .overlay { RoundedRectangle(cornerRadius: pillRadius).stroke(theme[pillHovered ? .borderStrong : .border], lineWidth: metrics.size(1)) }
        }
        .buttonStyle(.plain).foregroundStyle(theme[.fgMuted])
        .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(theme.shadow(.md).blur / 2),
                x: metrics.size(theme.shadow(.md).x), y: metrics.size(theme.shadow(.md).y))
        .onHover { pillHovered = $0 }
        .accessibilityLabel(Text("hud.expand")).help(Text("hud.expand"))
    }

    private var pillRadius: CGFloat { metrics.style == .clean ? metrics.size(4) : metrics.size(999) }
    private var rule: some View { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }

    private func row(_ entry: Entry) -> some View {
        HStack(spacing: metrics.size(8)) {
            AgentLogo(agent: entry.agent, size: 14)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: (entry.cwd as NSString).lastPathComponent.isEmpty ? entry.cwd : (entry.cwd as NSString).lastPathComponent)
                    .font(metrics.font(size: 12, weight: .semibold)).foregroundStyle(theme[.fg]).lineLimit(1)
                Text(verbatim: "\(entry.cost?.model ?? entry.agent) · \(tokens(entry.cost?.totalTokens ?? 0)) \(String(localized: "hud.tokens"))")
                    .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint]).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(verbatim: entry.cost?.costUSD.map(dollars) ?? String(localized: "hud.noCost"))
                .font(metrics.font(size: 12, weight: .semibold))
                .foregroundStyle(entry.cost?.costUSD.map(costColor) ?? theme[.fgFaint])
        }
        .padding(metrics.size(6))
        .frame(minHeight: metrics.style == .clean ? metrics.size(30) : nil)
        .modifier(TokenHudRowHover())
    }

    private func costColor(_ value: Double) -> Color {
        theme[value >= 5 ? .statusStopped : value >= 1 ? .statusWaiting : .accent]
    }

    private func dollars(_ value: Double) -> String { String(format: value < 1 ? "$%.4f" : "$%.2f", value) }
    private func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return String(value)
    }

    private func refresh() async {
        let sessions = live
        let executable = environment.launchers.resolve("opencode", override: environment.preferences?.document.cliPaths?["opencode"])
        let fresh = await withTaskGroup(of: Entry.self, returning: [Entry].self) { group in
            for entry in sessions {
                group.addTask {
                    var result = entry
                    result.cost = await SessionCosts.cost(AgentKind(rawValue: entry.agent), sessionID: entry.session,
                                                         cwd: entry.cwd, openCodeExecutable: executable)
                    return result
                }
            }
            var results: [Entry] = []
            for await entry in group { results.append(entry) }
            return sessions.compactMap { session in results.first { $0.id == session.id } }
        }
        guard !Task.isCancelled else { return }
        let current = live
        entries = fresh.filter { entry in current.contains { $0.id == entry.id && $0.session == entry.session } }
    }
}

private struct TokenHudRowHover: ViewModifier {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    func body(content: Content) -> some View {
        content.background(hovering ? theme[.panelHover] : theme[.panel].opacity(0))
            .clipShape(RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.sm)))
            .onHover { hovering = $0 }
    }
}
