import AletheDesign
import AletheModel
import SwiftUI

/// Web sidebar identity row, using the existing local profile switching actions.
struct SidebarWebProfile: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    private let sidebar = true
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
                HStack(spacing: metrics.size(10)) {
                    Text(verbatim: String(environment.activeProfileName.prefix(1)).uppercased())
                        .font(metrics.font(size: 13, weight: .bold))
                        .foregroundStyle(theme[.fg])
                        .frame(width: metrics.size(34), height: metrics.size(34))
                        .background(theme[.bgSunken], in: Circle())
                        .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(verbatim: environment.activeProfileName)
                            .font(metrics.font(size: 13, weight: .semibold))
                            .foregroundStyle(theme[.fg])
                        Text(verbatim: String(format: String(localized: "leftSidebar.localAccount"),
                                             environment.activeProfileName))
                            .font(metrics.font(size: 11))
                            .foregroundStyle(theme[.fgFaint])
                    }
                    .lineLimit(1)
                    Spacer(minLength: metrics.space(.xs))
                    Image(systemName: "gearshape")
                        .font(metrics.font(size: 13))
                        .foregroundStyle(theme[.fgFaint])
                }
                .padding(.horizontal, metrics.size(12))
                .padding(.vertical, metrics.size(14))
                .contentShape(Rectangle())
            } else {
                Label {
                    Text(verbatim: environment.activeProfileName)
                } icon: {
                    Image(systemName: "person.crop.circle")
                }
            }
        }
        .overlay(alignment: .top) {
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
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
