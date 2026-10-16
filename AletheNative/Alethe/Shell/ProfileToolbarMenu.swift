import AletheDesign
import AletheModel
import SwiftUI

/// The toolbar's profile menu (UI-7, upstream `UserProfile`): the running profile's name, the other
/// profiles to switch to (asks once, then relaunches) and Manage Profiles….
struct ProfileToolbarMenu: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    var sidebar = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var switching: ProfileEntry?

    var body: some View {
        Menu {
            if sidebar {
                Button("leftSidebar.preferences") { openSettings() }
                Divider()
            }
            ForEach(environment.profiles?.document.ordered(defaultName: AppEnvironment.defaultProfileName) ?? []) { entry in
                Toggle(isOn: Binding {
                    entry.id == environment.profileID
                } set: { chosen in
                    if chosen, entry.id != environment.profileID { switching = entry }
                }) {
                    Text(verbatim: environment.profileName(entry))
                }
            }
            Divider()
            Button("profiles.menu.manage") {
                environment.settingsTab = .profiles
                openSettings()
            }
            .accessibilityIdentifier("profiles.menu.manage")
        } label: {
            if sidebar {
                HStack(spacing: metrics.space(.s)) {
                    Text(verbatim: String(environment.activeProfileName.prefix(1)).uppercased())
                        .font(metrics.font(.headline))
                        .foregroundStyle(theme[.accentOn])
                        .frame(width: metrics.size(32), height: metrics.size(32))
                        .background(theme[.accent], in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                        Text(verbatim: environment.activeProfileName)
                            .font(metrics.font(.body))
                            .foregroundStyle(theme[.fg])
                        Text(verbatim: String(format: String(localized: "leftSidebar.localAccount"),
                                             environment.activeProfileName))
                            .font(metrics.font(.caption))
                            .foregroundStyle(theme[.fgMuted])
                    }
                    .lineLimit(1)
                    Spacer(minLength: metrics.space(.xs))
                    Image(systemName: "gearshape")
                        .foregroundStyle(theme[.fgMuted])
                }
                .padding(metrics.space(.s))
                .contentShape(Rectangle())
            } else {
                Label {
                    Text(verbatim: environment.activeProfileName)
                } icon: {
                    Image(systemName: "person.crop.circle")
                }
            }
        }
        .menuIndicator(sidebar ? .hidden : .automatic)
        .menuStyle(.borderlessButton)
        .help(Text(verbatim: String(format: String(localized: "profiles.menu.help"), environment.activeProfileName)))
        .accessibilityIdentifier(sidebar ? "leftSidebar.profile" : "profiles.menu")
        .confirmationDialog(Text(verbatim: String(format: String(localized: "settings.profiles.switch.confirm"),
                                                  switching.map(environment.profileName) ?? "")),
                            isPresented: Binding { switching != nil } set: { if !$0 { switching = nil } }) {
            Button("settings.profiles.switch") {
                guard let entry = switching else { return }
                Task { try? await environment.switchProfile(to: entry.id) }
            }
        } message: {
            Text("settings.profiles.switch.message")
        }
    }
}
