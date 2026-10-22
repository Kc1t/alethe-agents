import AletheDesign
import AletheFoundation
import AletheModel
import AlethePluginKit
import SwiftUI

/// Settings › Appearance: theme, app icon, UI zoom and interface language.
struct AppearanceSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var language = LanguageSetting().current()
    @State private var showingToolbar = false

    private var uiScale: Double { environment.preferences?.document.uiScale ?? 1 }

    /// AppearancePage.tsx "view placement": one Left/Right dropdown per contributed sidebar tab.
    @ViewBuilder
    private var viewPlacementRows: some View {
        let tabs = environment.plugins?.contributions.sidebarTabs ?? []
        if let host = environment.plugins, !tabs.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                    HStack(spacing: metrics.size(12)) {
                        Text(verbatim: tab.title)
                        Spacer(minLength: 0)
                        InterfaceSelect(selection: Binding {
                            host.viewPlacements.side(of: tab.id, in: tabs) ?? tab.side
                        } set: { side in
                            Task { try? await host.moveSidebarTab(tab.id, to: side, at: .max) }
                        }, options: [SidebarSide.left, .right]) { side in
                            Text(side == .left ? "settings.web.reference.prefs.viewPlacementLeft"
                                 : "settings.web.reference.prefs.viewPlacementRight")
                        }
                        .fixedSize(horizontal: metrics.isWebInterface, vertical: false)
                        .accessibilityLabel(Text(verbatim: tab.title))
                    }
                    .font(metrics.font(size: 13))
                    .foregroundStyle(theme[.textSecondary])
                    .padding(.vertical, metrics.size(6))
                    .overlay(alignment: .top) {
                        if index > 0 { theme[.borderSubtle].frame(height: metrics.size(1)) }
                    }
                    .accessibilityIdentifier("settings.viewPlacement.\(tab.id)")
                .settingsRowSurface(.standalone)
                }
            }
        } else {
            Text("settings.web.reference.prefs.viewPlacementEmpty")
                .font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
        }
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        AletheSettingsForm {
            Section {
                ThemeGrid()
            } header: {
                Text("settings.appearance.theme")
            }

            Section {
                AppIconGrid()
            } header: {
                Text("settings.appearance.appIcon")
            } footer: {
                Text("settings.appearance.appIcon.help")
            }
            .disabled(environment.preferences == nil)

            Section {
                Picker(selection: Binding { environment.interfaceStyle } set: { environment.interfaceStyle = $0 }) {
                    ForEach(InterfaceStyle.allCases, id: \.self) { style in
                        VStack(alignment: .leading) {
                            Text(style.title)
                            Text(style.detail).font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote).foregroundStyle(.secondary)
                        }
                        .tag(style)
                    }
                } label: {
                    Text("settings.appearance.interface")
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("settings.interface")
            }

            Section {
                Picker(selection: Binding {
                    environment.visualStyle
                } set: { style in
                    environment.preferences?.update { $0.visualStyle = style == .normal ? nil : style.rawValue }
                }) {
                    ForEach(VisualStyle.allCases, id: \.self) { style in
                        VStack(alignment: .leading) {
                            Text(style.title)
                            Text(style.detail).font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote).foregroundStyle(.secondary)
                        }
                        .tag(style)
                    }
                } label: {
                    Text("settings.appearance.style")
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("settings.style")
                Toggle(isOn: Binding {
                    environment.preferences?.document.reducedMotion == true
                } set: { reduced in
                    environment.preferences?.update { $0.reducedMotion = reduced ? true : nil }
                }) {
                    Text("settings.appearance.reduceMotion")
                    Text(environment.systemReducesMotion ? "settings.appearance.reduceMotion.system"
                         : "settings.appearance.reduceMotion.help")
                }
                .accessibilityIdentifier("settings.reduceMotion")
            } header: {
                Text("settings.appearance.styleAndMotion")
            }

            Section {
                LabeledContent {
                    HStack(spacing: metrics.space(.m)) {
                        Text(verbatim: uiScale.formatted(.percent.precision(.fractionLength(0))))
                            .monospacedDigit()
                            // A new identity per value: SwiftUI keeps a changed Text's accessibility
                            // value stale, so VoiceOver and UI tests would read the old percentage.
                            .id(uiScale)
                            .accessibilityIdentifier("settings.zoom.value")
                        HStack(spacing: metrics.space(.xs)) {
                            Button {
                                environment.preferences?.update { $0.zoom(by: -1) }
                            } label: {
                                Label {
                                    Text("menu.view.zoomOut")
                                } icon: {
                                    // Same box for both glyphs: "minus" is shorter and the button would shrink.
                                    Image(systemName: "minus").webProfileSized(12).frame(width: metrics.size(12), height: metrics.size(12))
                                }
                            }
                            .disabled(uiScale <= PreferencesDocument.uiScaleRange.lowerBound)
                            .accessibilityIdentifier("settings.zoom.out")
                            Button {
                                environment.preferences?.update { $0.zoom(by: 1) }
                            } label: {
                                Label {
                                    Text("menu.view.zoomIn")
                                } icon: {
                                    Image(systemName: "plus").webProfileSized(12).frame(width: metrics.size(12), height: metrics.size(12))
                                }
                            }
                            .disabled(uiScale >= PreferencesDocument.uiScaleRange.upperBound)
                            .accessibilityIdentifier("settings.zoom.in")
                        }
                        .labelStyle(.iconOnly)
                        Button("menu.view.actualSize") {
                            environment.preferences?.update { $0.uiScale = 1 }
                        }
                        .disabled(uiScale == 1)
                        .accessibilityIdentifier("settings.zoom.reset")
                    }
                } label: {
                    Text("settings.appearance.zoom")
                    Text("settings.appearance.zoom.help")
                }
            }
            .disabled(environment.preferences == nil)

            Section {
                Picker(selection: $language) {
                    Text("settings.appearance.language.system").tag(AppLanguage.system)
                    ForEach(AppLanguage.allCases.filter { $0 != .system }, id: \.self) { language in
                        Text(verbatim: language.nativeName ?? language.rawValue).tag(language)
                    }
                } label: {
                    Text("settings.appearance.language")
                    Text("settings.appearance.language.help")
                }
                .accessibilityIdentifier("settings.language")

                if language != environment.launchLanguage {
                    HStack {
                        Text("settings.appearance.language.restartNote")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("settings.appearance.language.restart") { AppRelaunch.relaunch() }
                            .accessibilityIdentifier("settings.language.restart")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("settings.language.restartNote")
                }
            }
        }
        .formStyle(.grouped)
        // Sized to its content: the Settings window grows instead of hiding controls in a scroll view.
        .modifier(AletheSettingsSizing())
        .onChange(of: language) { _, language in LanguageSetting().set(language) }
    }
    private var webBody: some View {
        SettingsPageForm("appearance") {
            Section {
                WebVisualStyleGrid()
                .accessibilityIdentifier("settings.style")
                .settingsRowSurface(.standalone)
            } header: { Text("settings.web.reference.prefs.visualStyle") }
              footer: { Text("settings.web.reference.prefs.visualStyleDesc") }
            Section {
                Toggle(isOn: Binding {
                    environment.preferences?.document.reducedMotion == true
                } set: { reduced in
                    environment.preferences?.update { $0.reducedMotion = reduced ? true : nil }
                }) {
                    Text("settings.appearance.reduceMotion")
                    Text("settings.appearance.reduceMotion.help")
                }
                .accessibilityIdentifier("settings.reduceMotion")
                .settingsRowSurface(.option)
            } header: { Text("settings.web.reference.prefs.motion") }
              footer: { Text("settings.web.reference.prefs.motionDesc") }
            Section { ThemeGrid() }
                header: { Text("settings.web.reference.prefs.uiTheme") }
                footer: { Text("settings.web.reference.prefs.uiThemeDesc") }
            Section { AppIconGrid() }
                header: { Text("settings.web.reference.prefs.appIconTheme") }
                footer: { Text("settings.web.reference.prefs.appIconThemeDesc") }
            Section {
                InterfaceSelect(selection: Binding {
                    environment.preferences?.document.terminalTheme ?? ""
                } set: { value in environment.preferences?.update { $0.terminalTheme = value.isEmpty ? nil : value } },
                    options: [""] + environment.themeCatalog.themes.map(\.id)) { id in
                    if id.isEmpty { Text("settings.appearance.followUI") }
                    else if let option = environment.themeCatalog.theme(id: id) { option.localizedName }
                    else { Text(verbatim: id) }
                }
                .accessibilityLabel(Text("settings.web.reference.prefs.terminalTheme"))
            }
                header: { Text("settings.web.reference.prefs.terminalTheme") }
                footer: { Text("settings.web.reference.prefs.terminalThemeDesc") }
            Section {
                HStack(spacing: metrics.size(8)) {
                    Button { environment.preferences?.update { $0.zoom(by: -1) } } label: {
                        Image(systemName: "minus").webProfileSized(15)
                    }
                    .disabled(uiScale <= PreferencesDocument.uiScaleRange.lowerBound)
                    .accessibilityLabel(Text("menu.view.zoomOut"))
                    .accessibilityIdentifier("settings.zoom.out")
                    Text(verbatim: uiScale.formatted(.percent.precision(.fractionLength(0))))
                        .font(metrics.monoFont(size: 12, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: metrics.size(40))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .id(uiScale)
                        .accessibilityIdentifier("settings.zoom.value")
                    Button { environment.preferences?.update { $0.zoom(by: 1) } } label: {
                        Image(systemName: "plus").webProfileSized(15)
                    }
                    .disabled(uiScale >= PreferencesDocument.uiScaleRange.upperBound)
                    .accessibilityLabel(Text("menu.view.zoomIn"))
                    .accessibilityIdentifier("settings.zoom.in")
                    Button { environment.preferences?.update { $0.uiScale = 1 } } label: {
                        Image(systemName: "arrow.counterclockwise").webProfileSized(15)
                    }
                    .disabled(uiScale == 1)
                    .accessibilityLabel(Text("menu.view.actualSize"))
                    .accessibilityIdentifier("settings.zoom.reset")
                .settingsRowSurface(.standalone)
                }
                .buttonStyle(SettingsZoomButtonStyle())
                .frame(maxWidth: metrics.size(320))
            } header: { Text("settings.web.reference.prefs.uiZoom") }
              footer: { Text("settings.web.reference.prefs.uiZoomDesc") }
            Section {
                InterfaceSelect(selection: Binding {
                    environment.preferences?.document.topbarStyle ?? "classic"
                } set: { value in environment.preferences?.update { $0.topbarStyle = value } },
                    options: ["classic", "three-areas"]) { style in
                    Text(style == "classic" ? "settings.web.reference.prefs.topbarStyleClassic" : "settings.web.reference.prefs.topbarStyleThreeAreas")
                }
                .accessibilityLabel(Text("settings.web.reference.prefs.topbarStyle"))
                Button("settings.toolbar") { showingToolbar = true }
                    .accessibilityIdentifier("settings.toolbar.open")
                .settingsRowSurface(.standalone)
                InterfaceSelect(selection: Binding { environment.interfaceStyle } set: { environment.interfaceStyle = $0 }, options: InterfaceStyle.allCases) { style in
                    Text(style.title)
                }
                .accessibilityLabel(Text("settings.appearance.interface"))
                .accessibilityIdentifier("settings.interface")
                .settingsRowSurface(.standalone)
            } header: { Text("settings.web.reference.prefs.topbarStyle") }
              footer: { Text("settings.web.reference.prefs.topbarStyleDesc") }
            Section { viewPlacementRows }
                header: { Text("settings.web.reference.prefs.viewPlacement") }
                footer: { Text("settings.web.reference.prefs.viewPlacementDesc") }
            Section {
                HStack(spacing: metrics.size(10)) {
                    Slider(value: Binding {
                        min(1, max(0.6, environment.preferences?.document.windowOpacity ?? 1))
                    } set: { value in environment.preferences?.update { $0.windowOpacity = value } }, in: 0.6...1, step: 0.05)
                        .tint(theme[.accent])
                        .accessibilityLabel(Text("settings.web.reference.prefs.windowOpacity"))
                    Text(verbatim: (environment.preferences?.document.windowOpacity ?? 1).formatted(.percent.precision(.fractionLength(0))))
                        .font(metrics.monoFont(size: 12, weight: .bold))
                        .frame(width: metrics.size(56), height: metrics.size(40))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    Button { environment.preferences?.update { $0.windowOpacity = 1 } } label: {
                        Image(systemName: "arrow.counterclockwise").webProfileSized(15)
                    }
                    .buttonStyle(SettingsZoomButtonStyle())
                    .disabled((environment.preferences?.document.windowOpacity ?? 1) == 1)
                    .accessibilityLabel(Text("settings.web.reference.prefs.opacityReset"))
                }
                .frame(maxWidth: metrics.size(420))
                Text("settings.web.reference.prefs.windowOpacityHint")
                    .font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            }
                header: { Text("settings.web.reference.prefs.windowOpacity") }
                footer: { Text("settings.web.reference.prefs.windowOpacityDesc") }
            PaneFocusBorderSection()

        }
        .disabled(environment.preferences == nil)
        .gitWebSheet(isPresented: $showingToolbar, width: 440) {
            WebSettingsToolbarModal()
        }
    }
}

/// The built-in themes as swatch tiles, in the Tauri app's picker order. Selecting one applies it
/// everywhere at once, terminals included.
struct ThemeGrid: View {
    /// Minimum tile width in the web interface (settings 150, ThemePickerModal 160).
    var webMinimum: CGFloat = 150
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var themes: [Theme] {
        // Built-ins in picker order, then plugin themes in contribution order.
        let catalog = environment.themeCatalog
        let builtin = ThemeCatalog.builtinOrder.compactMap { catalog.theme(id: $0) }
        let ids = Set(builtin.map(\.id))
        return builtin + catalog.themes.filter { !ids.contains($0.id) }
    }

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(metrics.isWebInterface ? webMinimum : 100)), spacing: metrics.size(metrics.isWebInterface ? 10 : 12))],
                  spacing: metrics.size(metrics.isWebInterface ? 10 : 12)) {
            ForEach(themes) { option in
                if metrics.isWebInterface { webTile(option) } else { tile(option) }
            }
        }
        .padding(.vertical, metrics.space(.xs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.theme")
    }

    private func webTile(_ option: Theme) -> some View {
        let selected = option.id == theme.id
        return Button {
            environment.preferences?.update { $0.themeID = option.id }
        } label: {
            VStack(alignment: .leading, spacing: metrics.size(8)) {
                HStack(spacing: metrics.size(4)) {
                    ForEach(Array(option.swatch.enumerated()), id: \.offset) { _, color in
                        RoundedRectangle(cornerRadius: metrics.size(4))
                            .fill(color.color)
                            .frame(width: metrics.size(25), height: metrics.size(17))
                            .overlay(RoundedRectangle(cornerRadius: metrics.size(4))
                                .strokeBorder(theme[.fg].opacity(0.16), lineWidth: metrics.size(1)))
                    }
                }
                HStack(spacing: metrics.size(8)) {
                    option.localizedName.font(metrics.font(size: 12))
                    Spacer(minLength: 0)
                    if selected { Image(systemName: "checkmark").webProfileSized(15).font(metrics.font(size: 15)) }
                }
                if let summary = option.localizedSummary {
                    summary.font(metrics.font(size: 10))
                        .foregroundStyle(theme[.fgMuted])
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(metrics.size(12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[selected ? .accentFaint : .bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[selected ? .accent : .border], lineWidth: metrics.size(1)))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityValue(Text(verbatim: selected ? "1" : "0"))
        .accessibilityIdentifier("settings.theme.\(option.id)")
    }

    private func tile(_ option: Theme) -> some View {
        let isSelected = option.id == theme.id
        return Button {
            environment.preferences?.update { $0.themeID = option.id }
        } label: {
            VStack(spacing: metrics.space(.xs)) {
                HStack(spacing: 0) {
                    ForEach(Array(option.swatch.enumerated()), id: \.offset) { _, color in
                        Rectangle().fill(color.color)
                    }
                }
                .frame(height: metrics.size(34))
                .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay {
                    RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(isSelected ? theme[.accent] : theme[.borderSubtle], lineWidth: metrics.size(isSelected ? 2 : 1))
                }
                option.localizedName
                    .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                    .foregroundStyle(isSelected ? theme[.textPrimary] : theme[.textSecondary])
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusEffectDisabled()
        .help(option.localizedSummary ?? option.localizedName)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityValue(Text(verbatim: isSelected ? "1" : "0"))
        .accessibilityIdentifier("settings.theme.\(option.id)")
    }
}

/// Upstream's four app icons (P5-12); choosing one changes the Dock icon at once.
private struct AppIconGrid: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var current: AppIconTheme { environment.preferences?.document.iconTheme ?? .default }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        HStack(spacing: metrics.space(.l)) {
            ForEach(AppIconTheme.allCases, id: \.self) { tile($0) }
            Spacer(minLength: 0)
        }
        .padding(.vertical, metrics.space(.xs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.appIcon")
    }

    private var webBody: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(90)), spacing: metrics.space(.l))], spacing: metrics.space(.l)) {
            ForEach(AppIconTheme.allCases, id: \.self) { tile($0) }
        }
        .padding(.vertical, metrics.space(.xs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.appIcon")
    }

    private func tile(_ option: AppIconTheme) -> some View {
        let isSelected = option == current
        return Button {
            environment.preferences?.update { $0.iconTheme = option }
        } label: {
            VStack(spacing: metrics.space(.xs)) {
                Group {
                    if let image = AppIcon.image(for: option) {
                        Image(nsImage: image).resizable().interpolation(.high).webProfileSized(56)
                    } else {
                        Image(systemName: "app").webProfileSized(56)
                    }
                }
                .frame(width: metrics.size(56), height: metrics.size(56))
                .padding(metrics.space(.xxs))
                .overlay {
                    RoundedRectangle(cornerRadius: metrics.radius(.lg))
                        .strokeBorder(isSelected ? theme[.accent] : .clear, lineWidth: metrics.size(2))
                }
                option.localizedName
                    .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                    .foregroundStyle(isSelected ? theme[.textPrimary] : theme[.textSecondary])
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusEffectDisabled()
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityValue(Text(verbatim: isSelected ? "1" : "0"))
        .accessibilityIdentifier("settings.appIcon.\(option.rawValue)")
    }
}

extension AppIconTheme {
    /// Named like the themes they match.
    var localizedName: Text {
        switch self {
        case .eliteOriginal: Text("theme.eliteOriginal")
        case .elitePureBlack: Text("theme.elitePureBlack")
        case .eliteIndigo: Text("theme.eliteIndigo")
        case .eliteBlush: Text("theme.eliteBlush")
        }
    }
}

extension VisualStyle {
    var title: LocalizedStringKey {
        switch self {
        case .normal: "settings.appearance.style.normal"
        case .clean: "settings.appearance.style.clean"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .normal: "settings.appearance.style.normal.detail"
        case .clean: "settings.appearance.style.clean.detail"
        }
    }
}

extension InterfaceStyle {
    var title: LocalizedStringKey {
        switch self {
        case .web: "settings.appearance.interface.web"
        case .mac: "settings.appearance.interface.mac"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .web: "settings.appearance.interface.web.detail"
        case .mac: "settings.appearance.interface.mac.detail"
        }
    }
}

struct SettingsZoomButtonStyle: ButtonStyle {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(metrics.font(size: 14))
            .frame(width: metrics.size(40), height: metrics.size(40))
            .background(theme[configuration.isPressed ? .panelHover : .bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .opacity(enabled ? 1 : 0.38)
    }
}


/// Settings › Appearance: the frame around the focused pane (on/off and opacity).
private struct PaneFocusBorderSection: View {
    @AppStorage(PaneFocusBorder.enabledKey) private var enabled = true
    @AppStorage(PaneFocusBorder.opacityKey) private var opacity = 1.0
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Section {
            Toggle("settings.paneFocus.show", isOn: $enabled)
                .accessibilityIdentifier("settings.paneFocus.show")
            HStack(spacing: metrics.size(10)) {
                Slider(value: $opacity, in: 0.1...1, step: 0.05)
                    .tint(theme[.accent])
                    .disabled(!enabled)
                    .accessibilityLabel(Text("settings.paneFocus.opacity"))
                    .accessibilityIdentifier("settings.paneFocus.opacity")
                Text(verbatim: opacity.formatted(.percent.precision(.fractionLength(0))))
                    .font(metrics.monoFont(size: 12, weight: .bold))
                    .frame(width: metrics.size(56), height: metrics.size(40))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                Button { opacity = 1 } label: {
                    Image(systemName: "arrow.counterclockwise").webProfileSized(15)
                }
                .buttonStyle(SettingsZoomButtonStyle())
                .disabled(!enabled || opacity == 1)
                .accessibilityLabel(Text("settings.web.reference.prefs.opacityReset"))
            }
            .frame(maxWidth: metrics.size(420))
        } header: { Text("settings.paneFocus.title") }
          footer: { Text("settings.paneFocus.desc") }
    }
}
