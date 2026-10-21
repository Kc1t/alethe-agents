import AletheFoundation
import AletheModel
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor weak var environment: AppEnvironment? {
        didSet {
            guard let environment else { return }
            let folders = pendingFolders
            pendingFolders = []
            folders.forEach(environment.openFolder)
        }
    }
    /// Open requests that arrived before the window's environment was attached (a cold start).
    @MainActor private var pendingFolders: [URL] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        // One Alethe per user session: a second copy would own the same data files and terminals.
        // Debug builds pointed at their own data root (UI tests, experiments) may run side by side.
        #if DEBUG
        if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil { return }
        #endif
        let current = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: AppIdentity.bundleIdentifier)
            .filter { $0.processIdentifier != current && !$0.isTerminated }
        if let existing = others.first {
            existing.activate()
            exit(0)
        }
    }

    @MainActor func applicationDidFinishLaunching(_ notification: Notification) {
        ImagePasteMonitor.install { [weak self] in self?.environment?.metrics }
    }

    /// Folders (or files) opened with the app: `alethe` runs `open -a Alethe <folder>`, and Finder's
    /// Open With or a drop on the Dock icon land here too, on a cold start and while running.
    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            let files = urls.filter(\.isFileURL)
            if let environment {
                files.forEach(environment.openFolder)
            } else {
                pendingFolders += files
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let confirmed = MainActor.assumeIsolated { confirmQuit() }
        guard confirmed else { return .terminateCancel }
        Task { @MainActor in
            await environment?.flush()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// Reached only on a normal quit: the session marker records it (P5-11).
    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { environment?.diagnostics.markCleanExit() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Quitting stops every terminal (upstream `useCloseConfirmation`): ask first while any runs,
    /// unless the user turned the question off (also from the alert itself).
    @MainActor private func confirmQuit() -> Bool {
        guard let environment, !environment.relaunching,
              environment.preferences?.document.confirmQuit != false else { return true }
        #if DEBUG
        // Smoke scripts quit throwaway instances with AppleScript; UI tests opt in explicitly.
        if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil,
           !UserDefaults.standard.bool(forKey: "AletheConfirmQuit") { return true }
        #endif
        let running = environment.runningTerminals
        guard running.agents + running.shells > 0 else { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(localized: "quit.title")
        alert.informativeText = String(format: String(localized: "quit.message"), running.agents, running.shells)
        alert.addButton(withTitle: String(localized: "quit.confirm"))
        alert.addButton(withTitle: String(localized: "editor.cancel"))
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = String(localized: "quit.dontAsk")
        let answer = alert.runModal()
        if alert.suppressionButton?.state == .on, answer == .alertFirstButtonReturn {
            environment.preferences?.update { $0.confirmQuit = false }
        }
        return answer == .alertFirstButtonReturn
    }
}
