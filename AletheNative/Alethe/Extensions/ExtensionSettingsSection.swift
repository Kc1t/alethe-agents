import AletheDesign
import AletheExtensionHost
import AlethePluginKit
import ExtensionKit
import SwiftUI

/// Settings › Plugins › Third-party extensions (P4-19): discovered ExtensionKit extensions with an
/// enable toggle that goes through the consent prompt, their commands, and the system approval UI.
struct ExtensionSettingsSection: View {
    let manager: ExtensionManager
    @Environment(\.theme) private var theme
    @State private var showingSystemBrowser = false

    var body: some View {
        Section {
            if manager.entries.isEmpty {
                Text("extensions.empty")
                    .foregroundStyle(theme[.textSecondary])
            }
            ForEach(manager.entries) { entry in
                ExtensionRow(entry: entry, manager: manager)
            }
            if let error = manager.discoveryError {
                Label {
                    Text(verbatim: error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.callout)
                .foregroundStyle(theme[.statusStopped])
                .textSelection(.enabled)
            }
            Button("extensions.manage") { showingSystemBrowser = true }
                .accessibilityIdentifier("extensions.manage")
        } header: {
            Text("extensions.section")
        } footer: {
            if manager.awaitingSystemApproval > 0 {
                Text(verbatim: String(format: String(localized: "extensions.awaitingApproval"), manager.awaitingSystemApproval))
            } else {
                Text("extensions.help")
            }
        }
        .sheet(isPresented: $showingSystemBrowser) {
            VStack(spacing: 0) {
                ExtensionBrowser()
                    .frame(minWidth: 480, minHeight: 320)
                HStack {
                    Spacer()
                    Button("extensions.done") { showingSystemBrowser = false }
                        .keyboardShortcut(.defaultAction)
                }
                .padding()
            }
        }
        // Web interface: the themed window overlay; closing it (X, backdrop, Escape) declines.
        .gitWebSheet(item: Binding { manager.pendingConsent } set: { value in
            if value == nil { manager.resolveConsent(approved: false) } else { manager.pendingConsent = value }
        }, width: 480) { request in
            ExtensionConsentSheet(request: request) { approved in
                manager.resolveConsent(approved: approved)
            }
        }
    }
}

private struct ExtensionRow: View {
    let entry: ExtensionManager.Entry
    let manager: ExtensionManager
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Toggle(isOn: enabled) {
                HStack(spacing: metrics.space(.s)) {
                    Text(verbatim: entry.manifest?.name ?? entry.identity.localizedName)
                    if let version = entry.manifest?.version {
                        Text(verbatim: String(format: String(localized: "settings.plugins.version"), version))
                            .foregroundStyle(theme[.textSecondary])
                            .monospacedDigit()
                    }
                }
                Text(verbatim: entry.id)
                    .foregroundStyle(theme[.textTertiary])
            }
            .disabled(entry.manifest == nil)
            .accessibilityIdentifier("extensions.\(entry.id)")
            status
            if manager.isActive(entry), let commands = entry.payload?.commands, !commands.isEmpty {
                HStack(spacing: metrics.space(.s)) {
                    ForEach(commands) { command in
                        Button {
                            manager.runCommand(command.id, of: entry.id)
                        } label: {
                            Text(verbatim: command.title)
                        }
                        .accessibilityIdentifier("extensions.command.\(command.id)")
                    }
                    if let reply = entry.lastReply {
                        Text(verbatim: reply)
                            .foregroundStyle(theme[.textSecondary])
                            .accessibilityIdentifier("extensions.reply.\(entry.id)")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch entry.status {
        case .loading:
            Text("extensions.loading").foregroundStyle(theme[.textSecondary])
        case .ready:
            if let manifest = entry.manifest, manager.state.enabled.contains(manifest.id), !manager.isActive(entry) {
                Text("extensions.reviewNeeded").foregroundStyle(theme[.statusWaiting])
            }
        case .failed(let error):
            Label {
                Text(verbatim: error)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.callout)
            .foregroundStyle(theme[.statusStopped])
            .textSelection(.enabled)
        case .stopped:
            HStack {
                Text("extensions.stopped.title").foregroundStyle(theme[.statusStopped])
                Button("extensions.stopped.reload") { manager.reload(entry.id) }
            }
        }
    }

    private var enabled: Binding<Bool> {
        Binding {
            manager.isActive(entry)
        } set: { value in
            manager.setEnabled(value, for: entry.id)
        }
    }
}

/// The capability prompt shown on first enable, and when an update asks for more.
struct ExtensionConsentSheet: View {
    let request: ExtensionManager.ConsentRequest
    let resolve: (Bool) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if metrics.isWebInterface {
                ModalsM2WebModal(title: Text(verbatim: String(format: String(localized: "extensions.consent.title"), request.manifest.name)),
                                 close: { resolve(false) }) {
                    VStack(alignment: .leading, spacing: metrics.size(14)) {
                        Label("extensions.consent.message", systemImage: "exclamationmark.shield")
                            .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                        Text("settings.plugins.capabilities").font(metrics.font(size: 9, weight: .bold))
                            .textCase(.uppercase).tracking(metrics.size(0.9)).foregroundStyle(theme[.fgFaint])
                        let capabilities = PluginCapability.allCases.filter { request.capabilities.contains($0) }
                        if capabilities.isEmpty { Text("settings.plugins.noCapabilities") }
                        ForEach(capabilities, id: \.self) { capability in
                            Text(verbatim: capability.localizedName).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                        }
                    }
                } footer: {
                    Spacer()
                    Button("extensions.consent.deny") { resolve(false) }.keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("extensions.consent.deny")
                    Button("extensions.consent.allow") { resolve(true) }.buttonStyle(AletheButtonStyle(.primary))
                        .keyboardShortcut(.defaultAction).accessibilityIdentifier("extensions.consent.allow")
                }
            } else { nativeBody }
        }.accessibilityIdentifier("extensions.consent")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            Text(verbatim: String(format: String(localized: "extensions.consent.title"), request.manifest.name))
                .font(.headline)
            Text("extensions.consent.message")
                .foregroundStyle(theme[.textSecondary])
            let capabilities = PluginCapability.allCases.filter { request.capabilities.contains($0) }
            if capabilities.isEmpty {
                Text("settings.plugins.noCapabilities")
            } else {
                ForEach(capabilities, id: \.self) { capability in
                    Label {
                        Text(verbatim: capability.localizedName)
                    } icon: {
                        Image(systemName: "checkmark.shield")
                    }
                }
            }
            HStack {
                Spacer()
                Button("extensions.consent.deny", role: .cancel) { resolve(false) }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("extensions.consent.deny")
                Button("extensions.consent.allow") { resolve(true) }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("extensions.consent.allow")
            }
        }
        .padding(metrics.space(.l))
        .frame(width: 420)
        .accessibilityIdentifier("extensions.consent")
    }
}

/// The system's enable/approve list for extensions of Alethe's point.
private struct ExtensionBrowser: NSViewControllerRepresentable {
    func makeNSViewController(context: Context) -> EXAppExtensionBrowserViewController {
        EXAppExtensionBrowserViewController()
    }

    func updateNSViewController(_ controller: EXAppExtensionBrowserViewController, context: Context) {}
}
