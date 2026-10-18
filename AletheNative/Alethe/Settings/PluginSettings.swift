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

    @State private var webModel = PluginCatalogWebModel()
    @State private var marketplace = false
    @State private var uninstallID: String?

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        SettingsPageForm("plugins") {
            Section {
                if let plugins = environment.plugins, !plugins.records.isEmpty {
                    ForEach(plugins.records) { record in PluginInstalledWebRow(record: record, host: plugins) }
                } else if webModel.local.isEmpty { Text("settings.plugins.empty") }
                ForEach(webModel.local) { manifest in
                    HStack(spacing: metrics.size(16)) {
                        VStack(alignment: .leading, spacing: metrics.size(6)) {
                            HStack(spacing: metrics.size(8)) {
                                Text(verbatim: manifest.name).font(metrics.font(size: 12, weight: 600))
                                Text(verbatim: manifest.version).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint])
                            }
                            Text(verbatim: manifest.description).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                            Text("plugins.web.unavailable").font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                            WebDisclosure {
                                Text("settings.web.reference.market.detailCapabilities").font(metrics.font(size: 11))
                                    .foregroundStyle(theme[.fgMuted])
                            } content: {
                                VStack(alignment: .leading, spacing: metrics.size(2)) {
                                    ForEach(manifest.capabilities, id: \.self) { Text(verbatim: $0).font(metrics.monoFont(size: 10)) }
                                }
                            }
                        }
                        Spacer(minLength: 0)
                        Button("settings.web.reference.market.uninstall", role: .destructive) { uninstallID = manifest.id }
                    }.padding(metrics.size(2))
                }
            } header: { Text("settings.web.reference.prefs.pluginsInstalledTitle") }
              footer: { Text("settings.web.reference.prefs.pluginsInstalledDesc") }
            Section {
                Button("settings.web.reference.prefs.pluginsMarketplaceOpen") { marketplace = true }
            } header: { Text("settings.web.reference.market.title") }
              footer: { Text("settings.web.reference.prefs.pluginsMarketplaceDesc") }
            Section {
                PluginCatalogWebSection(model: webModel)
            } header: { Text("settings.web.reference.prefs.pluginsCatalogTitle") }
              footer: { Text("settings.web.reference.prefs.pluginsCatalogDesc") }
            Section {
                PluginInstallWebView(model: webModel)
            } header: { Text("settings.web.reference.prefs.pluginsInstallTitle") }
              footer: { Text("settings.web.reference.prefs.pluginsInstallDesc") }
        }
        .accessibilityIdentifier("settings.plugins")
        .task { webModel.configure(environment); await webModel.rescan() }
        .sheet(isPresented: $marketplace) { PluginMarketplaceWebView(model: webModel) }
        .webConfirm(isPresented: $webModel.error, message: String(localized: "plugins.web.operationError"),
                    confirmTitle: String(localized: "plugins.web.ok")) {}
        .webConfirm(isPresented: Binding(get: { uninstallID != nil }, set: { if !$0 { uninstallID = nil } }),
                    message: String(localized: "settings.web.reference.market.uninstallWarning"),
                    title: String(localized: "plugins.web.removeTitle"),
                    confirmTitle: String(localized: "settings.web.reference.market.uninstall"), destructive: true) {
            if let id = uninstallID { Task { await webModel.perform { try await $0.uninstall(id) } } }
        }
        .confirmationDialog("plugins.web.removeTitle", isPresented: Binding(get: { !metrics.isWebInterface && uninstallID != nil }, set: { if !$0 { uninstallID = nil } })) {
            Button("settings.web.reference.market.uninstall", role: .destructive) {
                if let id = uninstallID { Task { await webModel.perform { try await $0.uninstall(id) } } }
                uninstallID = nil
            }
        } message: { Text("settings.web.reference.market.uninstallWarning") }
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
