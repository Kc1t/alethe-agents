import AletheDesign
import AletheModel
import SwiftUI

/// The standard Settings window (⌘,).
struct SettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if metrics.isWebInterface { WebSettingsView() } else { nativeBody }
        }
        .gitWebModalLayer()
        .newTerminalDropdownLayer()
        .webDialogLayer()
    }

    private var nativeBody: some View {
        @Bindable var environment = environment
        return TabView(selection: $environment.settingsTab) {
            Tab("settings.general.tab", systemImage: "gearshape", value: SettingsTab.general) {
                GeneralSettings()
            }
            Tab("settings.appearance.tab", systemImage: "paintpalette", value: SettingsTab.appearance) {
                AppearanceSettings()
            }
            Tab("settings.toolbar", systemImage: "menubar.rectangle", value: SettingsTab.toolbar) {
                ToolbarSettings()
            }
            Tab("settings.agents.tab", systemImage: "sparkles", value: SettingsTab.agents) {
                AgentSettings()
            }
            Tab("settings.resources.tab", systemImage: "memorychip", value: SettingsTab.resources) {
                ResourceSettings()
            }
            Tab("settings.features.tab", systemImage: "square.grid.2x2", value: SettingsTab.features) {
                FeatureSettings()
            }
            Tab("settings.plugins.tab", systemImage: "puzzlepiece.extension", value: SettingsTab.plugins) {
                PluginSettings()
            }
            // Grouped: the builder takes ten children at most.
            Group {
                Tab("settings.integrations.tab", systemImage: "link", value: SettingsTab.integrations) {
                    IntegrationsSettings()
                }
                Tab("settings.remote.tab", systemImage: "iphone.radiowaves.left.and.right", value: SettingsTab.remote) {
                    RemoteSettings()
                }
            }
            if environment.features.isOn(.orchestrator) {
                Tab("settings.multiagent.tab", systemImage: "point.3.connected.trianglepath.dotted", value: SettingsTab.multiagent) {
                    MultiagentSettings()
                }
            }
            Tab("settings.profiles.tab", systemImage: "person.2", value: SettingsTab.profiles) {
                ProfileSettings()
            }
        }
        // Wide enough for every tab in the toolbar, none in its overflow menu.
        .frame(width: metrics.size(720) / metrics.scale)
        .scenePadding()
        .onChange(of: environment.features.isOn(.orchestrator)) { _, isOn in
            if !isOn, environment.settingsTab == .multiagent { environment.settingsTab = .general }
        }
    }
}

/// The Settings pane shown; Home's setup steps open a given one.
enum SettingsTab: Hashable {
    case general, appearance, toolbar, agents, resources, features, plugins, integrations, remote, multiagent, profiles
}

struct GeneralSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @State private var confirmClear = false

    var body: some View {
        AletheSettingsForm {
            Toggle(isOn: binding(\.alwaysStartUnrestricted)) {
                Text("settings.general.alwaysUnrestricted")
                Text("settings.general.alwaysUnrestricted.help")
            }
            .disabled(environment.preferences == nil)
            .accessibilityIdentifier("settings.alwaysUnrestricted")
            Toggle(isOn: optional(\.startClean, default: false)) {
                Text("settings.general.startClean")
                Text("settings.general.startClean.help")
            }
            .accessibilityIdentifier("settings.startClean")
            Toggle(isOn: optional(\.startOnHome, default: false)) {
                Text("settings.general.startOnHome")
                Text("settings.general.startOnHome.help")
            }
            .accessibilityIdentifier("settings.startOnHome")
            Toggle(isOn: optional(\.confirmQuit, default: true)) {
                Text("settings.general.confirmQuit")
                Text("settings.general.confirmQuit.help")
            }
            .accessibilityIdentifier("settings.confirmQuit")
            Toggle(isOn: optional(\.notifyAgents, default: true)) {
                Text("settings.general.notifyAgents")
                Text("settings.general.notifyAgents.help")
            }
            .accessibilityIdentifier("settings.notifyAgents")
            LabeledContent {
                Button("settings.general.clearActivity") { confirmClear = true }
                    .accessibilityIdentifier("settings.clearActivity")
            } label: {
                Text("settings.general.activity")
                Text("settings.general.activity.help")
            }
            CommandLineToolSection()
            DataSettingsSection()
        }
        .formStyle(.grouped)
        .webConfirm(isPresented: $confirmClear, message: String(localized: "settings.general.clearActivity.confirm"), confirmTitle: String(localized: "settings.general.clearActivity"), destructive: true) {
            environment.activity.clear()
        }
        .confirmationDialog(Text("settings.general.clearActivity.confirm"), isPresented: Binding(get: { !metrics.isWebInterface && confirmClear }, set: { confirmClear = $0 })) {
            Button("settings.general.clearActivity", role: .destructive) { environment.activity.clear() }
        }
    }

    private func optional(_ keyPath: WritableKeyPath<PreferencesDocument, Bool?>, default value: Bool) -> Binding<Bool> {
        Binding {
            environment.preferences?.document[keyPath: keyPath] ?? value
        } set: { newValue in
            environment.preferences?.update { $0[keyPath: keyPath] = newValue == value ? nil : newValue }
        }
    }

    private func binding(_ keyPath: WritableKeyPath<PreferencesDocument, Bool>) -> Binding<Bool> {
        Binding {
            environment.preferences?.document[keyPath: keyPath] ?? false
        } set: { value in
            environment.preferences?.update { $0[keyPath: keyPath] = value }
        }
    }
}
