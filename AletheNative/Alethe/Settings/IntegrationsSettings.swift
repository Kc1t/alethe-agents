import AletheDesign
import SwiftUI

/// Settings › Integrations (upstream `IntegrationsPage`): one section per service, each filled by
/// its own task (Spotify P7-14, Discord P7-13, 9router P7-16).
struct IntegrationsSettings: View {
    var body: some View {
        AletheSettingsForm {
            SpotifySettingsSection()
            DiscordSettingsSection()
            Router9SettingsSection()
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("settings.integrations")
    }
}
