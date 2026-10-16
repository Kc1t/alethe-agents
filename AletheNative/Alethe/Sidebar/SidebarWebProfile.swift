import AletheDesign
import AletheModel
import SwiftUI

/// Web sidebar identity row, using the existing local profile switching actions.
struct SidebarWebProfile: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var switching: ProfileEntry?
    @State private var showingMenu = false

    var body: some View {
        Button { showingMenu.toggle() } label: {
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
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "gearshape")
                    .font(metrics.font(size: 13))
                    .foregroundStyle(theme[.fgFaint])
                    .fixedSize()
            }
            .padding(.horizontal, metrics.size(12))
            .padding(.vertical, metrics.size(14))
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .aletheRowBackground(isSelected: showingMenu)
        .frame(maxWidth: .infinity)
        .fixedSize(horizontal: false, vertical: true)
        .background(theme[.bg])
        .overlay(alignment: .top) {
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
        }
        .help(Text(verbatim: String(format: String(localized: "profiles.menu.help"), environment.activeProfileName)))
        .accessibilityIdentifier("leftSidebar.profile")
        .popover(isPresented: $showingMenu, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Button("leftSidebar.preferences") {
                    showingMenu = false
                    openSettings()
                }
                Divider()
                ForEach(environment.profiles?.document.ordered(defaultName: AppEnvironment.defaultProfileName) ?? []) { entry in
                    Toggle(isOn: Binding {
                        entry.id == environment.profileID
                    } set: { chosen in
                        if chosen, entry.id != environment.profileID {
                            showingMenu = false
                            switching = entry
                        }
                    }) {
                        Text(verbatim: environment.profileName(entry))
                    }
                }
                Divider()
                Button("profiles.menu.manage") {
                    showingMenu = false
                    environment.settingsTab = .profiles
                    openSettings()
                }
                .accessibilityIdentifier("profiles.menu.manage")
            }
            .buttonStyle(AletheButtonStyle())
            .padding(metrics.size(4))
            .background(theme[.bg])
        }
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
