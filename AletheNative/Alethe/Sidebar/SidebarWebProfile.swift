import AppKit
import UniformTypeIdentifiers
import AletheDesign
import AletheModel
import SwiftUI

/// Web sidebar identity row, using the existing local profile switching actions.
struct SidebarWebProfile: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @AppStorage("sidebar.web.avatarImages") private var avatarImages = "{}"
    @State private var switching: ProfileEntry?
    @State private var showingMenu = false
    @State private var hovering = false
    @State private var rowWidth: CGFloat = 0

    var body: some View {
        Button { showingMenu.toggle() } label: {
            HStack(spacing: metrics.size(metrics.style == .clean ? 8 : 10)) {
                avatar
                    .aspectRatio(contentMode: .fill)
                    .frame(width: metrics.size(metrics.style == .clean ? 24 : 34),
                           height: metrics.size(metrics.style == .clean ? 24 : 34))
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .fixedSize()
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: environment.webDisplayName)
                        .font(metrics.font(size: metrics.style == .clean ? 11 : 13, weight: .semibold))
                        .foregroundStyle(theme[.fg])
                    Text(verbatim: String(format: String(localized: "leftSidebar.localAccount"),
                                         environment.webDisplayName))
                        .font(metrics.font(size: metrics.style == .clean ? 10 : 11))
                        .foregroundStyle(theme[.fgFaint])
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "gearshape").webProfileSized(13)
                    .font(metrics.font(size: 13))
                    .foregroundStyle(theme[hovering ? .fg : .fgFaint])
                    .fixedSize()
            }
            .padding(.horizontal, metrics.size(metrics.style == .clean ? 10 : 12))
            .padding(.vertical, metrics.size(metrics.style == .clean ? 0 : 14))
            .frame(height: metrics.style == .clean ? metrics.size(40) : nil)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .frame(maxWidth: .infinity)
        .fixedSize(horizontal: false, vertical: true)
        // Flat, full-bleed fill (the web row has no radius): it runs under the bottom safe area so the
        // window's own rounded corner clips it instead of an inner radius that never lines up.
        .background {
            ZStack {
                theme[.bg]
                theme[.panelHover].opacity(hovering || showingMenu ? 1 : 0)
            }
            .ignoresSafeArea(.container, edges: [.bottom, .horizontal])
        }
        .animation(metrics.isWebInterface ? Motion.SidebarEffect.profile.animation(
            reduceMotion: metrics.reducesMotion, clean: metrics.style == .clean) : nil, value: hovering)
        .overlay(alignment: .top) {
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
        }
        .help(Text(verbatim: String(format: String(localized: "profiles.menu.help"), environment.webDisplayName)))
        .accessibilityIdentifier("leftSidebar.profile")
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rowWidth = $0 }
        .webTitleBarPopover(isPresented: Binding(get: { metrics.isWebInterface && showingMenu },
                                                set: { showingMenu = $0 }), width: max(1, rowWidth / metrics.scale - (metrics.style == .clean ? 12 : 16)), trailing: false) {
            webMenu.modifier(SidebarProfilePopoverMotion())
        }
        .popover(isPresented: Binding(get: { !metrics.isWebInterface && showingMenu },
                                     set: { showingMenu = $0 }), arrowEdge: .top) {
            nativeMenu
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

    private var webMenu: some View {
        VStack(alignment: .leading, spacing: metrics.size(2)) {
            HStack(spacing: metrics.size(metrics.style == .clean ? 8 : 10)) {
                avatar.aspectRatio(contentMode: .fill)
                    .frame(width: metrics.size(metrics.style == .clean ? 28 : 36),
                           height: metrics.size(metrics.style == .clean ? 28 : 36))
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: environment.webDisplayName)
                        .font(metrics.font(size: metrics.style == .clean ? 12 : 13, weight: .semibold))
                    Text("profile.web.localAccount")
                        .font(metrics.font(size: metrics.style == .clean ? 10 : 11))
                        .foregroundStyle(theme[.fgMuted])
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, metrics.size(metrics.style == .clean ? 8 : 10))
            .padding(.top, metrics.size(metrics.style == .clean ? 7 : 10))
            .padding(.bottom, metrics.size(metrics.style == .clean ? 5 : 6))
            profileDivider
            ProfileMenuWebButton("leftSidebar.preferences", symbol: "gearshape") {
                showingMenu = false
                openSettings()
            }
            ProfileMenuWebButton("profile.web.manageAccounts", symbol: "person.2") {
                showingMenu = false
                environment.settingsTab = .profiles
                openSettings()
            }
            .accessibilityIdentifier("profiles.menu.manage")
            ProfileMenuWebButton("profile.web.logout", symbol: "rectangle.portrait.and.arrow.right", role: .destructive) {
                showingMenu = false
                setAvatar(nil)
                environment.preferences?.update { $0.onboardingDone = false }
                environment.editorRequest = .onboarding
            }

        }
        .buttonStyle(ProfileMenuWebStyle())
        .labelStyle(ProfileMenuWebLabelStyle())
        .padding(metrics.size(4))
        .frame(width: max(metrics.size(1), rowWidth - metrics.size(metrics.style == .clean ? 12 : 16)))
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(theme.shadow(.md).blur / 2),
                x: metrics.size(theme.shadow(.md).x), y: metrics.size(theme.shadow(.md).y))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private var nativeMenu: some View {
        VStack(alignment: .leading, spacing: metrics.size(2)) {
            HStack(spacing: metrics.size(metrics.style == .clean ? 8 : 10)) {
                avatar.aspectRatio(contentMode: .fill)
                    .frame(width: metrics.size(metrics.style == .clean ? 28 : 36),
                           height: metrics.size(metrics.style == .clean ? 28 : 36))
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: environment.webDisplayName)
                        .font(metrics.font(size: metrics.style == .clean ? 12 : 13, weight: .semibold))
                    Text(verbatim: String(format: String(localized: "leftSidebar.localAccount"),
                                         environment.webDisplayName))
                        .font(metrics.font(size: metrics.style == .clean ? 10 : 11))
                        .foregroundStyle(theme[.fgMuted])
                }
                .lineLimit(1)
            }
            .padding(.horizontal, metrics.size(metrics.style == .clean ? 8 : 10))
            .padding(.top, metrics.size(metrics.style == .clean ? 7 : 10))
            .padding(.bottom, metrics.size(metrics.style == .clean ? 5 : 6))
            Divider()
            SidebarMenuButton("leftSidebar.preferences", symbol: "gearshape") {
                showingMenu = false
                openSettings()
            }
            SidebarMenuButton("sidebar.web.chooseAvatar", symbol: "photo") { chooseAvatar() }
            if customAvatar != nil {
                SidebarMenuButton("sidebar.web.resetAvatar", symbol: "arrow.counterclockwise") { setAvatar(nil) }
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
            SidebarMenuButton("profiles.menu.manage", symbol: "person.2") {
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

    private var profileDivider: some View {
        Rectangle().fill(theme[.border])
            .frame(height: metrics.size(1))
            .padding(.horizontal, metrics.size(2))
            .padding(.vertical, metrics.size(4))
    }

    private var profileKey: String { environment.profileID?.rawValue ?? "default" }

    private var storedAvatars: [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: Data(avatarImages.utf8))) ?? [:]
    }

    private var customAvatar: NSImage? {
        guard let encoded = storedAvatars[profileKey], let data = Data(base64Encoded: encoded) else { return nil }
        return NSImage(data: data)
    }

    private var avatar: some View {
        Group {
            if let customAvatar { Image(nsImage: customAvatar).resizable() }
            else { Image("DefaultProfile").resizable() }
        }
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = String(localized: "sidebar.web.chooseAvatar")
        guard panel.runModal() == .OK, let url = panel.url,
              let image = NSImage(contentsOf: url),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let data = bitmap.representation(using: .png, properties: [:]) else { return }
        setAvatar(data)
    }

    private func setAvatar(_ data: Data?) {
        var avatars = storedAvatars
        avatars[profileKey] = data?.base64EncodedString()
        guard let encoded = try? JSONEncoder().encode(avatars), let text = String(data: encoded, encoding: .utf8) else { return }
        avatarImages = text
    }

}
