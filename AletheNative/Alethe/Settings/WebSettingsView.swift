import AletheDesign
import AppKit
import SwiftUI

/// Web PreferencesModal's two-column shell. The native Settings TabView stays independent.
struct WebSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var searchTarget = ""
    @AppStorage("sidebar.web.avatarImages") private var avatars = "{}"
    @State private var selection = Category.account
    @State private var hovering: Category?
    @State private var profileHovering = false
    @State private var closeHovering = false

    private enum Category: String, Hashable { case account, organization, appearance, remote, features, plugins, terminal, integrations, orchestration, multiagent, about }
    private struct Destination: Identifiable {
        let id: Category
        let title: LocalizedStringKey
        let detail: LocalizedStringKey
        let symbol: String
        let search: String
    }

    private var destinations: [Destination] {
        [
            .init(id: .account, title: "settings.web.reference.prefs.categoryAccount", detail: "settings.web.reference.prefs.categoryAccountDesc",
                  symbol: "person", search: String(localized: "settings.web.reference.prefs.categoryAccount")),
            .init(id: .organization, title: "settings.web.reference.prefs.categoryOrganization", detail: "settings.web.reference.prefs.categoryOrganizationDesc",
                  symbol: "archivebox", search: String(localized: "settings.web.reference.prefs.categoryOrganization")),
            .init(id: .appearance, title: "settings.web.reference.prefs.categoryAppearance", detail: "settings.web.reference.prefs.categoryAppearanceDesc",
                  symbol: "paintpalette", search: String(localized: "settings.web.reference.prefs.categoryAppearance")),
            .init(id: .remote, title: "settings.web.reference.prefs.categoryRemoteControl", detail: "settings.web.reference.prefs.categoryRemoteControlDesc",
                  symbol: "checkmark.shield", search: String(localized: "settings.web.reference.prefs.categoryRemoteControl")),
            .init(id: .features, title: "settings.web.reference.prefs.features", detail: "settings.web.reference.prefs.featuresDesc",
                  symbol: "square.grid.2x2", search: String(localized: "settings.web.reference.prefs.features")),
            .init(id: .plugins, title: "settings.web.reference.prefs.categoryPlugins", detail: "settings.web.reference.prefs.categoryPluginsDesc",
                  symbol: "puzzlepiece.extension", search: String(localized: "settings.web.reference.prefs.categoryPlugins")),
            .init(id: .terminal, title: "settings.web.reference.prefs.categoryTerminal", detail: "settings.web.reference.prefs.categoryTerminalDesc",
                  symbol: "terminal", search: String(localized: "settings.web.reference.prefs.categoryTerminal")),
            .init(id: .integrations, title: "settings.web.reference.prefs.categoryIntegrations", detail: "settings.web.reference.prefs.categoryIntegrationsDesc",
                  symbol: "powerplug", search: String(localized: "settings.web.reference.prefs.categoryIntegrations")),
            .init(id: .orchestration, title: "settings.web.reference.prefs.categoryOrchestration", detail: "settings.web.reference.prefs.categoryOrchestrationDesc",
                  symbol: "point.3.connected.trianglepath.dotted", search: String(localized: "settings.web.reference.prefs.categoryOrchestration")),
            .init(id: .multiagent, title: "settings.web.reference.prefs.categoryMultiagent", detail: "settings.web.reference.prefs.categoryMultiagentDesc",
                  symbol: "waveform.path.ecg", search: String(localized: "settings.web.reference.prefs.categoryMultiagent")),
            .init(id: .about, title: "settings.web.reference.prefs.categoryAbout", detail: "settings.web.reference.prefs.categoryAboutDesc",
                  symbol: "info.circle", search: String(localized: "settings.web.reference.prefs.categoryAbout")),
        ]
    }

    private var title: LocalizedStringKey {
        destinations.first { $0.id == selection }?.title ?? "settings.web.reference.prefs.categoryAccount"
    }

    private func selectRequestedTab() {
        switch environment.settingsTab {
        case .profiles, .general: selection = .account
        case .appearance, .toolbar: selection = .appearance
        case .agents, .resources: selection = .terminal
        case .features: selection = .features
        case .plugins: selection = .plugins
        case .integrations: selection = .integrations
        case .remote: selection = .remote
        case .multiagent: selection = .multiagent
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let narrow = geometry.size.width / metrics.scale <= 900
            HStack(spacing: 0) {
                sidebar(narrow: narrow)
                    .frame(width: metrics.size(narrow ? 184 : 226))
                    .background(theme[.bgSunken].opacity(0.78))
                    .overlay(alignment: .trailing) { theme[.border].frame(width: metrics.size(1)) }
                VStack(spacing: 0) {
                    HStack(alignment: .top, spacing: metrics.size(20)) {
                        VStack(alignment: .leading, spacing: metrics.size(5)) {
                            Text(title).font(metrics.font(size: 18, weight: 650))
                            if let destination = destinations.first(where: { $0.id == selection }) {
                                Text(destination.detail)
                                    .font(metrics.font(size: 11))
                                    .foregroundStyle(theme[.fgMuted])
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                        Button { dismiss() } label: {
                            Image(systemName: "xmark").webProfileSized(18)
                                .font(metrics.font(size: 18))
                                .frame(width: metrics.size(32), height: metrics.size(32))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(theme[.fgMuted])
                        .background(theme[.panelHover].opacity(closeHovering ? 1 : 0), in: Circle())
                        .onHover { closeHovering = $0 }
                        .accessibilityLabel(Text("settings.web.close"))
                    }
                    .padding(.horizontal, metrics.size(24))
                    .padding(.top, metrics.size(20))
                    .padding(.bottom, metrics.size(16))
                    .frame(minHeight: metrics.size(80), alignment: .topLeading)
                    .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
                    Group {
                        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            page.environment(\.settingsSearchTarget, searchTarget)
                        } else {
                            searchResults
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .foregroundStyle(theme[.fg])
            .background(theme[.bgElevated])
        }
        .frame(minWidth: metrics.size(500), idealWidth: metrics.size(1180), minHeight: metrics.size(300), idealHeight: metrics.size(780))
        .background(SettingsWindowSizer(size: CGSize(width: metrics.size(1180), height: metrics.size(780))))
        .webScrollStyle()
        .onAppear(perform: selectRequestedTab)
        .onChange(of: environment.settingsTab) { _, _ in selectRequestedTab() }

    }

    private var avatar: some View {
        let images = (try? JSONDecoder().decode([String: String].self, from: Data(avatars.utf8))) ?? [:]
        let image = images[environment.profileID?.rawValue ?? "default"]
            .flatMap { Data(base64Encoded: $0) }.flatMap { NSImage(data: $0) }
        return Group {
            if let source = environment.preferences?.document.profileImageUrl, !source.isEmpty {
                SidebarCoverImage(source: source, side: 40, cornerRadius: 20) {
                    Image("DefaultProfile").resizable()
                }
            } else if let image { Image(nsImage: image).resizable() }
            else { Image("DefaultProfile").resizable() }
        }
    }

    private func sidebar(narrow: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    selection = .account
                } label: {
                    HStack(spacing: metrics.size(10)) {
                        avatar
                            .aspectRatio(contentMode: .fill)
                            .frame(width: metrics.size(narrow ? 34 : 40), height: metrics.size(narrow ? 34 : 40))
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: metrics.size(2)) {
                            Text(verbatim: environment.webDisplayName)
                                .font(metrics.font(size: 13, weight: .bold))
                                .lineLimit(1)
                            Text("settings.web.reference.prefs.editProfile")
                                .font(metrics.font(size: 11))
                                .foregroundStyle(theme[.fgMuted])
                        }
                        Spacer(minLength: 0)
                        if !narrow { Image(systemName: "chevron.right").webProfileSized(14).font(metrics.font(size: 14)) }
                    }
                    .padding(metrics.size(8))
                }
                .buttonStyle(.plain)
                .background(theme[.panelHover].opacity(profileHovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .onHover { profileHovering = $0 }
                HStack(spacing: metrics.size(8)) {
                    Image(systemName: "magnifyingglass").webProfileSized(15).font(metrics.font(size: 15))
                    TextField("settings.web.search", text: $query)
                        .textFieldStyle(.plain)
                        .font(metrics.font(size: 12))
                }
                .foregroundStyle(theme[.fgMuted])
                .padding(.horizontal, metrics.size(10))
                .frame(height: metrics.size(38))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .padding(.horizontal, metrics.size(2))
                .padding(.top, metrics.size(14))
                .padding(.bottom, metrics.size(16))
                Text("settings.web.reference.prefs.settingsLabel")
                    .textCase(.uppercase)
                    .font(metrics.font(size: 10, weight: .bold))
                    .tracking(metrics.size(0.8))
                    .foregroundStyle(theme[.fgFaint])
                    .padding(.horizontal, metrics.size(9))
                    .padding(.bottom, metrics.size(6))
                ForEach(destinations) { destination in
                    Button {
                        selection = destination.id
                        query = ""
                        searchTarget = ""
                    } label: {
                        HStack(spacing: metrics.size(10)) {
                            Image(systemName: destination.symbol).webProfileSized(16)
                                .font(metrics.font(size: 16))
                                .frame(width: metrics.size(16))
                            VStack(alignment: .leading, spacing: metrics.size(2)) {
                                Text(destination.title).font(metrics.font(size: 12, weight: .semibold))
                                Text(destination.detail)
                                    .font(metrics.font(size: 9))
                                    .foregroundStyle(theme[destination.id == selection ? .fgMuted : .fgFaint])
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, metrics.size(10))
                        .padding(.vertical, metrics.size(8))
                        .frame(minHeight: metrics.size(48))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.web.category.\(destination.id.rawValue)")
                    .foregroundStyle(theme[destination.id == selection || hovering == destination.id ? .fg : .fgMuted])
                    .background(theme[destination.id == selection ? .bgSunken : .panelHover].opacity(destination.id == selection || hovering == destination.id ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .onHover { hovering = $0 ? destination.id : nil }
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.borderStrong].opacity(destination.id == selection ? 1 : 0), lineWidth: metrics.size(1)))
                    .padding(.bottom, metrics.size(3))
                }

            }
            .buttonStyle(.plain)
            .font(metrics.font(size: 12))
            .padding(.horizontal, metrics.size(narrow ? 10 : 14))
            .padding(.vertical, metrics.size(18))
        }
    }

    private var searchResults: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: metrics.size(8)) {
                let results = SettingsSearchEntry.all.filter { $0.matches(query) }
                if results.isEmpty { Text("settings.search.empty").foregroundStyle(theme[.fgMuted]) }
                ForEach(results) { result in
                    Button {
                        guard let category = Category(rawValue: result.category) else { return }
                        searchTarget = result.target
                        let storageKey = (environment.profileID?.rawValue ?? "default") + ":" + result.target
                        let stored = UserDefaults.standard.string(forKey: "settings.web.collapsedSections") ?? "{}"
                        var values = (try? JSONDecoder().decode([String: Bool].self, from: Data(stored.utf8))) ?? [:]
                        values[storageKey] = false
                        if let data = try? JSONEncoder().encode(values), let value = String(data: data, encoding: .utf8) {
                            UserDefaults.standard.set(value, forKey: "settings.web.collapsedSections")
                        }
                        selection = category
                        query = ""
                    } label: {
                        VStack(alignment: .leading, spacing: metrics.size(4)) {
                            Text(LocalizedStringKey(result.label)).font(metrics.font(size: 12, weight: .semibold))
                            Text(LocalizedStringKey(result.detail)).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(metrics.size(12))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    }.buttonStyle(.plain)
                }
            }.padding(metrics.size(24))
        }
    }

    @ViewBuilder private var page: some View {
        switch selection {
        case .account: WebAccountSettings()
        case .organization: WebOrganizationSettings()
        case .appearance: AppearanceSettings()
        case .remote: RemoteSettings()
        case .features: FeatureSettings()
        case .plugins: PluginSettings()
        case .terminal: WebTerminalSettings()
        case .integrations: IntegrationsSettings()
        case .orchestration: OrchestrationSettings()
        case .multiagent: MultiagentSettings()
        case .about: WebAboutSettings()
        }
    }
}
