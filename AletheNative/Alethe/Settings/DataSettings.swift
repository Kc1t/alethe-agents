import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Settings › General › Data (P5-10, upstream `backup.rs`, `diagnostics.rs`): export and import a
/// backup of the running profile, reset it, erase everything, open the data folder, open GitHub Sync
/// (P7-15). Import, reset and erase ask once, take a safety backup and relaunch.
enum DataSettingsAction: String, Hashable {
    case manage, exportBackup, importBackup, reset, erase
}

struct DataSettingsSection: View {
    var initialAction: DataSettingsAction = .manage
    @State private var performedInitialAction = false
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var staged: StagedBackup?
    @State private var confirmImport = false
    @State private var importStarted = false
    @State private var confirmReset = false
    @State private var confirmErase = false
    @State private var status: Status?
    @State private var busy = false

    private enum Status: Equatable {
        case message(String)
        case failure(String)
    }

    var body: some View {
        Section {
            LabeledContent {
                HStack {
                    Button("settings.data.export", action: export)
                        .accessibilityIdentifier("settings.data.export")
                    Button("settings.data.import", action: chooseImport)
                        .accessibilityIdentifier("settings.data.import")
                }
            } label: {
                Text("settings.data.backup")
                Text("settings.data.backup.help")
            }
            LabeledContent {
                Button("settings.data.gistSync", action: openGistSync)
                    .accessibilityIdentifier("settings.data.gistSync")
            } label: {
                Text("settings.data.gistSync.label")
                Text("settings.data.gistSync.help")
            }
            LabeledContent {
                Button("settings.data.reset", role: .destructive) { confirmReset = true }
                    .accessibilityIdentifier("settings.data.reset")
            } label: {
                Text("settings.data.reset.label")
                Text("settings.data.reset.help")
            }
            LabeledContent {
                Button("settings.data.erase", role: .destructive) { confirmErase = true }
                    .accessibilityIdentifier("settings.data.erase")
            } label: {
                Text("settings.data.erase.label")
                Text("settings.data.erase.help")
            }
            LabeledContent {
                HStack {
                    Button("settings.data.openFolder") { environment.openDataFolder() }
                        .accessibilityIdentifier("settings.data.openFolder")
                    Button("settings.data.safetyBackups") { environment.revealSafetyBackups() }
                        .accessibilityIdentifier("settings.data.safetyBackups")
                }
            } label: {
                Text("settings.data.folder")
                Text("settings.data.folder.help")
            }
            if let status {
                switch status {
                case .message(let text):
                    Text(verbatim: text)
                        .foregroundStyle(theme[.textSecondary])
                        .accessibilityIdentifier("settings.data.status")
                case .failure(let text):
                    Text(verbatim: text)
                        .foregroundStyle(theme[.statusStopped])
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings.data.error")
                }
            }
        } header: {
            Text("settings.data.title")
        }
        .disabled(busy || environment.locations == nil)
        .onAppear(perform: reportLaunchResult)
        .task {
            guard !performedInitialAction else { return }
            performedInitialAction = true
            switch initialAction {
            case .manage: break
            case .exportBackup: export()
            case .importBackup: chooseImport()
            case .reset: confirmReset = true
            case .erase: confirmErase = true
            }
        }
        .webConfirm(isPresented: $confirmImport, message: staged.map(importSummary) ?? "", title: String(localized: "settings.data.import.confirm"),
                    confirmTitle: String(localized: "settings.data.import.action"), destructive: true) {
            if let pending = staged {
                importStarted = true
                perform { try await environment.importStaged(pending) }
            }
        }
        .confirmationDialog(Text("settings.data.import.confirm"), isPresented: Binding(get: { !metrics.isWebInterface && confirmImport }, set: { confirmImport = $0 })) {
            // The staged archive is captured now: the dialog may clear its binding before the action runs.
            if let pending = staged {
                Button("settings.data.import.action", role: .destructive) {
                    importStarted = true
                    perform { try await environment.importStaged(pending) }
                }
                .accessibilityIdentifier("settings.data.importConfirm")
            }
        } message: {
            Text(verbatim: staged.map(importSummary) ?? "")
        }
        .onChange(of: confirmImport) { _, shown in
            // Cancelled: drop the unpacked copy (a later launch would clear it anyway).
            guard !shown, !importStarted, let pending = staged else { return }
            staged = nil
            environment.discardStaged(pending)
        }
        .webConfirm(isPresented: $confirmReset,
                    message: String(format: String(localized: "settings.data.reset.message"), environment.activeProfileName),
                    title: String(localized: "settings.data.reset.confirm"), confirmTitle: String(localized: "settings.data.reset"), destructive: true) {
            perform { try await environment.resetProfileData() }
        }
        .confirmationDialog(Text("settings.data.reset.confirm"), isPresented: Binding(get: { !metrics.isWebInterface && confirmReset }, set: { confirmReset = $0 })) {
            Button("settings.data.reset", role: .destructive) {
                perform { try await environment.resetProfileData() }
            }
            .accessibilityIdentifier("settings.data.resetConfirm")
        } message: {
            Text(verbatim: String(format: String(localized: "settings.data.reset.message"), environment.activeProfileName))
        }
        .webConfirm(isPresented: $confirmErase, message: String(localized: "settings.data.erase.message"), title: String(localized: "settings.data.erase.confirm"),
                    confirmTitle: String(localized: "settings.data.erase"), destructive: true) {
            perform { try await environment.eraseAllData() }
        }
        .confirmationDialog(Text("settings.data.erase.confirm"), isPresented: Binding(get: { !metrics.isWebInterface && confirmErase }, set: { confirmErase = $0 })) {
            Button("settings.data.erase", role: .destructive) {
                perform { try await environment.eraseAllData() }
            }
            .accessibilityIdentifier("settings.data.eraseConfirm")
        } message: {
            Text("settings.data.erase.message")
        }
    }

    private func importSummary(_ staged: StagedBackup) -> String {
        let contents = staged.contents
        var lines = [String(format: String(localized: "settings.data.import.holds"), contents.projects, contents.terminals,
                            contents.files, contents.bytes.formatted(.byteCount(style: .file)))]
        if let manifest = contents.manifest {
            lines.append(String(format: String(localized: "settings.data.import.made"),
                                manifest.profileName ?? AppEnvironment.defaultProfileName,
                                manifest.createdAt.formatted(date: .abbreviated, time: .shortened)))
        }
        lines.append(String(format: String(localized: "settings.data.import.message"), environment.activeProfileName))
        return lines.joined(separator: "\n\n")
    }

    /// The sheet belongs to the main window: Settings closes and the main window comes forward.
    private func openGistSync() {
        environment.editorRequest = .gistSync
        openWindow(id: "main")
        dismissWindow()
    }

    private func export() {
        guard let target = saveTarget() else { return }
        perform {
            try await environment.exportBackup(to: target)
            status = .message(String(format: String(localized: "settings.data.exported"), target.lastPathComponent))
        }
    }

    private func chooseImport() {
        guard let source = openSource() else { return }
        perform {
            staged = try await environment.stageBackup(source)
            importStarted = false
            confirmImport = true
        }
    }

    private func saveTarget() -> URL? {
        #if DEBUG
        if let path = UserDefaults.standard.string(forKey: "AletheUITestBackupFile") { return URL(filePath: path) }
        #endif
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.zip]
        panel.canCreateDirectories = true
        let slug = environment.activeProfileName.lowercased()
            .map { $0.isLetter || $0.isNumber ? $0 : "-" }
        panel.nameFieldStringValue = "alethe-\(String(slug))-\(Date().formatted(.iso8601.year().month().day())).zip"
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func openSource() -> URL? {
        #if DEBUG
        if let path = UserDefaults.standard.string(forKey: "AletheUITestBackupFile") { return URL(filePath: path) }
        #endif
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true
        status = nil
        Task {
            defer { busy = false }
            do {
                try await action()
            } catch let failure as BackupError {
                status = .failure(failure.localizedMessage)
            } catch let failure as ProfileError {
                status = .failure(failure.localizedMessage)
            } catch {
                status = .failure(String(format: String(localized: "settings.data.error.operation"), error.localizedDescription))
            }
        }
    }

    /// A scheduled operation that failed at launch is reported once here.
    private func reportLaunchResult() {
        guard status == nil, case .failure(let error) = environment.dataMaintenanceResult else { return }
        let message = (error as? BackupError)?.localizedMessage ?? error.localizedDescription
        status = .failure(String(format: String(localized: "settings.data.error.launch"), message))
    }
}

/// Main-menu data actions reuse the profile backup, confirmation and recovery implementation.
struct DataManagementSheet: View {
    let action: DataSettingsAction
    let close: () -> Void

    var body: some View {
        GitWebModal(close: close) {
            Text("settings.data.title")
        } content: {
            DataSettingsSection(initialAction: action)
        } footer: {
            Spacer()
            Button("agentInstall.done", action: close)
        }
    }
}
