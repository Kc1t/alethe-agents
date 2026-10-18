import AletheFoundation
import AppKit
import AletheDesign
import SwiftUI

extension Notification.Name {
    static let aletheCloseTitleBarNews = Notification.Name("alethe.closeTitleBarNews")
}

struct WebTitleBarNewsKey: PreferenceKey {
    static var defaultValue: Bool { false }
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

/// Only actions backed by the native app are shown; no placeholder web commands.
struct WebWindowMenu: View {
    let close: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            row("leftSidebar.preferences", "gearshape") { openSettings() }
            if environment.features.isOn(.browser), let project = environment.workspace?.document.workspace.selectedProjectID {
                row("menu.addBrowser", "globe") { environment.editorRequest = .addBrowser(project) }
                    .accessibilityIdentifier("chrome.mainMenu.addBrowser")
            }
            row("titlebar.remote", "network") { environment.editorRequest = .remotePairing }
            row("diagnostics.title", "shield.lefthalf.filled") { environment.editorRequest = .diagnostics }
            #if DEBUG
            separator
            row("themePicker.title", "sun.max") { environment.editorRequest = .themePicker }
                .accessibilityIdentifier("chrome.mainMenu.pickTheme")
            row("menu.redoOnboarding", "arrow.clockwise") { environment.editorRequest = .onboarding }
                .accessibilityIdentifier("chrome.mainMenu.redoOnboarding")
            #endif
            row(environment.workspace?.document.workspace.flat == true ? "menu.groupByProject" : "menu.view.flat", "square.stack.3d.up") {
                environment.workspace?.update { $0.workspace.flat.toggle() }
            }
            separator
            row("settings.data.openFolder", "folder") { environment.openDataFolder() }
            row("menu.openSpawnLog", "doc.text") {
                guard let directory = environment.diagnostics.logsDirectory else { return }
                let file = directory.appending(path: Diagnostics.spawnLogName)
                if FileManager.default.fileExists(atPath: file.path) { NSWorkspace.shared.open(file) }
                else { NSWorkspace.shared.open(directory) }
            }
            row("menu.help.openLogsFolder", "doc.text") { environment.diagnostics.openLogsFolder() }
            row("menu.help.exportLogs", "square.and.arrow.up") { environment.diagnostics.exportLogs() }
            separator
            row("settings.data.export", "square.and.arrow.down") { environment.editorRequest = .dataManagement(.exportBackup) }
            row("settings.data.import", "square.and.arrow.up") { environment.editorRequest = .dataManagement(.importBackup) }
            separator
            row("settings.data.reset", "trash", role: .destructive) { environment.editorRequest = .dataManagement(.reset) }
            row("settings.data.erase", "trash", role: .destructive) { environment.editorRequest = .dataManagement(.erase) }
            separator
            row("menu.file.newProject", "folder.badge.plus") { environment.editorRequest = .newProject(.ungrouped) }
            row("menu.file.newGroup", "square.3.layers.3d") { environment.editorRequest = .newGroup(parent: nil) }
            row("menu.file.newTerminal", "terminal") { environment.editorRequest = .newTerminal(nil) }
            separator
            row("menu.view.showHome", "house") { environment.showingHome = true }
            row("findJump.command", "magnifyingglass") { environment.editorRequest = .findJump }
        }
        .buttonStyle(AletheTitleBarMenuRowStyle())
        .padding(metrics.size(4))
        .frame(width: metrics.size(220))
        .modifier(AletheTitleBarSurface())
        .onExitCommand(perform: close)
    }

    private var separator: some View {
        theme[.border].frame(height: metrics.size(1))
            .padding(.horizontal, metrics.size(2)).padding(.vertical, metrics.size(4))
    }

    private func row(_ title: LocalizedStringKey, _ symbol: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role) { close(); action() } label: {
            HStack(spacing: metrics.size(8)) {
                Image(systemName: symbol).resizable().scaledToFit()
                    .frame(width: metrics.size(14), height: metrics.size(14))
                Text(title)
            }
        }
    }
}
