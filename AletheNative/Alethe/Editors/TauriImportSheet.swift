import AletheAgents
import AletheDesign
import AletheFoundation
import AletheModel
import SwiftUI

/// File › Import from Alethe (Tauri)…: previews what the Tauri app's data adds (a dry run on copies
/// of the documents), then imports it as one undoable change. The Tauri files are only read.
struct TauriImportSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    /// Told what an import added (the onboarding's import step shows it).
    var onImported: ((TauriImport.Report) -> Void)?
    /// A `projects.json` to import instead of the Tauri app's profiles (a pulled Tauri gist, P7-15).
    var projectsFile: URL?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    @State private var profiles: [TauriProfile] = []
    @State private var profileID: String?
    @State private var includePreferences = true
    @State private var done: TauriImport.Report?
    @State private var languageChanged = false
    @State private var preview: Result<TauriImport.Report, TauriImport.Failure>?

    private var profile: TauriProfile? { profiles.first { $0.id == profileID } ?? profiles.first }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text("import.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(14)) {

            if let done {
                summary(done, title: "import.done")
                if languageChanged {
                    Section {
                        HStack {
                            Text("settings.appearance.language.restartNote").foregroundStyle(theme[.fgMuted])
                            Spacer()
                            Button("settings.appearance.language.restart") { AppRelaunch.relaunch() }
                        }
                    }
                }
            } else if profiles.isEmpty {
                Text("import.noData")
                    .foregroundStyle(theme[.fgMuted])
                    .accessibilityIdentifier("import.noData")
            } else {
                Section {
                    if profiles.count > 1 {
                        WebDropdown(selection: $profileID, options: profiles.map { Optional($0.id) }, accessibilityID: "newTerminal.rowSelect") { id in
                            Text(verbatim: profiles.first { Optional($0.id) == id }?.name ?? "")
                        }.accessibilityLabel(Text("import.profile"))
                        .accessibilityIdentifier("import.profile")
                    }
                    Toggle(isOn: $includePreferences) {
                        Text("import.preferences")
                        Text("import.preferences.help")
                    }
                    .accessibilityIdentifier("import.preferences")
                }
                switch preview {
                case .success(let report) where report.isEmpty:
                    Text("import.nothingNew")
                        .foregroundStyle(theme[.fgMuted])
                        .accessibilityIdentifier("import.nothingNew")
                    skipped(report)
                case .success(let report):
                    summary(report, title: "import.preview")
                case .failure(let failure):
                    Text(verbatim: message(for: failure))
                        .foregroundStyle(theme[.fgMuted])
                        .accessibilityIdentifier("import.failure")
                case nil:
                    EmptyView()
                }
            }
            }
        } footer: {
            Spacer()
            Button(done == nil ? "editor.cancel" : "import.close", action: dismiss)
                .accessibilityIdentifier(done == nil ? "editor.cancel" : "editor.confirm")
            if done == nil {
                Button("import.confirm", action: runImport).buttonStyle(AletheButtonStyle(.primary))
                    .disabled(!canImport).accessibilityIdentifier("editor.confirm")
            }
        }
        .onAppear {
            profiles = projectsFile.map {
                [TauriProfile(id: "file", name: $0.lastPathComponent, projectsFile: $0, isActive: true)]
            } ?? Self.availableProfiles()
            profileID = profiles.first?.id
            refreshPreview()
        }
        .onChange(of: profileID) { refreshPreview() }
        .onChange(of: includePreferences) { refreshPreview() }
    }

    private var nativeBody: some View {
        Form {
            if let done {
                summary(done, title: "import.done")
                if languageChanged {
                    Section {
                        HStack {
                            Text("settings.appearance.language.restartNote").foregroundStyle(.secondary)
                            Spacer()
                            Button("settings.appearance.language.restart") { AppRelaunch.relaunch() }
                        }
                    }
                }
            } else if profiles.isEmpty {
                Text("import.noData")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("import.noData")
            } else {
                Section {
                    if profiles.count > 1 {
                        Picker(selection: $profileID) {
                            ForEach(profiles) { profile in
                                Text(verbatim: profile.name).tag(String?.some(profile.id))
                            }
                        } label: { Text("import.profile") }
                        .accessibilityIdentifier("import.profile")
                    }
                    Toggle(isOn: $includePreferences) {
                        Text("import.preferences")
                        Text("import.preferences.help")
                    }
                    .accessibilityIdentifier("import.preferences")
                }
                switch preview {
                case .success(let report) where report.isEmpty:
                    Text("import.nothingNew")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("import.nothingNew")
                    skipped(report)
                case .success(let report):
                    summary(report, title: "import.preview")
                case .failure(let failure):
                    Text(verbatim: message(for: failure))
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("import.failure")
                case nil:
                    EmptyView()
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: metrics.size(460))
        .toolbar {
            if done == nil {
                ToolbarItem(placement: .cancellationAction) {
                    Button("editor.cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("import.confirm") { runImport() }
                        .disabled(!canImport)
                        .accessibilityIdentifier("editor.confirm")
                }
            } else {
                ToolbarItem(placement: .confirmationAction) {
                    Button("import.close") { dismiss() }
                        .accessibilityIdentifier("editor.confirm")
                }
            }
        }
        .navigationTitle(Text("import.title"))
        .onAppear {
            profiles = projectsFile.map {
                [TauriProfile(id: "file", name: $0.lastPathComponent, projectsFile: $0, isActive: true)]
            } ?? Self.availableProfiles()
            profileID = profiles.first?.id
            refreshPreview()
        }
        .onChange(of: profileID) { refreshPreview() }
        .onChange(of: includePreferences) { refreshPreview() }
    }

    // MARK: - Content

    private func summary(_ report: TauriImport.Report, title: LocalizedStringKey) -> some View {
        Group {
            Section {
                LabeledContent("import.groups") { Text(verbatim: "\(report.groups)") }
                LabeledContent("import.projects") { Text(verbatim: "\(report.projects)") }
                LabeledContent("import.terminals") { Text(verbatim: "\(report.panes)") }
                if !report.preferences.isEmpty || report.language != nil {
                    LabeledContent("import.preferencesChanged") {
                        Text(verbatim: preferenceNames(report).formatted(.list(type: .and)))
                            .multilineTextAlignment(.trailing)
                    }
                }
            } header: {
                Text(title)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("import.summary")
            skipped(report)
        }
    }

    @ViewBuilder
    private func skipped(_ report: TauriImport.Report) -> some View {
        if !report.skipped.isEmpty {
            Section {
                ForEach(Array(report.skipped.enumerated()), id: \.offset) { _, skip in
                    Text(verbatim: reason(for: skip))
                        .font(metrics.font(.footnote))
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(verbatim: format("import.skipped.header", report.skipped.count))
            }
            .accessibilityIdentifier("import.skipped")
        }
    }

    private func reason(for skip: TauriImport.Skip) -> String {
        switch skip {
        case .projectWithoutFolder(let project): format("import.skip.noFolder", project)
        case .projectAlreadyAdded(let project): format("import.skip.alreadyAdded", project)
        case .projectArchived(let project): format("import.skip.archived", project)
        case .paneKind(let project, let kind): format("import.skip.paneKind", project, kind)
        case .agent(let project, let agent): format("import.skip.agent", project, AgentLabels.name(for: agent))
        }
    }

    private func preferenceNames(_ report: TauriImport.Report) -> [String] {
        var names = TauriImport.Preference.allCases.filter(report.preferences.contains).map { preference in
            switch preference {
            case .theme: String(localized: "import.pref.theme")
            case .interfaceSize: String(localized: "import.pref.interfaceSize")
            case .enabledAgents: String(localized: "import.pref.agents")
            case .alwaysUnrestricted: String(localized: "import.pref.unrestricted")
            case .cliPaths: String(localized: "import.pref.cliPaths")
            case .features: String(localized: "import.pref.features")
            case .appIcon: String(localized: "import.pref.appIcon")
            case .toolbar: String(localized: "import.pref.toolbar")
            case .mcp: String(localized: "import.pref.mcp")
            case .integrations: String(localized: "import.pref.integrations")
            case .router9: String(localized: "import.pref.router9")
            case .remote: String(localized: "import.pref.remote")
            }
        }
        if report.language != nil { names.append(String(localized: "import.pref.language")) }
        if report.secrets.contains(.spotifyClientSecret) || report.secrets.contains(.spotifyTokens) {
            names.append(String(localized: "import.pref.spotify"))
        }
        if report.secrets.contains(.githubToken) || report.gistSync != nil {
            names.append(String(localized: "import.pref.githubSync"))
        }
        if report.secrets.contains(.router9APIKey), !report.preferences.contains(.router9) {
            names.append(String(localized: "import.pref.router9"))
        }
        return names
    }

    private func message(for failure: TauriImport.Failure) -> String {
        switch failure {
        case .unreadable: String(localized: "import.failure.unreadable")
        case .unsupportedVersion(let version?) where version > TauriImport.supportedVersions.upperBound:
            format("import.failure.newer", version)
        case .unsupportedVersion: String(localized: "import.failure.older")
        }
    }

    // MARK: - Import

    private var context: TauriImport.Context {
        TauriImport.Context(agents: Set(AgentRegistry.builtin.kinds.map(\.rawValue)),
                            themes: Set(ThemeCatalog.builtin.themes.map(\.id)),
                            includePreferences: includePreferences)
    }

    private func load() -> Result<TauriImport.File, TauriImport.Failure>? {
        guard let profile else { return nil }
        guard let data = try? Data(contentsOf: profile.projectsFile) else { return .failure(.unreadable) }
        do {
            return .success(try TauriImport.File(data: data))
        } catch {
            return .failure(error)
        }
    }

    /// The import run on copies: exactly what Import will do.
    private func refreshPreview() {
        guard let preferences = environment.preferences else { return }
        preview = load()?.map { file in
            var doc = workspace.document
            var prefs = preferences.document
            return languageAdjusted(TauriImport.apply(file, companions: companions(), to: &doc, preferences: &prefs,
                                                      context: context))
        }
    }

    private var canImport: Bool {
        if case .success(let report)? = preview { return !report.isEmpty }
        return false
    }

    private func runImport() {
        guard case .success(let file)? = load(), let preferences = environment.preferences else { return }
        var report = TauriImport.Report()
        var prefs = preferences.document
        let companions = companions()
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.import")) { doc in
            report = TauriImport.apply(file, companions: companions, to: &doc, preferences: &prefs, context: context)
        }
        if prefs != preferences.document { preferences.update { $0 = prefs } }
        if let profile, let locations = environment.locations, let profileID = environment.profileID {
            TauriImport.copyOrchestratorJobs(from: profile.projectsFile, into: locations.profileDirectory(profileID))
            Self.storeSecrets(TauriImport.secrets(in: file, companions: companions, context: context),
                              gistSync: report.gistSync, profile: profileID, locations: locations)
        }
        report = languageAdjusted(report)
        if let code = report.language, let language = AppLanguage(rawValue: code) {
            LanguageSetting().set(language)
            languageChanged = language != environment.launchLanguage
        }
        done = report
        onImported?(report)
    }

    /// The Tauri profile's token files, read at preview and import time only.
    private func companions() -> TauriImport.Companions {
        profile.map { TauriImport.Companions.beside($0.projectsFile) } ?? TauriImport.Companions()
    }

    /// Plaintext Tauri secrets go to the Keychain, and the gist status (never its token) to the
    /// profile's `github_sync.json`, off the main thread. Failures record the item, never its value.
    private static func storeSecrets(_ secrets: TauriImport.Secrets, gistSync: GistSyncState?, profile: ProfileID,
                                     locations: DataLocations) {
        guard !secrets.values.isEmpty || gistSync != nil else { return }
        let store = KeychainStore.forLaunch()
        Task.detached(priority: .utility) {
            for (item, value) in secrets.values {
                do {
                    try store.set(value, for: item, profile: profile.rawValue)
                } catch {
                    AppLog.record(.error, .persistence, "Keychain import of \(item.rawValue) failed: \(error)")
                }
            }
            guard let imported = gistSync else { return }
            let url = locations.gistSync(profile)
            var state = GistSyncState.load(from: url)
            state.login = imported.login ?? state.login
            state.tauriGistID = imported.tauriGistID ?? state.tauriGistID
            do {
                try state.write(to: url)
            } catch {
                AppLog.record(.error, .persistence, "Gist sync status import failed: \(error)")
            }
        }
    }

    /// Drops the language when it is one the app does not offer or the one already chosen.
    private func languageAdjusted(_ report: TauriImport.Report) -> TauriImport.Report {
        var report = report
        if let code = report.language {
            let language = AppLanguage(rawValue: code)
            if language == nil || language == LanguageSetting().current() { report.language = nil }
        }
        return report
    }

    /// The Tauri app's profiles on this Mac. Reads a few small files; the onboarding asks it once.
    nonisolated static func availableProfiles() -> [TauriProfile] {
        #if DEBUG
        // `-AletheTauriProjectsFile <path>`: one fixture file instead of the Tauri app's profiles, for
        // UI tests. Under a test data root without it, the Mac's own Tauri data is never offered.
        // Profile discovery itself is unit-tested.
        if let path = UserDefaults.standard.string(forKey: "AletheTauriProjectsFile") {
            return [TauriProfile(id: "test", name: "Test", projectsFile: URL(filePath: path), isActive: true)]
        }
        if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil { return [] }
        #endif
        return TauriDataLocation.defaultRoot().map { TauriDataLocation.profiles(root: $0) } ?? []
    }
}
