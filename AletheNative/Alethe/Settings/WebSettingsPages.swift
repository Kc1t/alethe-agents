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
    @State private var managing = false
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
                                .onSubmit(saveName)
                                .disabled(environment.profileID == nil)
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
        .gitWebSheet(isPresented: $managing, width: 700) {
            WebSettingsSubdialog(title: "settings.profiles.tab") { ProfileSettings() }
        }
        .onAppear {
            name = environment.activeProfileName
            let values = (try? JSONDecoder().decode([String: String].self, from: Data(avatars.utf8))) ?? [:]
            if let bytes = values[environment.profileID?.rawValue ?? "default"] {
                photo = "data:image/png;base64," + bytes
            }
            loaded = true
        }
        .onChange(of: language) { _, value in LanguageSetting().set(value) }
        .onDisappear(perform: saveName)
        .task(id: photo) { await savePhoto() }
    }

    private func saveName() {
        guard let profile = environment.profileID, name != environment.activeProfileName else { return }
        Task {
            do { try await environment.renameProfile(profile, to: String(name.prefix(60))) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func savePhoto() async {
        guard loaded else { return }
        let source = photo
        let data: Data?
        if source.isEmpty { data = nil }
        else if source.hasPrefix("data:"), let comma = source.firstIndex(of: ",") {
            data = Data(base64Encoded: String(source[source.index(after: comma)...]))
        } else if let url = URL(string: source), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            data = try? await URLSession.shared.data(from: url).0
        } else { return }
        guard !Task.isCancelled, photo == source else { return }
        if !source.isEmpty, data == nil { return }
        var values = (try? JSONDecoder().decode([String: String].self, from: Data(avatars.utf8))) ?? [:]
        values[environment.profileID?.rawValue ?? "default"] = data?.base64EncodedString()
        if let encoded = try? JSONEncoder().encode(values), let text = String(data: encoded, encoding: .utf8) { avatars = text }
    }
}

struct WebOrganizationSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @AppStorage(SidebarProjectVisibility.archivedKey) private var archived = "[]"

    private var projects: [Project] {
        (environment.workspace?.document.projects ?? []).filter {
            SidebarProjectVisibility.contains(archived, project: $0.id, profile: environment.profileID)
        }
    }

    var body: some View {
        SettingsPageForm("organization") {
            Section {
                Text("settings.web.reference.prefs.archivedGroupsEmpty")
            } header: { Text("settings.web.reference.prefs.archivedGroupsTitle") }
              footer: { Text("settings.web.reference.prefs.archivedGroupsDesc") }
            Section {
                if projects.isEmpty { Text("settings.web.reference.prefs.archivedProjectsEmpty") }
                ForEach(projects) { project in
                    HStack {
                        Text(verbatim: project.name)
                        Spacer(minLength: 0)
                        Button("settings.web.reference.prefs.restoreProject") {
                            archived = SidebarProjectVisibility.setting(archived, project: project.id,
                                profile: environment.profileID, enabled: false)
                        }
                    }
                }
            } header: { Text("settings.web.reference.prefs.archivedProjectsTitle") }
              footer: { Text("settings.web.reference.prefs.archivedProjectsDesc") }
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
                Stepper(value: idle(\.hiddenAgentIdleMinutes), in: ResourcePolicy.agentIdleRange, step: 5) {
                    Text(verbatim: format("resources.agentIdle", policy.hiddenAgentIdleMinutes))
                }.accessibilityIdentifier("resources.agentIdle")
                Stepper(value: idle(\.hiddenShellIdleMinutes), in: ResourcePolicy.shellIdleRange, step: 5) {
                    Text(verbatim: format("resources.shellIdle", policy.hiddenShellIdleMinutes))
                }.accessibilityIdentifier("resources.shellIdle")
            } header: { Text("settings.web.reference.prefs.resourcePolicy") }
              footer: { Text("settings.web.reference.prefs.resourcePolicyDesc") }
            Section { WebUnavailableFields(labels: ["settings.web.reference.prefs.spawnConcurrency"]) }
                header: { Text("settings.web.reference.prefs.spawnConcurrency") }
                footer: { Text("settings.web.reference.prefs.spawnConcurrencyDesc") }
            Section {
                ForEach(AgentRegistry.builtin.descriptors.filter { !$0.isShell }) { agent in
                    AgentSettingsRow(agent: agent)
                }
            } header: { Text("settings.web.reference.prefs.agentsTitle") }
              footer: { Text("settings.agents.footer") }
            Section { WebUnavailableFields(labels: ["settings.web.reference.prefs.shell"]) }
                header: { Text("settings.web.reference.prefs.shell") }
                footer: { Text("settings.web.reference.prefs.shellDesc") }
            Section { WebUnavailableFields(labels: ["settings.web.reference.prefs.terminalFontFamily"]) }
                header: { Text("settings.web.reference.prefs.terminalFont") }
                footer: { Text("settings.web.reference.prefs.terminalFontDesc") }
            Section { Text("settings.web.unavailable") }
                header: { Text("settings.web.reference.prefs.customAgents") }
                footer: { Text("settings.web.reference.prefs.customAgentsDesc") }
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

struct WebOrchestrationSettings: View {
    var body: some View {
        SettingsPageForm("orchestration") {
            Section {
                WebUnavailableFields(labels: ["settings.web.reference.prefs.orchestrationSkillBackend",
                    "settings.web.reference.prefs.orchestrationSkillPreferred", "settings.web.reference.prefs.orchestrationSkillConserve"])
            }
                header: { Text("settings.web.reference.prefs.orchestrationSkill") }
                footer: { Text("settings.web.reference.prefs.orchestrationSkillDesc") }
            Section {
                WebUnavailableFields(labels: ["settings.web.reference.prefs.orchestrationConcurrency",
                    "settings.web.reference.prefs.orchestrationDefaultTimeout", "settings.web.reference.prefs.orchestrationBudget",
                    "settings.web.reference.prefs.orchestrationWorkerPlugins"])
            }
                header: { Text("settings.web.reference.prefs.orchestrationLimits") }
                footer: { Text("settings.web.reference.prefs.orchestrationLimitsDesc") }
            Section { Text("settings.web.unavailable") }
                header: { Text("settings.web.reference.prefs.orchestrationRoles") }
                footer: { Text("settings.web.reference.prefs.orchestrationRolesDesc") }
            Section { Text("settings.web.unavailable") }
                header: { Text("settings.web.reference.prefs.orchestrationRouting") }
                footer: { Text("settings.web.reference.prefs.orchestrationRoutingDesc") }
        }
    }
}

struct WebAboutSettings: View {
    @Environment(\.metrics) private var metrics
    @State private var release: SidebarNativeRelease?
    @State private var checking = false

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
                Button("settings.web.reference.prefs.aboutCheckUpdates") {
                    checking = true
                    Task { release = await SidebarNativeRelease.check(); checking = false }
                }.disabled(checking)
                if let release {
                    Link(destination: release.page) { Text(verbatim: release.version) }
                }
            } header: { Text("settings.web.reference.prefs.aboutUpdatesTitle") }
              footer: { Text("settings.web.reference.prefs.aboutUpdatesDesc") }
        }
    }
}

/// An empty disabled input identifies a web setting with no native preference or service yet.
/// It deliberately has no invented saved value.
struct WebUnavailableFields: View {
    let labels: [LocalizedStringKey]
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            ForEach(Array(labels.enumerated()), id: \.offset) { _, label in
                VStack(alignment: .leading, spacing: metrics.size(6)) {
                    Text(label).font(metrics.font(size: 11, weight: .semibold)).foregroundStyle(theme[.fgMuted])
                    TextField(text: .constant(""), prompt: Text("settings.web.unavailable")) { Text(label) }
                        .textFieldStyle(.plain)
                        .font(metrics.font(size: 11))
                        .padding(.horizontal, metrics.size(10))
                        .frame(height: metrics.size(38))
                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .disabled(true)
                }
            }
        }
    }
}
