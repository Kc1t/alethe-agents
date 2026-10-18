import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// Web TerminalInspector: selection details, pane actions and the sub-tab switcher.
struct TerminalInspector: View {
    let workspace: WorkspaceModel
    let pane: Pane
    let project: Project
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.undoManager) private var undoManager

    private var tab: PaneTab? { pane.activeTab }
    private var focused: Bool { environment.focusModePaneID == pane.id }
    private var name: String {
        tab.map { environment.terminals.displayName(of: $0) }
            ?? pane.content.filePath.map { ($0 as NSString).lastPathComponent }
            ?? pane.content.kind.rawValue
    }
    private var path: String {
        if case .web(let url, _) = pane.content { return url }
        return pane.content.filePath ?? tab?.workingDirectory ?? project.folder
    }
    private var status: ThemeToken {
        if pane.isDisabled { return .statusDisabled }
        guard let tab else { return .statusStopped }
        if environment.terminals.activity[tab.id] == .working { return .statusWorking }
        return environment.terminals.states[tab.id] == .running ? .statusWaiting : .statusStopped
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: metrics.size(8)) {
                Group {
                    if let tab { AgentLogo(agent: tab.agent, size: 16) }
                    else { Image(systemName: "terminal").webProfileSized(15) }
                }
                .frame(width: metrics.size(24), height: metrics.size(24))
                .background(theme[.bg])
                .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay { RoundedRectangle(cornerRadius: metrics.radius(.sm)).stroke(theme[.border], lineWidth: metrics.size(1)) }
                VStack(alignment: .leading, spacing: metrics.size(1)) {
                    Text("terminalInspector.title").textCase(.uppercase)
                        .font(metrics.font(size: 9, weight: .bold)).tracking(metrics.size(0.72)).foregroundStyle(theme[.fgFaint])
                    Text(verbatim: name).font(metrics.font(size: 12, weight: .semibold)).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Circle().fill(theme[status]).frame(width: metrics.size(8), height: metrics.size(8))
                Button { environment.inspectedPaneID = nil } label: { Image(systemName: "xmark").webProfileSized(12) }
                    .buttonStyle(.plain).accessibilityLabel(Text("editor.cancel"))
            }
            if !path.isEmpty {
                Text(verbatim: path).font(metrics.monoFont(size: 10)).lineLimit(1).help(Text(verbatim: path))
                    .foregroundStyle(theme[.fgMuted]).padding(.vertical, metrics.size(6)).padding(.horizontal, metrics.size(7))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme[.bg])
                    .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay { RoundedRectangle(cornerRadius: metrics.radius(.sm)).stroke(theme[.border], lineWidth: metrics.size(1)) }
                    .padding(.top, metrics.size(8))
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: metrics.size(5)), GridItem(.flexible())], spacing: metrics.size(5)) {
                action(focused ? "focusMode.exit" : "pane.web.focusMode", symbol: focused ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") {
                    environment.focusModePaneID = focused ? nil : pane.id
                }
                action("terminalInspector.reveal", symbol: "terminal", perform: reveal)
                if pane.content.isTerminal {
                    action("pane.web.openInExplorer", symbol: "folder") { OpenInActions.revealInFinder(path) }
                    action("pane.web.openInVscode", symbol: "chevron.left.forwardslash.chevron.right") {
                        OpenInActions.vsCode(path, launchers: environment.launchers)
                    }
                    action("pane.web.restart", symbol: "arrow.clockwise", disabled: tab == nil || pane.isDisabled || tab.map { environment.terminals.states[$0.id] != .running } == true) {
                        if let tab { environment.terminals.restart(tab, in: project, environment: environment) }
                    }
                    action(pane.isDisabled ? "pane.web.reactivate" : "pane.web.disable", symbol: pane.isDisabled ? "eye" : "eye.slash") {
                        workspace.update { $0.setDisabled(pane.id, !pane.isDisabled) }
                    }
                    action(pane.isLaneVisible ? "pane.web.hideTabsLane" : "pane.web.showTabsLane", symbol: "sidebar.left", disabled: pane.tabs.count > 1) {
                        workspace.update { $0.setLaneVisible(!pane.isLaneVisible, for: pane.id) }
                    }
                    if let tab, ["claude", "codex", "opencode"].contains(tab.agent) {
                        action("menu.history.conversations", symbol: "clock.arrow.circlepath") { environment.editorRequest = .conversations(project.id) }
                    }
                    action("pane.web.killTerminal", symbol: "power", danger: true) {
                        for tab in pane.tabs { environment.terminals.view(for: tab.id)?.terminate() }
                        if focused { environment.focusModePaneID = nil }
                    }
                } else {
                    if case .web(let address, _) = pane.content {
                        action("terminalInspector.openBrowser", symbol: "arrow.up.right.square", disabled: URL(string: address) == nil) {
                            if let url = WebAddress.normalize(address) { NSWorkspace.shared.open(url) }
                        }
                    } else if let file = pane.content.filePath {
                        action("pane.web.openInExplorer", symbol: "folder") { OpenInActions.revealInFinder((file as NSString).deletingLastPathComponent) }
                    }
                    action("pane.web.deleteTerminal", symbol: "trash", danger: true) { closePane() }
                }
            }
            .padding(.top, metrics.size(8))
            if pane.content.isTerminal {
                HStack {
                    Text("terminalInspector.tabs").textCase(.uppercase).font(metrics.font(size: 10, weight: .bold))
                        .foregroundStyle(theme[.fgFaint])
                    Spacer(minLength: 0)
                    Button("newSubTab.add") { environment.editorRequest = .newSubTab(pane.id) }
                        .buttonStyle(.plain).font(metrics.font(size: 10, weight: .semibold)).foregroundStyle(theme[.fgMuted])
                }
                .frame(height: metrics.size(24)).padding(.top, metrics.size(10))
                ForEach(pane.tabs) { tab in
                    Button {
                        workspace.update { $0.updatePane(pane.id) { $0.activeTabID = tab.id } }
                        environment.terminals.markRead(tab.id)
                    } label: {
                        HStack(spacing: metrics.size(5)) {
                            Text(verbatim: tab.agent.uppercased()).font(metrics.font(size: 9, weight: .bold))
                                .foregroundStyle(theme[.fgFaint]).frame(width: metrics.size(52), alignment: .leading).lineLimit(1)
                            Text(verbatim: environment.terminals.displayName(of: tab)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                            Circle().fill(theme[.statusWorking].opacity(environment.terminals.unread.contains(tab.id) ? 1 : 0))
                                .frame(width: metrics.size(6), height: metrics.size(6))
                        }
                        .padding(.horizontal, metrics.size(7)).frame(height: metrics.size(26))
                    }
                    .buttonStyle(InspectorButtonStyle(selected: tab.id == pane.activeTab?.id, border: false))
                    .font(metrics.font(size: 11))
                    .accessibilityIdentifier("terminalInspector.tab.\(tab.id.rawValue)")
                }
            }
        }
        .padding(metrics.size(10))
        .foregroundStyle(theme[.fg])
        .background(theme[.bgSunken].opacity(0.88).background(theme[.panel]))
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("terminalInspector.title"))
        .accessibilityIdentifier("terminalInspector")
    }

    private func action(_ label: LocalizedStringKey, symbol: String, disabled: Bool = false, danger: Bool = false,
                        perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            HStack(spacing: metrics.size(6)) {
                Image(systemName: symbol).webProfileSized(14)
                Text(label).lineLimit(1)
            }
            .padding(.horizontal, metrics.size(8)).frame(maxWidth: .infinity, alignment: .leading).frame(height: metrics.size(28))
        }
        .font(metrics.font(size: 11))
        .buttonStyle(InspectorButtonStyle(danger: danger))
        .disabled(disabled).help(Text(label))
    }

    private func reveal() {
        workspace.update { $0.focusWebPane(pane.id) }
        environment.showingHome = false
        if let tab {
            environment.terminals.markRead(tab.id)
            DispatchQueue.main.async { environment.terminals.view(for: tab.id)?.focus() }
        }
    }

    private func closePane() {
        Task {
            guard await WebDialogCenter.shared.confirm(format("pane.web.confirmDeleteTerminal", name),
                confirmTitle: String(localized: "pane.web.deleteTerminal"), destructive: true) else { return }
            workspace.update(undoManager: undoManager, actionName: String(localized: "pane.web.deleteTerminal")) { $0.closePane(pane.id) }
            environment.inspectedPaneID = nil
            if focused { environment.focusModePaneID = nil }
        }
    }
}

private struct InspectorButtonStyle: ButtonStyle {
    var selected = false
    var border = true
    var danger = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        InspectorButtonBody(configuration: configuration, selected: selected, border: border, danger: danger, enabled: enabled)
    }
}

private struct InspectorButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let border: Bool
    let danger: Bool
    let enabled: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    var body: some View {
        configuration.label
            .foregroundStyle(theme[hovering && danger ? .statusOffline : hovering || selected ? .fg : .fgMuted])
            .background(theme[hovering || selected ? .panelHover : .bg].opacity(border || hovering || selected ? 1 : 0))
            .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay { if border { RoundedRectangle(cornerRadius: metrics.radius(.sm)).stroke(theme[hovering ? .borderStrong : .border], lineWidth: metrics.size(1)) } }
            .opacity(enabled ? 1 : 0.38)
            .onHover { hovering = $0 }
    }
}
