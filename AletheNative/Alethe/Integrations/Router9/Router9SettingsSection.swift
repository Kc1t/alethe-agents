import AletheDesign
import AletheIntegrations
import AletheModel
import AppKit
import SwiftUI

/// Settings › Integrations › 9router (upstream `Router9Settings`): enable, source, port, the API key
/// (Keychain only, never shown again after it is saved), auto-start, default for new agents, status,
/// Start/Stop, Open Dashboard, the log, and the advisories and docs links.
struct Router9SettingsSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.openURL) private var openURL
    @State private var keyDraft = ""
    @State private var installAction: Router9Controller.InstallAction?

    private var controller: Router9Controller { environment.router9 }
    private var preferences: Router9Preferences { controller.preferences }

    var body: some View {
        Section {
            statusRow
            if controller.status != nil, !controller.hasInstall {
                LabeledContent {
                    Button("router9.installForMe") { installAction = .install }
                        .accessibilityIdentifier("router9.install")
                } label: {
                    Text("router9.setup")
                    Text("router9.setup.help")
                }
            }
            if controller.hasInstall {
                installRow
                if controller.status?.managed.installed == true, controller.status?.external.installed == true {
                    if metrics.isWebInterface {
                        VStack(alignment: .leading, spacing: metrics.size(6)) {
                            Text("router9.source").font(metrics.font(size: 11, weight: .semibold))
                                .foregroundStyle(theme[.fgMuted])
                            AletheWebChoiceSegments(selection: binding(\.source),
                                options: [AletheModel.Router9Source.managed, .external]) {
                                Text($0 == .managed ? "router9.source.managed" : "router9.source.external")
                            }
                        }.accessibilityIdentifier("router9.source")
                .settingsRowSurface(.standalone)
                    } else {
                        Picker(selection: binding(\.source)) {
                            Text("router9.source.managed").tag(AletheModel.Router9Source.managed)
                            Text("router9.source.external").tag(AletheModel.Router9Source.external)
                        } label: {
                            Text("router9.source")
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("router9.source")
                    }
                }
                Toggle(isOn: binding(\.enabled)) { Text("router9.enabled") }
                    .accessibilityIdentifier("router9.enabled")
                if preferences.enabled { connectionRows }
            }
            notices
        } header: {
            Text(verbatim: "9router")
        } footer: {
            footer
        }
        .task { await controller.watch() }
        .gitWebSheet(item: $installAction, width: 480) { action in
            Router9InstallSheet(action: action)
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.router9")
    }

    // MARK: Rows

    private var statusRow: some View {
        LabeledContent {
            if controller.hasInstall, preferences.enabled {
                HStack {
                    Button(controller.isRunning ? "router9.stop" : "router9.start") {
                        Task { await controller.toggleRunning() }
                    }
                    .disabled(controller.busy)
                    .accessibilityIdentifier("router9.toggleRunning")
                    Button("router9.dashboard") {
                        if let url = controller.status.flatMap({ URL(string: $0.dashboardURL) }) { openURL(url) }
                    }
                    .disabled(!controller.isRunning)
                    .accessibilityIdentifier("router9.dashboard")
                }
            }
        } label: {
            HStack(spacing: metrics.space(.s)) {
                Circle()
                    .fill(theme[stateToken])
                    .frame(width: metrics.size(8), height: metrics.size(8))
                    .accessibilityHidden(true)
                Text(verbatim: stateText)
                    .accessibilityIdentifier("router9.state")
            }
        }
    }

    private var installRow: some View {
        LabeledContent {
            HStack {
                Button(installTitle) { installAction = .install }
                .disabled(controller.hasNPM != true)
                .accessibilityIdentifier("router9.install")
                if controller.status?.managed.installed == true {
                    Button("router9.uninstall", role: .destructive) { installAction = .uninstall }
                        .disabled(controller.busy)
                        .accessibilityIdentifier("router9.uninstall")
                }
            }
        } label: {
            if controller.resolved?.source == .external {
                Text("router9.source.external")
                Text(verbatim: String(format: String(localized: "router9.externalInstalled"),
                                      controller.status?.external.version ?? "?",
                                      controller.status?.external.path ?? ""))
            } else {
                Text("router9.source.managed")
                Text(verbatim: String(format: String(localized: "router9.managedInstalled"),
                                      controller.status?.managed.version ?? "?"))
            }
        }
        .accessibilityIdentifier("router9.installInfo")
    }

    @ViewBuilder
    private var connectionRows: some View {
        LabeledContent {
            if controller.hasAPIKey {
                HStack {
                    Text("router9.apiKey.saved")
                        .foregroundStyle(theme[.textSecondary])
                        .accessibilityIdentifier("router9.apiKey.saved")
                    Button("router9.apiKey.remove") { controller.removeAPIKey() }
                        .accessibilityIdentifier("router9.apiKey.remove")
                }
            } else {
                HStack {
                    SecureField(text: $keyDraft, prompt: Text(verbatim: "9r_…")) { Text("router9.apiKey") }
                        .labelsHidden()
                        .webFieldSurface()
                        .frame(width: metrics.size(200))
                        .onSubmit(saveKey)
                        .accessibilityIdentifier("router9.apiKey.field")
                    Button("router9.apiKey.save", action: saveKey)
                        .disabled(keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("router9.apiKey.save")
                }
            }
        } label: {
            Text("router9.apiKey")
            Text("router9.apiKey.help")
        }
        TextField(value: portBinding, format: .number.grouping(.never)) { Text("router9.port") }
            .webFieldSurface()
            .accessibilityIdentifier("router9.port")
                .settingsRowSurface(.standalone)
        Toggle(isOn: binding(\.autoStart)) {
            Text("router9.autoStart")
            Text("router9.autoStart.help")
        }
        .accessibilityIdentifier("router9.autoStart")
        Toggle(isOn: binding(\.defaultForNewAgents)) {
            Text("router9.defaultForNewAgents")
            Text("router9.defaultForNewAgents.help")
        }
        .accessibilityIdentifier("router9.defaultForNewAgents")
    }

    @ViewBuilder
    private var notices: some View {
        ForEach(noticeList, id: \.text) { notice in
            Label {
                Text(verbatim: notice.text)
            } icon: {
                Image(systemName: notice.warns ? "exclamationmark.triangle" : "info.circle")
            }
            .font(metrics.font(.footnote))
            .foregroundStyle(theme[notice.warns ? .statusWaiting : .textSecondary])
            .textSelection(.enabled)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Text("router9.securityNote")
                .foregroundStyle(theme[.textSecondary])
            HStack(spacing: metrics.space(.l)) {
                Button("router9.advisories") { openURL(Router9.advisoriesURL) }
                    .accessibilityIdentifier("router9.advisories")
                Button("router9.docs") { openURL(Router9.docsURL) }
                    .accessibilityIdentifier("router9.docs")
                if let log = controller.status?.logPath {
                    Button("router9.log") { Self.reveal(log) }
                        .accessibilityIdentifier("router9.log")
                }
            }
            .buttonStyle(.link)
        }
        .font(metrics.font(.footnote))
    }

    // MARK: State

    private enum State { case probing, off, ready, running }

    private var state: State {
        if controller.status == nil { return .probing }
        if !preferences.enabled { return .off }
        return controller.isRunning ? .running : .ready
    }

    private var stateText: String {
        switch state {
        case .probing: String(localized: "router9.state.probing")
        case .off: String(localized: "router9.state.off")
        case .ready: String(localized: "router9.state.ready")
        case .running: String(format: String(localized: "router9.state.running"), Router9.baseURL(port: preferences.port))
        }
    }

    private var stateToken: ThemeToken {
        switch state {
        case .probing, .off: .statusDisabled
        case .ready: .statusIdle
        case .running: .statusActive
        }
    }

    private struct Notice { var text: String; var warns: Bool }

    private var noticeList: [Notice] {
        var list: [Notice] = []
        let status = controller.status
        if controller.hasNPM == false { list.append(Notice(text: String(localized: "router9.notice.node"), warns: true)) }
        if let resolved = controller.resolved, resolved.source != AletheIntegrations.Router9Source(preferences.source) {
            let key: String.LocalizationValue = resolved.source == .external
                ? "router9.notice.fallbackExternal" : "router9.notice.fallbackManaged"
            list.append(Notice(text: String(localized: key), warns: true))
        }
        if preferences.enabled, controller.hasInstall, !controller.hasAPIKey {
            list.append(Notice(text: String(localized: "router9.notice.missingKey"), warns: true))
        }
        if let status, status.portInUse, !status.running {
            list.append(Notice(text: String(format: String(localized: "router9.notice.portInUse"), String(status.port)), warns: true))
        }
        if let status, let version = status.managed.version, status.managed.installed, version != status.pinnedVersion {
            list.append(Notice(text: String(localized: "router9.notice.pinned"), warns: false))
        }
        if preferences.enabled, controller.isRunning {
            list.append(Notice(text: String(localized: "router9.notice.runningTerminals"), warns: false))
        }
        if let failure = controller.failure { list.append(Notice(text: failure.message, warns: true)) }
        return list
    }

    private var installTitle: String {
        guard let status = controller.status, status.managed.installed else { return String(localized: "router9.installManaged") }
        return String(format: String(localized: "router9.update"), status.pinnedVersion)
    }

    // MARK: Actions

    private func saveKey() {
        let key = keyDraft
        keyDraft = ""
        controller.saveAPIKey(key)
    }

    private var portBinding: Binding<Int> {
        Binding { preferences.port } set: { value in controller.update { $0.port = value } }
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<Router9Preferences, Value>) -> Binding<Value> {
        Binding { preferences[keyPath: keyPath] } set: { value in controller.update { $0[keyPath: keyPath] = value } }
    }

    private static func reveal(_ path: String) {
        let url = URL(filePath: path)
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }
}

extension Router9Controller.Failure {
    /// A user-facing sentence; never includes the API key.
    var message: String {
        switch self {
        case .keychain: String(localized: "router9.error.keychain")
        case .service(let error):
            switch error {
            case .notInstalled: String(localized: "router9.error.notInstalled")
            case .nodeNotFound: String(localized: "router9.error.node")
            case .portInUse: String(localized: "router9.error.portInUse")
            case .cancelled: String(localized: "router9.error.cancelled")
            case .fileSystem(let detail), .spawnFailed(let detail):
                String(format: String(localized: "router9.error.failed"), detail)
            }
        }
    }
}
