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
    @State private var showsWebMenu = false

    var body: some View {
        Group {
            if metrics.isWebInterface, !sidebar {
                Button { showsWebMenu.toggle() } label: {
                    HStack(spacing: metrics.size(6)) {
                        Image(systemName: "person.2").resizable().scaledToFit()
                            .frame(width: metrics.size(12), height: metrics.size(12))
                        Text(verbatim: environment.activeProfileName).lineLimit(1)
                    }
                }
                .buttonStyle(AletheTitleBarPillStyle())
                .webTitleBarPopover(isPresented: $showsWebMenu, width: 220) { webMenu }
                .help(Text(verbatim: String(format: String(localized: "profiles.menu.help"), environment.activeProfileName)))
                .accessibilityIdentifier("profiles.menu")
                .confirmationDialog(Text(verbatim: String(format: String(localized: "settings.profiles.switch.confirm"),
                                                          switching.map(environment.profileName) ?? "")),
                                    isPresented: Binding { switching != nil } set: { if !$0 { switching = nil } }) {
                    Button("settings.profiles.switch") {
                        guard let entry = switching else { return }
                        Task { try? await environment.switchProfile(to: entry.id) }
                    }
                } message: { Text("settings.profiles.switch.message") }
            } else { nativeMenu }
        }
    }

    private var webMenu: some View {
        VStack(spacing: metrics.size(2)) {
            ForEach(environment.profiles?.document.ordered(defaultName: AppEnvironment.defaultProfileName) ?? []) { entry in
                Button {
                    showsWebMenu = false
                    if entry.id != environment.profileID { switching = entry }
                } label: {
                    HStack(spacing: metrics.size(8)) {
                        Text(verbatim: environment.profileName(entry)).lineLimit(1)
                        Spacer(minLength: 0)
                        if entry.id == environment.profileID {
                            Image(systemName: "checkmark").resizable().scaledToFit()
                                .frame(width: metrics.size(14), height: metrics.size(14))
                        }
                    }
                }
                .accessibilityAddTraits(entry.id == environment.profileID ? [.isSelected] : [])
            }
            theme[.border].frame(height: metrics.size(1)).padding(.vertical, metrics.size(4))
            Button("profiles.menu.manage") {
                showsWebMenu = false
                environment.settingsTab = .profiles
                openSettings()
            }.accessibilityIdentifier("profiles.menu.manage")
        }
        .buttonStyle(AletheTitleBarMenuRowStyle())
        .padding(metrics.size(4)).frame(width: metrics.size(220))
        .modifier(AletheTitleBarSurface())
        .onExitCommand { showsWebMenu = false }
    }

    private var nativeMenu: some View {
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
                    if metrics.isWebInterface {
                        Image("DefaultProfile")
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: metrics.size(32), height: metrics.size(32))
                            .clipShape(Circle())
                            .accessibilityHidden(true)
                    } else {
                        Text(verbatim: String(environment.activeProfileName.prefix(1)).uppercased())
                            .font(metrics.font(.headline))
                            .foregroundStyle(theme[.accentOn])
                            .frame(width: metrics.size(32), height: metrics.size(32))
                            .background(theme[.accent], in: Circle())
                            .accessibilityHidden(true)
                    }
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
                        .lineLimit(metrics.isWebInterface ? 1 : nil)
                } icon: {
                    if metrics.isWebInterface {
                        Image(systemName: "person.2")
                            .resizable().scaledToFit()
                            .frame(width: metrics.size(12), height: metrics.size(12))
                    } else {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
        }
        .menuIndicator(sidebar || metrics.isWebInterface ? .hidden : .automatic)
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
