import AletheDesign
import AletheModel
import AletheTerminal
import AppKit
import SwiftUI

/// The AI terminals that are running, each with what it started below it (dev servers, language
/// servers...), their memory and listening ports, and buttons to kill a session or one child.
struct AIProcessList: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var confirming: Kill?

    private enum Kill: Identifiable {
        case session(tab: TabID, name: String, children: Int)
        case child(sessionPID: pid_t, node: ProcessNode)

        var id: String {
            switch self {
            case .session(let tab, _, _): "session.\(tab.rawValue)"
            case .child(_, let node): "child.\(node.pid)"
            }
        }
    }

    private var sessions: [ResourceMonitor.TerminalUsage] { environment.resources.terminals.filter(\.isAgent) }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(8)) {
            if sessions.isEmpty {
                Text("memory.ai.empty").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    .frame(maxWidth: .infinity, minHeight: metrics.size(90))
            }
            ForEach(sessions) { usage in
                session(usage)
            }
        }
        .gitWebSheet(item: $confirming, width: 440) { kill in
            confirmation(kill)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.ai.list")
    }

    // MARK: Rows

    private func session(_ usage: ResourceMonitor.TerminalUsage) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: metrics.size(10)) {
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(verbatim: name(of: usage.tab)).font(metrics.font(size: 12, weight: .semibold))
                        .foregroundStyle(theme[.fg]).lineLimit(1)
                    Text(verbatim: "pid \(usage.pid)").font(metrics.monoFont(size: 10))
                        .foregroundStyle(theme[.fgMuted])
                }
                Spacer(minLength: 0)
                Text(verbatim: MemoryIndicator.format(usage.memoryMB))
                    .font(metrics.monoFont(size: 11, weight: .bold)).monospacedDigit()
                    .foregroundStyle(theme[.fg])
                killButton("memory.ai.killSession", id: "memory.ai.kill.\(usage.tab.rawValue)") {
                    confirming = .session(tab: usage.tab, name: name(of: usage.tab), children: usage.children.count)
                }
            }
            .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(9))
            ForEach(usage.children) { node in
                child(node, of: usage)
            }
        }
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private func child(_ node: ProcessNode, of usage: ResourceMonitor.TerminalUsage) -> some View {
        HStack(spacing: metrics.size(8)) {
            Image(systemName: "arrow.turn.down.right").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            Text(verbatim: node.command.isEmpty ? node.name : node.command)
                .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(Text(verbatim: node.command))
            ForEach(node.ports, id: \.self) { port in
                portChip(port)
            }
            Text(verbatim: MemoryIndicator.format(node.memoryMB)).font(metrics.monoFont(size: 11)).monospacedDigit()
                .foregroundStyle(theme[.fgMuted])
            killButton("memory.ai.killChild", id: "memory.ai.killChild.\(node.pid)") {
                confirming = .child(sessionPID: usage.pid, node: node)
            }
        }
        .padding(.leading, metrics.size(22)).padding(.trailing, metrics.size(10)).padding(.vertical, metrics.size(5))
        .overlay(alignment: .top) { theme[.border].frame(height: metrics.size(1)) }
    }

    private func portChip(_ port: UInt16) -> some View {
        Button {
            if let url = URL(string: "http://localhost:\(port)") { NSWorkspace.shared.open(url) }
        } label: {
            Text(verbatim: ":\(port)").font(metrics.monoFont(size: 10, weight: .bold))
                .foregroundStyle(theme[.statusActive])
                .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                .background(theme[.statusActive].opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .help(Text(verbatim: String(format: String(localized: "memory.ai.openPort"), Int(port))))
        .accessibilityIdentifier("memory.ai.port.\(port)")
    }

    private func killButton(_ help: LocalizedStringKey, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark.circle").font(metrics.font(size: 14))
        }
        .buttonStyle(AletheIconButtonStyle(side: 22))
        .help(Text(help))
        .accessibilityLabel(Text(help))
        .accessibilityIdentifier(id)
    }

    // MARK: Kill

    @ViewBuilder private func confirmation(_ kill: Kill) -> some View {
        switch kill {
        case .session(let tab, let name, let children):
            WebConfirmationModal(
                title: Text(verbatim: String(format: String(localized: "memory.ai.killSession.title"), name)),
                message: Text(verbatim: String(format: String(localized: "memory.ai.killSession.message"), children)),
                confirm: "memory.ai.killSession.confirm", confirmIdentifier: "memory.ai.killSession.confirm") {
                    environment.terminals.view(for: tab)?.forceKillTree()
                    refreshSoon()
                }
        case .child(let sessionPID, let node):
            WebConfirmationModal(
                title: Text(verbatim: String(format: String(localized: "memory.ai.killChild.title"), node.name)),
                message: Text("memory.ai.killChild.message"),
                confirm: "memory.ai.killChild.confirm", confirmIdentifier: "memory.ai.killChild.confirm") {
                    terminateChild(node.pid, under: sessionPID)
                    refreshSoon()
                }
        }
    }

    /// Kills `pid` and its children, only while it is still below the session: a pid freed and
    /// reused by an unrelated process since the last sample must not be hit.
    private func terminateChild(_ pid: pid_t, under root: pid_t) {
        Task.detached(priority: .userInitiated) {
            guard ProcessTree.descendants(of: root, parents: ProcessTree.currentParents()).contains(pid) else { return }
            ProcessTree.kill(pid)
        }
    }

    /// The next sample would show the change only after a full interval.
    private func refreshSoon() {
        Task {
            try? await Task.sleep(for: .seconds(1))
            environment.resources.check()
        }
    }

    private func name(of tab: TabID) -> String {
        guard let (project, pane) = environment.workspace?.document.paneHolding(tab),
              let item = pane.tabs.first(where: { $0.id == tab }) else { return tab.rawValue }
        return "\(item.title ?? AgentLabels.name(for: item.agent)) · \(project.name)"
    }
}
