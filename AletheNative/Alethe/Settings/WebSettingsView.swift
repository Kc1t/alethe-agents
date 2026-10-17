import AletheDesign
import SwiftUI

/// Web PreferencesModal's two-column shell. The native Settings TabView stays independent.
struct WebSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var extra: Extra?

    private enum Extra { case shortcuts, about }
    private struct Destination: Identifiable {
        let id: SettingsTab
        let title: LocalizedStringKey
        let detail: LocalizedStringKey
        let symbol: String
        let search: String
    }

    private var destinations: [Destination] {
        var items: [Destination] = [
            .init(id: .profiles, title: "settings.profiles.tab", detail: "settings.web.profiles.detail",
                  symbol: "person", search: String(localized: "settings.profiles.tab")),
            .init(id: .general, title: "settings.general.tab", detail: "settings.web.general.detail",
                  symbol: "gearshape", search: String(localized: "settings.general.tab")),
            .init(id: .appearance, title: "settings.appearance.tab", detail: "settings.web.appearance.detail",
                  symbol: "paintpalette", search: String(localized: "settings.appearance.tab")),
            .init(id: .toolbar, title: "settings.toolbar", detail: "settings.toolbar.help",
                  symbol: "menubar.rectangle", search: String(localized: "settings.toolbar")),
            .init(id: .remote, title: "settings.remote.tab", detail: "settings.web.remote.detail",
                  symbol: "checkmark.shield", search: String(localized: "settings.remote.tab")),
            .init(id: .features, title: "settings.features.tab", detail: "settings.features.help",
                  symbol: "square.grid.2x2", search: String(localized: "settings.features.tab")),
            .init(id: .plugins, title: "settings.plugins.tab", detail: "settings.plugins.help",
                  symbol: "puzzlepiece.extension", search: String(localized: "settings.plugins.tab")),
            .init(id: .agents, title: "settings.agents.tab", detail: "settings.agents.footer",
                  symbol: "terminal", search: String(localized: "settings.agents.tab")),
            .init(id: .resources, title: "settings.resources.tab", detail: "settings.web.resources.detail",
                  symbol: "waveform.path.ecg", search: String(localized: "settings.resources.tab")),
            .init(id: .integrations, title: "settings.integrations.tab", detail: "settings.web.integrations.detail",
                  symbol: "powerplug", search: String(localized: "settings.integrations.tab")),
        ]
        if environment.features.isOn(.orchestrator) {
            items.append(.init(id: .multiagent, title: "settings.multiagent.tab", detail: "settings.web.multiagent.detail",
                  symbol: "point.3.connected.trianglepath.dotted", search: String(localized: "settings.multiagent.tab")))
        }
        return items
    }

    private var title: LocalizedStringKey {
        switch extra {
        case .about: "settings.web.about"
        case .shortcuts: "settings.web.shortcuts"
        case nil: destinations.first { $0.id == environment.settingsTab }?.title ?? "settings.general.tab"
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
                            if extra == nil, let destination = destinations.first(where: { $0.id == environment.settingsTab }) {
                                Text(destination.detail)
                                    .font(metrics.font(size: 11))
                                    .foregroundStyle(theme[.fgMuted])
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                        Button { dismiss() } label: {
                            Image(systemName: "xmark").webProfileSized(16)
                                .font(metrics.font(size: 16))
                                .frame(width: metrics.size(32), height: metrics.size(32))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(theme[.fgMuted])
                        .accessibilityLabel(Text("settings.web.close"))
                    }
                    .padding(.horizontal, metrics.size(24))
                    .padding(.top, metrics.size(20))
                    .padding(.bottom, metrics.size(16))
                    .frame(minHeight: metrics.size(80), alignment: .topLeading)
                    .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
                    page.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .foregroundStyle(theme[.fg])
            .background(theme[.bgElevated])
        }
        .frame(minWidth: metrics.size(500), idealWidth: metrics.size(1180), minHeight: metrics.size(300), idealHeight: metrics.size(780))
        .onChange(of: environment.settingsTab) { _, _ in extra = nil }
        .onChange(of: environment.features.isOn(.orchestrator)) { _, enabled in
            if !enabled, environment.settingsTab == .multiagent { environment.settingsTab = .general }
        }
    }

    private func sidebar(narrow: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.size(3)) {
                Button {
                    extra = nil
                    environment.settingsTab = .profiles
                } label: {
                    HStack(spacing: metrics.size(10)) {
                        Image("DefaultProfile")
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: metrics.size(narrow ? 34 : 40), height: metrics.size(narrow ? 34 : 40))
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: metrics.size(2)) {
                            Text(verbatim: environment.activeProfileName)
                                .font(metrics.font(size: 13, weight: .bold))
                                .lineLimit(1)
                            Text("settings.profiles.tab")
                                .font(metrics.font(size: 11))
                                .foregroundStyle(theme[.fgMuted])
                        }
                        Spacer(minLength: 0)
                        if !narrow { Image(systemName: "chevron.right").webProfileSized(14).font(metrics.font(size: 14)) }
                    }
                    .padding(metrics.size(8))
                }
                .buttonStyle(.plain)
                HStack(spacing: metrics.size(8)) {
                    Image(systemName: "magnifyingglass").webProfileSized(14).font(metrics.font(size: 14))
                    TextField("settings.web.search", text: $query)
                        .textFieldStyle(.plain)
                        .font(metrics.font(size: 12))
                }
                .foregroundStyle(theme[.fgMuted])
                .padding(.horizontal, metrics.size(10))
                .frame(height: metrics.size(38))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .padding(.top, metrics.size(14))
                .padding(.bottom, metrics.size(16))
                ForEach(destinations.filter { query.isEmpty || $0.search.localizedCaseInsensitiveContains(query) }) { destination in
                    Button {
                        extra = nil
                        environment.settingsTab = destination.id
                    } label: {
                        HStack(spacing: metrics.size(10)) {
                            Image(systemName: destination.symbol).webProfileSized(18)
                                .font(metrics.font(size: 18))
                                .frame(width: metrics.size(18))
                            VStack(alignment: .leading, spacing: metrics.size(2)) {
                                Text(destination.title).font(metrics.font(size: 12, weight: .semibold))
                                Text(destination.detail)
                                    .font(metrics.font(size: 9))
                                    .foregroundStyle(theme[.fgFaint])
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
                    .foregroundStyle(theme[extra == nil && destination.id == environment.settingsTab ? .fg : .fgMuted])
                    .background(theme[.bgSunken].opacity(extra == nil && destination.id == environment.settingsTab ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.borderStrong].opacity(extra == nil && destination.id == environment.settingsTab ? 1 : 0), lineWidth: metrics.size(1)))
                }
                Button { extra = .shortcuts } label: { Label { Text("settings.web.shortcuts") } icon: { Image(systemName: "keyboard").webProfileSized(14) } }
                    .padding(metrics.size(10))
                Button { extra = .about } label: { Label { Text("settings.web.about") } icon: { Image(systemName: "info.circle").webProfileSized(14) } }
                    .padding(metrics.size(10))
            }
            .buttonStyle(.plain)
            .font(metrics.font(size: 12))
            .padding(.horizontal, metrics.size(narrow ? 10 : 14))
            .padding(.vertical, metrics.size(18))
        }
    }

    @ViewBuilder private var page: some View {
        switch extra {
        case .about:
            AletheSettingsForm {
                Section("settings.web.version") {
                    LabeledContent {
                        Text(verbatim: "v" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"))
                            .font(metrics.monoFont(size: 12, weight: .semibold))
                    } label: {
                        Text(verbatim: "Alethe")
                        Text(verbatim: "com.kc1t.alethe")
                    }
                }
            }
        case .shortcuts:
            AletheSettingsForm {
                LabeledContent { Text(verbatim: "⌘T") } label: { Text("menu.file.newTerminal") }
                LabeledContent { Text(verbatim: "⌘+") } label: { Text("menu.view.zoomIn") }
                LabeledContent { Text(verbatim: "⌘−") } label: { Text("menu.view.zoomOut") }
                LabeledContent { Text(verbatim: "⌘0") } label: { Text("menu.view.actualSize") }
            }
        case nil:
            switch environment.settingsTab {
            case .general: GeneralSettings()
            case .appearance: AppearanceSettings()
            case .toolbar: ToolbarSettings()
            case .agents: AgentSettings()
            case .resources: ResourceSettings()
            case .features: FeatureSettings()
            case .plugins: PluginSettings()
            case .integrations: IntegrationsSettings()
            case .remote: RemoteSettings()
            case .multiagent: MultiagentSettings()
            case .profiles: ProfileSettings()
            }
        }
    }
}
