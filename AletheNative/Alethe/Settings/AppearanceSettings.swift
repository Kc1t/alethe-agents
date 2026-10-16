import AletheDesign
import AletheFoundation
import AletheModel
import SwiftUI

/// Settings › Appearance: theme, app icon, UI zoom and interface language.
struct AppearanceSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @State private var language = LanguageSetting().current()

    private var uiScale: Double { environment.preferences?.document.uiScale ?? 1 }

    var body: some View {
        Form {
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
                            Text(style.detail).font(.footnote).foregroundStyle(.secondary)
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
                            Text(style.detail).font(.footnote).foregroundStyle(.secondary)
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
                                    Image(systemName: "minus").frame(width: metrics.size(12), height: metrics.size(12))
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
                                    Image(systemName: "plus").frame(width: metrics.size(12), height: metrics.size(12))
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
        .scrollDisabled(true)
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: language) { _, language in LanguageSetting().set(language) }
    }
}

/// The built-in themes as swatch tiles, in the Tauri app's picker order. Selecting one applies it
/// everywhere at once, terminals included.
struct ThemeGrid: View {
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
        LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(100)), spacing: metrics.space(.l))],
                  spacing: metrics.space(.l)) {
            ForEach(themes) { option in
                tile(option)
            }
        }
        .padding(.vertical, metrics.space(.xs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.theme")
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
                        .strokeBorder(isSelected ? theme[.accent] : theme[.borderSubtle], lineWidth: isSelected ? 2 : 1)
                }
                option.localizedName
                    .font(metrics.font(.footnote))
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
        HStack(spacing: metrics.space(.l)) {
            ForEach(AppIconTheme.allCases, id: \.self) { tile($0) }
            Spacer(minLength: 0)
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
                        Image(nsImage: image).resizable().interpolation(.high)
                    } else {
                        Image(systemName: "app")
                    }
                }
                .frame(width: metrics.size(56), height: metrics.size(56))
                .padding(metrics.space(.xxs))
                .overlay {
                    RoundedRectangle(cornerRadius: metrics.radius(.lg))
                        .strokeBorder(isSelected ? theme[.accent] : .clear, lineWidth: 2)
                }
                option.localizedName
                    .font(metrics.font(.footnote))
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
