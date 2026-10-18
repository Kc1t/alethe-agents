import AletheDesign
import AletheModel
import SwiftUI

/// FindJumpModal.tsx: 520-point overlay, 32-point input and a 320-point results viewport.
struct WebTitleBarSearch: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let close: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var query = ""
    @State private var cursor = 0
    @FocusState private var focused: Bool

    private struct Hit: Identifiable {
        let id: String
        let title: String
        let group: String
        let symbol: String
        var agent: String?
        var directory: String?
        var shortcut: String?
        var pluginID: String?
        var command: JumpCommand?
        var tab: TabID?
    }

    private var hits: [Hit] {
        let commands = JumpCommand.allCases.filter { $0.isAvailable(workspace.document) }.map {
            Hit(id: "command:\($0.rawValue)", title: String(localized: $0.title), group: String(localized: "findJump.command"), symbol: $0.symbol, shortcut: $0 == .newProject ? "⇧⌘P" : $0 == .newGroup ? "⇧⌘G" : $0.shortcut, command: $0)
        }
        let plugins = (environment.plugins?.contributions.commands ?? []).filter { $0.placement.contains(.findJump) }.map {
            Hit(id: "plugin:" + $0.id, title: $0.title, group: String(localized: "findJump.command"),
                symbol: "command", shortcut: $0.keyEquivalent.map { "⌘" + $0.uppercased() }, pluginID: $0.id)
        }
        let terminals = workspace.document.projects.flatMap { project in
            project.panes.flatMap { pane in pane.tabs.map { tab in
                Hit(id: tab.id.rawValue, title: tab.title ?? AgentLabels.name(for: tab.agent), group: project.name,
                    symbol: "terminal", agent: tab.agent, directory: tab.workingDirectory ?? project.folder, tab: tab.id)
            } }
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return Array((commands + plugins + terminals).filter {
            needle.isEmpty || [$0.title, $0.group, $0.directory ?? ""].joined(separator: " ").localizedCaseInsensitiveContains(needle)
        }.prefix(50))
    }

    var body: some View {
        let results = hits
        WebTitleBarAnalytics(title: "titlebar.search.title", close: close) {
            VStack(spacing: metrics.size(12)) {
                TextField(text: $query) { Text("findJump.placeholder") }
                    .textFieldStyle(.plain).font(metrics.font(size: 14))
                    .padding(.horizontal, metrics.size(10)).frame(height: metrics.size(32))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[focused ? .accent : .border], lineWidth: metrics.size(1)))
                    .focused($focused)
                    .onChange(of: query) { _, _ in cursor = 0 }
                    .onKeyPress(.downArrow) { cursor = min(cursor + 1, max(0, results.count - 1)); return .handled }
                    .onKeyPress(.upArrow) { cursor = max(0, cursor - 1); return .handled }
                    .onSubmit { if results.indices.contains(cursor) { jump(results[cursor]) } }
                    .accessibilityIdentifier("findJump.field")
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 0) {
                            if results.isEmpty {
                                Text("findJump.nothing").font(metrics.font(size: 13)).foregroundStyle(theme[.fgFaint])
                                    .padding(metrics.size(24)).frame(maxWidth: .infinity)
                            }
                            ForEach(Array(results.enumerated()), id: \.element.id) { index, hit in
                                Button { jump(hit) } label: {
                                    HStack(spacing: metrics.size(10)) {
                                        if let agent = hit.agent, agent != "shell" {
                                            AgentLogo(agent: agent, size: 14)
                                        } else {
                                            Image(systemName: hit.symbol).resizable().scaledToFit()
                                                .frame(width: metrics.size(14), height: metrics.size(14))
                                        }
                                        Text(verbatim: hit.title).font(metrics.font(size: 13, weight: .medium)).lineLimit(1)
                                        Text(verbatim: "· \(hit.group)").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted]).lineLimit(1)
                                        Spacer(minLength: 0)
                                        if let detail = hit.directory ?? hit.shortcut {
                                            Text(verbatim: detail).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint]).lineLimit(1).truncationMode(.head)
                                        }
                                    }
                                    .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(8))
                                    .background(theme[.accentFaint].opacity(index == cursor ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).onHover { if $0 { cursor = index } }
                                .accessibilityAddTraits(index == cursor ? [.isSelected] : [])
                                .accessibilityIdentifier("findJump.row.\(hit.title)")
                                .id(index)
                            }
                        }
                    }
                    .frame(height: min(metrics.size(320), metrics.size(CGFloat(max(1, results.count)) * 34)))
                    .onChange(of: cursor) { _, value in proxy.scrollTo(value) }
                }
            }
        }
        .onAppear { focused = true }
        .accessibilityIdentifier("findJump")
    }

    private func jump(_ hit: Hit) {
        // Clear the editor synchronously before a command may open its next modal.
        environment.editorRequest = nil
        if let tab = hit.tab {
            workspace.update { document in
                guard let pane = document.paneHolding(tab)?.pane else { return }
                document.focusWebPane(pane.id)
                document.activateTab(tab)
            }
            environment.showingHome = false
        } else if let id = hit.pluginID {
            environment.performPluginCommand(id)
        } else if let command = hit.command {
            command.run(environment: environment, undoManager: undoManager)
        }
    }
}
