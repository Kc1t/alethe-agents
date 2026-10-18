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
            row("menu.redoOnboarding", "arrow.clockwise") { environment.editorRequest = .onboarding }
                .accessibilityIdentifier("chrome.mainMenu.redoOnboarding")
            #endif
            row("menu.view.flat", "square.stack.3d.up") {
                environment.workspace?.update { $0.workspace.flat.toggle() }
            }
            separator
            row("settings.data.openFolder", "folder") { environment.openDataFolder() }
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

/// WhatsNewModal.module.css hero and Modal.module.css shell, using native release copy.
struct WebTitleBarNews: View {
    let close: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("chrome.whatsNew").font(metrics.font(size: 15, weight: .semibold))
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark").resizable().scaledToFit()
                        .frame(width: metrics.size(16), height: metrics.size(16))
                }
                .buttonStyle(AletheIconButtonStyle(side: 26))
                .accessibilityLabel(Text("editor.cancel"))
            }
            .padding(.horizontal, metrics.size(20)).padding(.top, metrics.size(16))
            HStack(alignment: .top, spacing: metrics.size(12)) {
                Image(systemName: "newspaper").resizable().scaledToFit()
                    .frame(width: metrics.size(18), height: metrics.size(18))
                    .foregroundStyle(theme[.accent])
                    .frame(width: metrics.size(32), height: metrics.size(32))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(9)).strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                Text("chrome.news.chrome").font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(metrics.size(12))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .padding(.horizontal, metrics.size(20)).padding(.top, metrics.size(14)).padding(.bottom, metrics.size(18))
            theme[.border].frame(height: metrics.size(1))
            HStack {
                Spacer()
                Button("agentInstall.done", action: close).buttonStyle(AletheButtonStyle())
            }.padding(.horizontal, metrics.size(20)).padding(.vertical, metrics.size(16))
        }
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
        .accessibilityIdentifier("chrome.whatsNew.modal")
    }
}
