import AletheDesign
import AletheFoundation
import AlethePluginKit
import SwiftUI

/// Settings › Plugins (upstream `PluginsPage`): each built-in plugin with its version, declared
/// capabilities, an enabled toggle and, when it failed to load, its error; then the third-party
/// ExtensionKit extensions (P4-19).
struct PluginSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        SettingsPageForm("plugins") {
            Section {
                if let plugins = environment.plugins, !plugins.records.isEmpty {
                    ForEach(plugins.records) { record in PluginRow(record: record, host: plugins) }
                } else { Text("settings.plugins.empty") }
            } header: { Text("settings.web.reference.prefs.pluginsInstalledTitle") }
              footer: { Text("settings.web.reference.prefs.pluginsInstalledDesc") }
            Section {
                Text("settings.web.unavailable")
            } header: { Text("settings.web.reference.market.title") }
              footer: { Text("settings.web.reference.prefs.pluginsMarketplaceDesc") }
            Section {
                TextEditor(text: .constant(""))
                    .font(metrics.monoFont(size: 11, weight: .regular))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, metrics.size(12))
                    .padding(.vertical, metrics.size(10))
                    .frame(height: metrics.size(104))
                    .disabled(true)
                    .accessibilityLabel(Text("settings.web.reference.prefs.pluginsInstallTitle"))
                Text("settings.web.unavailable")
            } header: { Text("settings.web.reference.prefs.pluginsInstallTitle") }
              footer: { Text("settings.web.reference.prefs.pluginsInstallDesc") }
        }
        .accessibilityIdentifier("settings.plugins")
    }

    private var nativeBody: some View {
        AletheSettingsForm {
            Section {
                if let plugins = environment.plugins, !plugins.records.isEmpty {
                    ForEach(plugins.records) { record in
                        PluginRow(record: record, host: plugins)
                    }
                } else {
                    Text("settings.plugins.empty")
                        .foregroundStyle(theme[.textSecondary])
                }
            } footer: {
                Text("settings.plugins.help")
            }
            if let extensions = environment.extensions {
                ExtensionSettingsSection(manager: extensions)
            }
        }
        .formStyle(.grouped)
        .modifier(AletheSettingsSizing())
        .accessibilityIdentifier("settings.plugins")
    }
}

private struct PluginRow: View {
    let record: PluginHost.Record
    let host: PluginHost
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Toggle(isOn: enabled) {
                HStack(spacing: metrics.space(.s)) {
                    Text(verbatim: record.manifest.name)
                    Text(verbatim: String(format: String(localized: "settings.plugins.version"), record.manifest.version))
                        .foregroundStyle(theme[.textSecondary])
                        .monospacedDigit()
                }
                capabilities
            }
            .accessibilityIdentifier("settings.plugins.\(record.id)")
            if case .failed(let error) = record.state {
                Label {
                    Text(verbatim: error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").webProfileSized(14)
                }
                .font(metrics.isWebInterface ? metrics.font(size: 11) : .callout)
                .foregroundStyle(theme[.statusStopped])
                .textSelection(.enabled)
                .accessibilityIdentifier("settings.plugins.\(record.id).error")
            }
        }
    }

    @ViewBuilder
    private var capabilities: some View {
        let declared = PluginCapability.allCases.filter { record.manifest.capabilities.contains($0) }
        if declared.isEmpty {
            Text("settings.plugins.noCapabilities")
        } else {
            Text(verbatim: String(format: String(localized: "settings.plugins.capabilities"),
                                      declared.map(\.localizedName).formatted(.list(type: .and))))
        }
    }

    private var enabled: Binding<Bool> {
        Binding {
            record.isEnabled
        } set: { value in
            Task { try? await host.setEnabled(value, for: record.id) }
        }
    }
}

extension PluginCapability {
    var localizedName: String {
        switch self {
        case .git: String(localized: "settings.plugins.capability.git")
        case .filesystemRead: String(localized: "settings.plugins.capability.filesystemRead")
        case .filesystemWrite: String(localized: "settings.plugins.capability.filesystemWrite")
        case .terminalInput: String(localized: "settings.plugins.capability.terminalInput")
        case .network: String(localized: "settings.plugins.capability.network")
        case .storage: String(localized: "settings.plugins.capability.storage")
        }
    }
}
