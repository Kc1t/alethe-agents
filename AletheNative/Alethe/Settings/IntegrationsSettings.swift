import AletheDesign
import SwiftUI

/// Settings › Integrations (upstream `IntegrationsPage`): one section per service, each filled by
/// its own task (Spotify P7-14, Discord P7-13, 9router P7-16).
struct IntegrationsSettings: View {
    @Environment(\.metrics) private var metrics
    @State private var showingUsage = false
    var body: some View {
        SettingsPageForm {
            if metrics.isWebInterface {
                Section {
                    Button("usage.title") { showingUsage = true }
                } header: { Text("settings.web.reference.prefs.usageAccess") }
                  footer: { Text("settings.web.reference.prefs.usageAccessDesc") }
                CommandLineToolSection()
                Router9SettingsSection()
                SpotifySettingsSection()
                DiscordSettingsSection()
                Section { Text("settings.web.unavailable") }
                    header: { Text("settings.web.reference.prefs.dictation") }
                    footer: { Text("settings.web.reference.prefs.dictationDesc") }
            } else {
                SpotifySettingsSection()
                DiscordSettingsSection()
                Router9SettingsSection()
            }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("settings.integrations")
        .sheet(isPresented: $showingUsage) { AIUsageSheet() }
    }
}
