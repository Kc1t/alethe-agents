import AletheAgents
import AletheModel
import AppKit
import AletheTerminal
import SwiftUI

/// Terminal menu: actions on the focused pane's visible terminal.
struct TerminalCommands: Commands {
    let environment: AppEnvironment

    var body: some Commands {
        CommandMenu("menu.terminal") {
            Button("menu.terminal.find") { focusedTerminal?.showSearch() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(focusedTerminal == nil)
            Button("menu.terminal.findNext") { focusedTerminal?.searchNext() }
                .keyboardShortcut("g", modifiers: .command)
                .disabled(focusedTerminal?.search.isPresented != true)
            Button("menu.terminal.findPrevious") { focusedTerminal?.searchPrevious() }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(focusedTerminal?.search.isPresented != true)
            Button("menu.terminal.useSelection") { focusedTerminal?.searchSelection() }
                .keyboardShortcut("e", modifiers: environment.metrics.isWebInterface ? [.command, .option] : .command)
                .disabled(focusedTerminal == nil)
            Button("menu.terminal.clearScrollback") { focusedTerminal?.clearScrollback() }
                .keyboardShortcut("k", modifiers: [.command, .option])
                .disabled(focusedTerminal == nil)
            Divider()
            Button("menu.terminal.olderPrompt") { focusedTerminal?.recallPrompt(.older) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                .disabled(focusedTerminal == nil)
            Button("menu.terminal.newerPrompt") { focusedTerminal?.recallPrompt(.newer) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(focusedTerminal == nil)
            Divider()
            Button("menu.terminal.sessionCost") {
                if let tab = focusedTab { environment.editorRequest = .sessionCost(tab.id) }
            }
            .disabled(focusedTab?.sessionID == nil)
            Button("menu.terminal.handoff") {
                if let tab = focusedTab { environment.editorRequest = .handoff(tab.id) }
            }
            .disabled(focusedTab.map { !Handoff.supports(AgentKind(rawValue: $0.agent)) } ?? true)
            Button("menu.terminal.resumePrevious") { resumePrevious() }
                .disabled(environment.terminals.running.isEmpty)
            Divider()
            Button("menu.terminal.previousPrompt") { focusedTerminal?.jumpToPrompt(-1) }
                .keyboardShortcut(.upArrow, modifiers: .command)
                .disabled(focusedTerminal == nil)
            Button("menu.terminal.nextPrompt") { focusedTerminal?.jumpToPrompt(1) }
                .keyboardShortcut(.downArrow, modifiers: .command)
                .disabled(focusedTerminal == nil)
        }
    }

    /// Confirms when several agents would restart, then reports the outcome.
    @MainActor private func resumePrevious() {
        let agents = environment.runningTerminals.agents
        if agents > 1 {
            let confirm = NSAlert()
            confirm.messageText = String(format: String(localized: "resumePrevious.confirm"), agents)
            confirm.addButton(withTitle: String(localized: "resumePrevious.action"))
            confirm.addButton(withTitle: String(localized: "editor.cancel"))
            guard confirm.runModal() == .alertFirstButtonReturn else { return }
        }
        let result = environment.terminals.resumePreviousConversations(environment: environment)
        let report = NSAlert()
        if result.total == 0 {
            report.messageText = String(localized: "resumePrevious.none")
        } else {
            report.messageText = String(format: String(localized: "resumePrevious.done"), result.resumed, result.total)
        }
        report.runModal()
    }

    @MainActor private var focusedTab: PaneTab? {
        guard let document = environment.workspace?.document, let pane = document.workspace.focusedPaneID else { return nil }
        return document.pane(pane)?.pane.activeTab
    }

    @MainActor private var focusedTerminal: TerminalPaneView? {
        environment.focusedTerminal
    }
}

extension AppEnvironment {
    /// The terminal of the focused pane's active tab, when it is running.
    var focusedTerminal: TerminalPaneView? {
        guard let document = workspace?.document, let pane = document.workspace.focusedPaneID,
              let tab = document.pane(pane)?.pane.activeTab else { return nil }
        return terminals.view(for: tab.id)
    }
}
