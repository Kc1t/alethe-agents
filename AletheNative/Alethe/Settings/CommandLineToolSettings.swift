import AletheDesign
import AletheFoundation
import AletheTerminal
import AppKit
import SwiftUI

/// Settings › General › Command Line Tool (TERM-11; upstream `cli_shim.rs`): installs, reinstalls
/// and removes the `alethe` script in `~/.local/bin`. Every change is a user action that asks
/// first; nothing needs or asks for administrator rights.
struct CommandLineToolSection: View {
    @State private var tool = CommandLineTool()
    @State private var confirming: CommandLineTool.Action?
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        Section {
            LabeledContent {
                HStack {
                    if tool.isBusy { ProgressView().controlSize(.small) }
                    buttons
                }
            } label: {
                Text("settings.cli.title")
                statusText
                    .accessibilityIdentifier("settings.cli.status")
            }
            if let status = tool.status, status.state == .current || status.state == .stale, !status.onPath {
                VStack(alignment: .leading, spacing: metrics.space(.s)) {
                    Text(verbatim: String(format: String(localized: "settings.cli.path.missing"), status.directory.path))
                        .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                        .foregroundStyle(theme[.textSecondary])
                    HStack {
                        Text(verbatim: CLIShim.pathExportLine)
                            .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)).monospaced())
                            .textSelection(.enabled)
                        Spacer()
                        Button("settings.cli.copyLine") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(CLIShim.pathExportLine, forType: .string)
                        }
                    }
                }
                .accessibilityIdentifier("settings.cli.pathHint")
            }
            if let error = tool.error {
                Text(verbatim: String(format: String(localized: "settings.cli.error"), error))
                    .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                    .foregroundStyle(theme[.statusStopped])
            }
        } footer: {
            Text("settings.cli.help")
                .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                .foregroundStyle(theme[.textTertiary])
        }
        .task { await tool.refresh() }
        .webConfirm(isPresented: isConfirming, message: confirming.map(cliMessage) ?? "",
                    title: confirming.map(title), confirmTitle: confirming.map(cliConfirmTitle),
                    destructive: confirming != .install) {
            switch confirming {
            case .install, .replace: Task { await tool.install() }
            case .uninstall: Task { await tool.uninstall() }
            case nil: break
            }
        }
        .confirmationDialog(Text(verbatim: confirming.map(title) ?? ""),
                            isPresented: Binding(get: { !metrics.isWebInterface && confirming != nil },
                                                 set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { action in
            switch action {
            case .install:
                Button("settings.cli.install") { Task { await tool.install() } }
            case .replace:
                Button("settings.cli.replace", role: .destructive) { Task { await tool.install() } }
            case .uninstall:
                Button("settings.cli.uninstall", role: .destructive) { Task { await tool.uninstall() } }
            }
        } message: { action in
            switch action {
            case .install: Text("settings.cli.install.message")
            case .replace: Text("settings.cli.replace.message")
            case .uninstall: Text("settings.cli.uninstall.message")
            }
        }
    }

    private func cliMessage(_ action: CommandLineTool.Action) -> String {
        switch action {
        case .install: String(localized: "settings.cli.install.message")
        case .replace: String(localized: "settings.cli.replace.message")
        case .uninstall: String(localized: "settings.cli.uninstall.message")
        }
    }

    private func cliConfirmTitle(_ action: CommandLineTool.Action) -> String {
        switch action {
        case .install: String(localized: "settings.cli.install")
        case .replace: String(localized: "settings.cli.replace")
        case .uninstall: String(localized: "settings.cli.uninstall")
        }
    }

    @ViewBuilder private var buttons: some View {
        switch tool.status?.state {
        case .missing:
            Button("settings.cli.install") { confirming = .install }
                .accessibilityIdentifier("settings.cli.install")
        case .stale:
            Button("settings.cli.reinstall") { confirming = .install }
                .accessibilityIdentifier("settings.cli.install")
            Button("settings.cli.uninstall") { confirming = .uninstall }
                .accessibilityIdentifier("settings.cli.uninstall")
        case .foreign:
            Button("settings.cli.replace") { confirming = .replace }
                .accessibilityIdentifier("settings.cli.install")
        case .current:
            Button("settings.cli.uninstall") { confirming = .uninstall }
                .accessibilityIdentifier("settings.cli.uninstall")
        case nil:
            EmptyView()
        }
    }

    private var statusText: Text {
        guard let status = tool.status else { return Text("settings.cli.status.checking") }
        let path = status.file.path
        return switch status.state {
        case .missing: Text("settings.cli.status.missing")
        case .current: Text(verbatim: String(format: String(localized: "settings.cli.status.current"), path))
        case .stale: Text(verbatim: String(format: String(localized: "settings.cli.status.stale"), path))
        case .foreign: Text(verbatim: String(format: String(localized: "settings.cli.status.foreign"), path))
        }
    }

    private func title(_ action: CommandLineTool.Action) -> String {
        let key: String.LocalizationValue = switch action {
        case .install: "settings.cli.install.confirm"
        case .replace: "settings.cli.replace.confirm"
        case .uninstall: "settings.cli.uninstall.confirm"
        }
        let place = action == .install ? tool.directory.path : CLIShim.location(in: tool.directory).path
        return String(format: String(localized: key), place)
    }

    private var isConfirming: Binding<Bool> {
        Binding { confirming != nil } set: { if !$0 { confirming = nil } }
    }
}

/// State and file work behind the section; disk and shell work runs off the main thread.
@Observable
@MainActor
final class CommandLineTool {
    enum Action: Hashable { case install, replace, uninstall }

    struct Status: Equatable, Sendable {
        var state: CLIShim.State
        var file: URL
        var directory: URL
        var onPath: Bool
    }

    let directory = CLIShim.defaultDirectory()
    private(set) var status: Status?
    private(set) var error: String?
    private(set) var isBusy = false
    /// The login shell's PATH, probed once per section.
    @ObservationIgnored private var shellPath: String?

    /// The bundle the shim opens: this copy of the app.
    private var appPath: String { Bundle.main.bundlePath }

    func refresh() async {
        if shellPath == nil { shellPath = await Self.loginShellPath() }
        let directory = directory, appPath = appPath
        let path = shellPath ?? ProcessInfo.processInfo.environment["PATH"] ?? ""
        status = await Task.detached {
            Status(state: CLIShim.state(of: CLIShim.read(in: directory), appPath: appPath),
                   file: CLIShim.location(in: directory), directory: directory,
                   onPath: CLIShim.pathContains(directory, pathVariable: path))
        }.value
    }

    func install() async {
        let directory = directory, appPath = appPath
        await perform { try CLIShim.install(appPath: appPath, in: directory) }
    }

    func uninstall() async {
        let directory = directory
        await perform { try CLIShim.uninstall(in: directory) }
    }

    private func perform(_ work: @escaping @Sendable () throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        error = nil
        do {
            try await Task.detached { try work() }.value
        } catch {
            self.error = error.localizedDescription
        }
        await refresh()
        isBusy = false
    }

    /// `PATH` as the user's interactive login shell sets it (5 s at most); nil when it fails.
    nonisolated static func loginShellPath() async -> String? {
        await Task.detached {
            let output = FileManager.default.temporaryDirectory.appending(path: "alethe-path-\(UUID().uuidString)")
            guard FileManager.default.createFile(atPath: output.path, contents: nil),
                  let handle = try? FileHandle(forWritingTo: output) else { return nil }
            defer {
                try? handle.close()
                try? FileManager.default.removeItem(at: output)
            }
            let shell = Process()
            shell.executableURL = URL(filePath: ShellLaunch.userShell)
            shell.arguments = ["-l", "-i", "-c", CLIShim.pathProbeCommand]
            shell.currentDirectoryURL = URL(filePath: NSHomeDirectory())
            // A file, not a pipe: a chatty profile can never fill a buffer and stall the probe.
            shell.standardOutput = handle
            shell.standardError = FileHandle.nullDevice
            shell.standardInput = FileHandle.nullDevice
            do { try shell.run() } catch { return nil }
            let deadline = Date().addingTimeInterval(5)
            while shell.isRunning, Date() < deadline {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if shell.isRunning {
                shell.terminate()
                return nil
            }
            guard let data = try? Data(contentsOf: output) else { return nil }
            return CLIShim.parsePathProbe(String(decoding: data, as: UTF8.self))
        }.value
    }
}
