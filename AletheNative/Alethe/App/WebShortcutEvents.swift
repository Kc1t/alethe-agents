import AletheModel
import AppKit
import SwiftUI

/// Non-menu shortcuts from web useKeybindings.ts. Never consume terminal text as a restart.
struct WebShortcutEvents: NSViewRepresentable {
    let environment: AppEnvironment

    func makeNSView(context: Context) -> ShortcutView { ShortcutView() }
    func updateNSView(_ view: ShortcutView, context: Context) {
        view.environment = environment
        view.install()
    }
    static func dismantleNSView(_ view: ShortcutView, coordinator: ()) { view.uninstall() }

    @MainActor final class ShortcutView: NSView {
        var environment: AppEnvironment?
        private var monitor: Any?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func install() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                let handled = MainActor.assumeIsolated { self?.handle(event) ?? false }
                return handled ? nil : event
            }
        }

        func uninstall() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }

        private func handle(_ event: NSEvent) -> Bool {
            guard let environment, environment.metrics.isWebInterface,
                  let window, window.isKeyWindow, event.window === window,
                  environment.editorRequest == nil, window.attachedSheet == nil,
                  let workspace = environment.workspace else { return false }
            let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
            let key = event.charactersIgnoringModifiers ?? ""
            if flags == .command, key == "n" { environment.editorRequest = .newProject(.ungrouped); return true }
            if flags == [.command, .shift], key.lowercased() == "n" { environment.editorRequest = .newGroup(parent: nil); return true }
            if flags == .command, key == "k" { environment.editorRequest = .findJump; return true }
            if flags == [.command, .control], key == "s" {
                NotificationCenter.default.post(name: .aletheToggleWebSidebar, object: nil)
                return true
            }
            if flags == .command, key == "[" || key == "]" {
                workspace.update { $0.navigateHistory(key == "[" ? -1 : 1) }
                environment.showingHome = false
                return true
            }
            if flags == .command, let number = Int(key), (1...9).contains(number) {
                guard workspace.document.projects.indices.contains(number - 1) else { return true }
                let id = workspace.document.projects[number - 1].id
                workspace.update { $0.openWebProject(id) }
                environment.showingHome = false
                return true
            }
            if flags == .command, key == "=" {
                environment.preferences?.update { $0.zoom(by: 1) }
                return true
            }
            let editable = window.firstResponder is NSTextView || window.firstResponder is NSTextField
            let terminalFocused = environment.focusedTerminal.map { terminal in
                guard let responder = window.firstResponder as? NSView else { return false }
                return responder === terminal || responder.isDescendant(of: terminal)
            } ?? false
            if flags.isEmpty, key.lowercased() == "r", !editable, !terminalFocused,
               let paneID = workspace.document.workspace.focusedPaneID,
               let (project, pane) = workspace.document.pane(paneID),
               pane.content.isTerminal, !pane.isDisabled, let tab = pane.activeTab {
                environment.terminals.restart(tab, in: project, environment: environment)
                return true
            }
            let direction: Int
            if flags == .control, event.keyCode == 116 { direction = -1 }
            else if flags == .control, event.keyCode == 121 { direction = 1 }
            else if flags == .shift, event.keyCode == 48, !editable, !terminalFocused { direction = 1 }
            else { return false }
            let doc = workspace.document
            let group = doc.activeWorkspaceTab?.webGroupID
            let scoped: Set<ProjectID>
            if let group {
                scoped = Set(doc.groups.filter { doc.isGroup($0.id, inside: group) }.flatMap(\.projectIDs))
            } else { scoped = Set(doc.workspace.selectedProjectID.map { [$0] } ?? doc.workspace.openProjectIDs) }
            let panes = doc.workspace.openProjectIDs.filter { scoped.contains($0) }.compactMap(doc.project)
                .flatMap(\.visiblePanes).filter { !$0.isDisabled && $0.content.isTerminal }
            guard !panes.isEmpty else { return true }
            let current = panes.firstIndex { $0.id == doc.workspace.focusedPaneID }
            let next = current.map { ($0 + direction + panes.count) % panes.count } ?? 0
            let pane = panes[next]
            workspace.update { $0.focusWebPane(pane.id) }
            environment.showingHome = false
            if let tab = pane.activeTab {
                environment.terminals.markRead(tab.id)
                environment.terminals.view(for: tab.id)?.focus()
            }
            return true
        }
    }
}
