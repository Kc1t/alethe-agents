import AletheDesign
import AletheModel
import SwiftUI

/// Settings › Toolbar (UI-7, upstream `TopbarSettingsModal`): which main window toolbar items show.
/// Arranging them is View › Customize Toolbar…; the usage pills share AI Usage's toggles.
struct ToolbarSettings: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        SettingsPageForm {
            Section {
                ForEach(ToolbarItemKind.allCases, id: \.self) { item in
                    Toggle(item.title, isOn: Binding {
                        environment.preferences?.document.showsToolbarItem(item) ?? item.shownByDefault
                    } set: { shown in
                        environment.preferences?.update { $0.setToolbarItem(item, shown: shown) }
                    })
                    .accessibilityIdentifier("settings.toolbar.\(item.rawValue)")
                    .settingsRowSurface(.toolbar)
                }
            } footer: {
                Text("settings.toolbar.help")
            }
            Section {
                Button("settings.toolbar.restore") {
                    environment.preferences?.update { $0.toolbarItems = nil }
                }
                .disabled(environment.preferences?.document.toolbarItems == nil)
                .accessibilityIdentifier("settings.toolbar.restore")
            }
        }
        .formStyle(.grouped)
        .modifier(AletheSettingsSizing())
        .disabled(environment.preferences == nil)
        .accessibilityIdentifier("settings.toolbar")
    }
}

extension ToolbarItemKind {
    var title: LocalizedStringKey {
        switch self {
        case .home: "settings.toolbar.home"
        case .usageClaude: "settings.toolbar.usageClaude"
        case .usageCodex: "settings.toolbar.usageCodex"
        case .usageAntigravity: "settings.toolbar.usageAntigravity"
        case .aiUsage: "settings.toolbar.aiUsage"
        case .notifications: "settings.toolbar.notifications"
        case .memory: "settings.toolbar.memory"
        case .profile: "settings.toolbar.profile"
        case .remote: "settings.toolbar.remote"
        case .router9: "settings.toolbar.router9"
        case .sync: "settings.toolbar.sync"
        }
    }
}
