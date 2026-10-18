import AletheAgents
import AletheDesign
import AletheFoundation
import AletheModel
import AppKit
import SwiftUI

struct WebAccountSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var language = LanguageSetting().current()
    @State fileprivate var managing = false
    @State private var name = ""
    @State private var photo = ""
    @State private var loaded = false
    @State private var error: String?
    @AppStorage("sidebar.web.avatarImages") private var avatars = "{}"

    var body: some View {
        SettingsPageForm("account") {
            Section {
                HStack(alignment: .top, spacing: metrics.size(22)) {
                    SidebarCoverImage(source: photo, side: 76, cornerRadius: 38) {
                        Image("DefaultProfile").resizable().aspectRatio(contentMode: .fill)
                    }
                    VStack(alignment: .leading, spacing: metrics.size(14)) {
                        VStack(alignment: .leading, spacing: metrics.size(6)) {
                            Text("settings.web.reference.prefs.displayName")
                                .font(metrics.font(size: 11, weight: .semibold)).foregroundStyle(theme[.fgMuted])
                            TextField("settings.web.reference.prefs.namePlaceholder", text: $name)
                                .modifier(ProjectGroupWebInput())
                                .onChange(of: name) { _, value in
                                    let capped = String(value.prefix(60))
                                    if capped != value { name = capped }
                                    if loaded { environment.preferences?.update { $0.displayName = capped } }
                                }
                        }
                        ImageInputField(value: $photo, name: name, color: nil,
                            label: "settings.web.reference.prefs.profilePhoto",
                            placeholder: "settings.web.reference.prefs.photoPlaceholder",
                            hint: "settings.web.reference.image.urlOrUpload")
                    }
                }
                if let error { Text(verbatim: error).foregroundStyle(theme[.statusStopped]) }
            } header: { Text("settings.web.reference.prefs.profile") }
              footer: { Text("settings.web.reference.prefs.profileDesc") }
            Section {
                HStack(spacing: metrics.size(10)) {
                    ForEach(AppLanguage.allCases.filter { $0 != .system }, id: \.self) { option in
                        Button { language = option } label: {
                            HStack {
                                Text(verbatim: option.nativeName ?? option.rawValue)
                                Spacer(minLength: 0)
                                Image(systemName: "checkmark").opacity(language == option ? 1 : 0)
                            }
                            .frame(maxWidth: .infinity, minHeight: metrics.size(44))
                        }
                    }
                }
                .accessibilityIdentifier("settings.language")
                if language != environment.launchLanguage {
                    HStack {
                        Text("settings.appearance.language.restartNote")
                        Button("settings.appearance.language.restart") { AppRelaunch.relaunch() }
                            .accessibilityIdentifier("settings.language.restart")
                    }
                    .accessibilityIdentifier("settings.language.restartNote")
                }
            } header: { Text("settings.web.reference.prefs.language") }
              footer: { Text("settings.web.reference.prefs.languageDesc") }
            Section {
                Button { managing = true } label: {
                    Label("settings.web.reference.profile.manageAccounts", systemImage: "person")
                }.accessibilityIdentifier("settings.profiles.manage")
            } header: { Text("settings.web.reference.prefs.localAccounts") }
              footer: { Text("settings.web.reference.prefs.localAccountsDesc") }
        }
        .gitWebSheet(isPresented: $managing, width: 760) { ProfilesWebModal() }
        .onChange(of: environment.settingsTab) { _, _ in openRequestedProfiles() }
        .onAppear {
            openRequestedProfiles()
            name = environment.preferences?.document.displayName ?? environment.activeProfileName
            let values = (try? JSONDecoder().decode([String: String].self, from: Data(avatars.utf8))) ?? [:]
            if let bytes = values[environment.profileID?.rawValue ?? "default"] {
                photo = "data:image/png;base64," + bytes
            }
            if let source = environment.preferences?.document.profileImageUrl { photo = source }
            loaded = true
        }
        .onChange(of: language) { _, value in LanguageSetting().set(value) }
        .onChange(of: photo) { _, value in
            if loaded { environment.preferences?.update { $0.profileImageUrl = value } }
        }
    }


}

extension WebAccountSettings {
    /// "Manage accounts" in the profile menus lands here and opens the accounts modal directly.
    fileprivate func openRequestedProfiles() {
        guard environment.settingsTab == .profiles else { return }
        environment.settingsTab = .general
        managing = true
    }
}

struct WebOrganizationSettings: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var deleting: ProjectGroup?
    @AppStorage(SidebarProjectVisibility.archivedGroupsKey) private var archivedGroups = "[]"

    private var groups: [ProjectGroup] {
        (environment.workspace?.document.groups ?? []).filter {
            SidebarProjectVisibility.containsGroup(archivedGroups, group: $0.id, profile: environment.profileID)
        }
    }
    @Environment(AppEnvironment.self) private var environment

    private var projects: [Project] {
        (environment.workspace?.document.projects ?? []).filter {
            $0.archived == true
        }
    }

    var body: some View {
        SettingsPageForm("organization") {
            Section {
                if groups.isEmpty { Text("settings.web.reference.prefs.archivedGroupsEmpty") }
                ForEach(groups) { group in
                    HStack(spacing: metrics.size(14)) {
                        VStack(alignment: .leading, spacing: metrics.size(4)) {
                            Text(verbatim: group.name).font(metrics.font(size: 12, weight: .bold))
                            Text(verbatim: String(format: String(localized: "settings.organization.projectCount"), group.projectIDs.count))
                                .font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                        }
                        Spacer(minLength: 0)
                        Button {
                            archivedGroups = SidebarProjectVisibility.settingGroup(archivedGroups, group: group.id,
                                profile: environment.profileID, enabled: false)
                        } label: { Label("settings.organization.restoreGroup", systemImage: "archivebox") }
                        Button { deleting = group } label: { Image(systemName: "trash").webProfileSized(14) }
                            .foregroundStyle(theme[.statusStopped])
                            .accessibilityLabel(Text("settings.organization.deleteGroup"))
                    }
                }
            } header: { Text("settings.web.reference.prefs.archivedGroupsTitle") }
              footer: { Text("settings.web.reference.prefs.archivedGroupsDesc") }
            Section {
                if projects.isEmpty { Text("settings.web.reference.prefs.archivedProjectsEmpty") }
                ForEach(projects) { project in
                    HStack {
                        Text(verbatim: project.name)
                        Spacer(minLength: 0)
                        Button("settings.web.reference.prefs.restoreProject") {
                            environment.workspace?.update { $0.updateProject(project.id) { $0.archived = false } }
                        }
                    }
                }
            } header: { Text("settings.web.reference.prefs.archivedProjectsTitle") }
              footer: { Text("settings.web.reference.prefs.archivedProjectsDesc") }
        }
        .webConfirm(isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                    message: String(localized: "settings.organization.deleteGroupConfirm"),
                    title: String(localized: "settings.organization.deleteGroup"),
                    confirmTitle: String(localized: "settings.organization.deleteGroup"), destructive: true) {
            if let group = deleting {
                environment.workspace?.update { $0.deleteGroup(group.id) }
                archivedGroups = SidebarProjectVisibility.settingGroup(archivedGroups, group: group.id,
                    profile: environment.profileID, enabled: false)
            }
        }
        .alert("settings.organization.deleteGroup", isPresented: Binding(get: { !metrics.isWebInterface && deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("settings.organization.deleteGroup", role: .destructive) {
                if let group = deleting {
                    environment.workspace?.update { $0.deleteGroup(group.id) }
                    archivedGroups = SidebarProjectVisibility.settingGroup(archivedGroups, group: group.id,
                        profile: environment.profileID, enabled: false)
                }
                deleting = nil
            }
            Button("image.ok", role: .cancel) { deleting = nil }
        } message: {
            Text("settings.organization.deleteGroupConfirm")
        }
    }
}

struct WebTerminalSettings: View {
    @Environment(AppEnvironment.self) private var environment
    private var policy: ResourcePolicy { environment.preferences?.document.resources ?? ResourcePolicy() }

    var body: some View {
        SettingsPageForm("terminal") {
            Section {
                ResourcePolicyPicker()
                WebStepperRow(title: format("resources.agentIdle", policy.hiddenAgentIdleMinutes),
                              value: idle(\.hiddenAgentIdleMinutes), range: ResourcePolicy.agentIdleRange, step: 5)
                    .accessibilityIdentifier("resources.agentIdle")
                WebStepperRow(title: format("resources.shellIdle", policy.hiddenShellIdleMinutes),
                              value: idle(\.hiddenShellIdleMinutes), range: ResourcePolicy.shellIdleRange, step: 5)
                    .accessibilityIdentifier("resources.shellIdle")
            } header: { Text("settings.web.reference.prefs.resourcePolicy") }
              footer: { Text("settings.web.reference.prefs.resourcePolicyDesc") }
            Section { SpawnConcurrencyField() }
                header: { Text("settings.web.reference.prefs.spawnConcurrency") }
                footer: { Text("settings.web.reference.prefs.spawnConcurrencyDesc") }
            Section {
                ForEach(AgentRegistry.builtin.descriptors.filter { !$0.isShell }) { agent in
                    AgentSettingsRow(agent: agent)
                }
            } header: { Text("settings.web.reference.prefs.agentsTitle") }
              footer: { Text("settings.agents.footer") }
            Section { ShellPathField() }
                header: { Text("settings.web.reference.prefs.shell") }
                footer: { Text("settings.web.reference.prefs.shellDesc") }
            Section { TerminalFontField() }
                header: { Text("settings.web.reference.prefs.terminalFont") }
                footer: { Text("settings.web.reference.prefs.terminalFontDesc") }
            CustomAgentsSection()
            Section {
                Toggle("settings.web.reference.prefs.limitResetNotifyOn", isOn: Binding {
                    environment.preferences?.document.notifyLimitReset ?? true
                } set: { value in environment.preferences?.update { $0.notifyLimitReset = value ? nil : false } })
                .accessibilityIdentifier("settings.notifyLimitReset")
            } header: { Text("settings.web.reference.prefs.limitResetNotify") }
              footer: { Text("settings.web.reference.prefs.limitResetNotifyDesc") }
            Section {
                Toggle(isOn: Binding {
                    environment.preferences?.document.alwaysStartUnrestricted ?? false
                } set: { value in environment.preferences?.update { $0.alwaysStartUnrestricted = value } }) {
                    Text("settings.general.alwaysUnrestricted")
                    Text("settings.general.alwaysUnrestricted.help")
                }.accessibilityIdentifier("settings.alwaysUnrestricted")
            } header: { Text("settings.web.reference.prefs.experimentalPermissions") }
              footer: { Text("settings.web.reference.prefs.experimentalPermissionsDesc") }
            Section {
                Toggle(isOn: Binding {
                    environment.preferences?.document.startClean ?? false
                } set: { value in environment.preferences?.update { $0.startClean = value ? true : nil } }) {
                    Text("settings.general.startClean")
                    Text("settings.general.startClean.help")
                }.accessibilityIdentifier("settings.startClean")
            } header: { Text("settings.web.reference.prefs.resetSession") }
              footer: { Text("settings.web.reference.prefs.resetSessionDesc") }
        }
    }

    private func idle(_ keyPath: WritableKeyPath<ResourcePolicy, Int>) -> Binding<Int> {
        Binding { policy[keyPath: keyPath] } set: { value in
            environment.preferences?.update {
                var next = $0.resources
                next[keyPath: keyPath] = value
                $0.resourcePolicy = next.normalized
            }
        }
    }
}

struct WebAboutSettings: View {
    @Environment(\.metrics) private var metrics
    @State private var updates = SettingsUpdateController()

    var body: some View {
        SettingsPageForm("about") {
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: metrics.size(2)) {
                        Text(verbatim: "Alethe").font(metrics.font(size: 14, weight: .semibold))
                        Text(verbatim: "com.kc1t.alethe").font(metrics.font(size: 11))
                    }
                    Spacer(minLength: 0)
                    Text(verbatim: "v" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"))
                        .font(metrics.font(size: 15, weight: .bold).monospacedDigit())
                }
            } header: { Text("settings.web.reference.prefs.aboutVersionTitle") }
              footer: { Text("settings.web.reference.prefs.aboutVersionDesc") }
            Section {
                switch updates.phase {
                case .checking:
                    WebBusyIndicator()
                    Text("settings.updates.checking")
                case .downloading:
                    WebBusyIndicator()
                    Text("settings.updates.downloading")
                case .available:
                    Text(verbatim: updates.version).font(metrics.font(size: 12, weight: .semibold))
                    if !updates.notes.isEmpty { Text(verbatim: updates.notes).textSelection(.enabled) }
                    Button("settings.updates.download") { Task { await updates.download() } }
                case .ready:
                    Button("settings.updates.openInstaller") { updates.openInstaller() }
                    Text("settings.updates.manualInstall").font(metrics.font(size: 11))
                case .idle, .current, .failed:
                    Button("settings.web.reference.prefs.aboutCheckUpdates") { Task { await updates.check() } }
                    if updates.phase == .current { Text("settings.updates.current") }
                    if !updates.error.isEmpty { Text(verbatim: updates.error).textSelection(.enabled) }
                }
            } header: { Text("settings.web.reference.prefs.aboutUpdatesTitle") }
              footer: { Text("settings.web.reference.prefs.aboutUpdatesDesc") }
        }
    }
}

/// Web `TerminalPage` spawn concurrency stepper: 1...8, default 3.
private struct SpawnConcurrencyField: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    private var value: Int { min(8, max(1, environment.preferences?.document.spawnConcurrency ?? 3)) }

    var body: some View {
        HStack(spacing: metrics.size(10)) {
            step("minus", "settings.web.reference.prefs.spawnConcurrencyDecrease", value <= 1) { set(value - 1) }
            Text(verbatim: String(value)).font(metrics.monoFont(size: 13, weight: .bold))
                .frame(minWidth: metrics.size(32)).foregroundStyle(theme[.fg])
            step("plus", "settings.web.reference.prefs.spawnConcurrencyIncrease", value >= 8) { set(value + 1) }
            step("arrow.counterclockwise", "settings.web.reference.prefs.spawnConcurrencyReset", value == 3) { set(3) }
        }
    }

    private func step(_ symbol: String, _ label: LocalizedStringKey, _ off: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).webProfileSized(15) }
            .buttonStyle(SettingsZoomButtonStyle()).disabled(off).accessibilityLabel(Text(label))
    }

    private func set(_ n: Int) {
        let clamped = min(8, max(1, n))
        environment.preferences?.update { $0.spawnConcurrency = clamped == 3 ? nil : clamped }
    }
}

/// Web `TerminalPage` shell executable override: Set... picks a file, Reset returns to automatic.
private struct ShellPathField: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    private var path: String? { environment.preferences?.document.shellPath }

    var body: some View {
        HStack(spacing: metrics.size(10)) {
            Text(verbatim: path ?? String(localized: "settings.shell.auto"))
                .font(metrics.monoFont(size: 11)).foregroundStyle(theme[path == nil ? .fgMuted : .fg])
                .lineLimit(1).truncationMode(.middle).help(path ?? "")
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("settings.shell.set") {
                let panel = NSOpenPanel()
                panel.title = String(localized: "settings.shell.pick")
                panel.canChooseDirectories = false
                panel.allowsMultipleSelection = false
                guard panel.runModal() == .OK, let url = panel.url else { return }
                environment.preferences?.update { $0.shellPath = url.path }
            }
            if path != nil {
                Button("settings.shell.reset") { environment.preferences?.update { $0.shellPath = nil } }
            }
        }
    }
}

/// Web `TerminalPage` font family input, committed on Enter or focus loss.
private struct TerminalFontField: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var draft = ""
    @FocusState private var focused: Bool
    private static let fallback = "Cascadia Mono, Consolas, \"Courier New\", monospace"

    var body: some View {
        TextField(text: $draft, prompt: Text(verbatim: Self.fallback)) { Text("settings.web.reference.prefs.terminalFontFamily") }
            .focused($focused)
            .onSubmit(commit)
            .onChange(of: focused) { _, now in if !now { commit() } }
            .onAppear { draft = environment.preferences?.document.terminalFontFamily ?? "" }
    }

    private func commit() {
        let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let stored: String? = next.isEmpty || next == Self.fallback ? nil : next
        draft = stored ?? ""
        guard stored != environment.preferences?.document.terminalFontFamily else { return }
        environment.preferences?.update { $0.terminalFontFamily = stored }
    }
}
