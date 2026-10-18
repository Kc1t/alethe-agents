import AletheDesign
import AletheModel
import SwiftUI

/// Settings › Profiles (P5-9, upstream `ProfilesModal`): every profile with its projects, terminals and
/// size on disk; create, rename, duplicate, delete (asks once, never the running one) and switch
/// (asks once, then relaunches into it).
struct ProfileSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var newName = ""
    @State private var summaries: [ProfileID: ProfileSummary] = [:]
    @State private var renaming: ProfileEntry?
    @State private var renameText = ""
    @State private var deleting: ProfileEntry?
    @State private var switching: ProfileEntry?
    @State private var error: String?
    @State private var busy = false

    private var entries: [ProfileEntry] {
        environment.profiles?.document.ordered(defaultName: AppEnvironment.defaultProfileName) ?? []
    }

    var body: some View {
        SettingsPageForm {
            Section {
                ForEach(entries) { entry in
                    ProfileRow(entry: entry, summary: summaries[entry.id],
                               isRunning: entry.id == environment.profileID,
                               onSwitch: { switching = entry },
                               onRename: { renameText = environment.profileName(entry); renaming = entry },
                               onDuplicate: { perform { try await environment.duplicateProfile(entry.id) } },
                               onDelete: { deleting = entry })
                }
            } header: {
                Text("settings.profiles.list")
            } footer: {
                Text("settings.profiles.help")
            }
            Section {
                HStack {
                    TextField(text: $newName, prompt: Text("settings.profiles.newName.prompt")) {
                        Text("settings.profiles.newName")
                    }
                    .onSubmit(create)
                    .accessibilityIdentifier("settings.profiles.newName")
                    Button("settings.profiles.create", action: create)
                        .disabled(ProfileIndexDocument.normalizedName(newName) == nil || busy)
                        .accessibilityIdentifier("settings.profiles.create")
                }
                if let error {
                    Text(verbatim: error)
                        .foregroundStyle(theme[.statusStopped])
                        .accessibilityIdentifier("settings.profiles.error")
                }
            }
        }
        .formStyle(.grouped)
        .disabled(environment.profiles == nil)
        .accessibilityIdentifier("settings.profiles")
        .task(id: environment.profiles?.document) { summaries = await environment.profileSummaries() }
        .webPrompt(isPresented: presented($renaming), message: String(localized: "settings.profiles.rename.title"),
                   initial: renameText, confirmTitle: String(localized: "settings.profiles.rename")) { name in
            guard let entry = renaming else { return }
            perform { try await environment.renameProfile(entry.id, to: name) }
        }
        .webConfirm(isPresented: presented($deleting),
                    message: String(localized: "settings.profiles.delete.message"),
                    title: String(format: String(localized: "settings.profiles.delete.confirm"),
                                  deleting.map(environment.profileName) ?? ""),
                    confirmTitle: String(localized: "settings.profiles.delete"), destructive: true) {
            guard let entry = deleting else { return }
            perform { try await environment.deleteProfile(entry.id) }
        }
        .webConfirm(isPresented: presented($switching),
                    message: String(localized: "settings.profiles.switch.message"),
                    title: String(format: String(localized: "settings.profiles.switch.confirm"),
                                  switching.map(environment.profileName) ?? ""),
                    confirmTitle: String(localized: "settings.profiles.switch")) {
            guard let entry = switching else { return }
            perform { try await environment.switchProfile(to: entry.id) }
        }
        .alert(Text("settings.profiles.rename.title"), isPresented: nativePresented($renaming)) {
            TextField(text: $renameText) { Text("settings.profiles.newName") }
                .accessibilityIdentifier("settings.profiles.renameField")
            Button("settings.profiles.rename") {
                guard let entry = renaming else { return }
                let name = renameText
                perform { try await environment.renameProfile(entry.id, to: name) }
            }
            .accessibilityIdentifier("settings.profiles.renameConfirm")
            Button("editor.cancel", role: .cancel) {}
        }
        .confirmationDialog(Text(verbatim: String(format: String(localized: "settings.profiles.delete.confirm"),
                                                  deleting.map(environment.profileName) ?? "")),
                            isPresented: nativePresented($deleting)) {
            Button("settings.profiles.delete", role: .destructive) {
                guard let entry = deleting else { return }
                perform { try await environment.deleteProfile(entry.id) }
            }
            .accessibilityIdentifier("settings.profiles.deleteConfirm")
        } message: {
            Text("settings.profiles.delete.message")
        }
        .confirmationDialog(Text(verbatim: String(format: String(localized: "settings.profiles.switch.confirm"),
                                                  switching.map(environment.profileName) ?? "")),
                            isPresented: nativePresented($switching)) {
            Button("settings.profiles.switch") {
                guard let entry = switching else { return }
                perform { try await environment.switchProfile(to: entry.id) }
            }
            .accessibilityIdentifier("settings.profiles.switchConfirm")
        } message: {
            Text("settings.profiles.switch.message")
        }
    }

    private func create() {
        let name = newName
        guard ProfileIndexDocument.normalizedName(name) != nil else { return }
        perform {
            try await environment.createProfile(named: name)
            newName = ""
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await action()
            } catch let failure as ProfileError {
                error = failure.localizedMessage
            } catch {
                self.error = String(format: String(localized: "settings.profiles.error.operation"), error.localizedDescription)
            }
        }
    }

    private func nativePresented(_ item: Binding<ProfileEntry?>) -> Binding<Bool> {
        Binding { !metrics.isWebInterface && item.wrappedValue != nil } set: { if !$0 { item.wrappedValue = nil } }
    }

    private func presented(_ item: Binding<ProfileEntry?>) -> Binding<Bool> {
        Binding { item.wrappedValue != nil } set: { if !$0 { item.wrappedValue = nil } }
    }
}

private struct ProfileRow: View {
    let entry: ProfileEntry
    let summary: ProfileSummary?
    let isRunning: Bool
    let onSwitch: () -> Void
    let onRename: () -> Void
    let onDuplicate: () -> Void
    let onDelete: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let name = environment.profileName(entry)
        HStack(spacing: metrics.space(.m)) {
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                HStack(spacing: metrics.space(.s)) {
                    Text(verbatim: name)
                        .accessibilityIdentifier("settings.profiles.name.\(name)")
                    if isRunning {
                        Text("settings.profiles.active")
                            .font(metrics.isWebInterface ? metrics.font(size: 10) : .caption)
                            .foregroundStyle(theme[.accent])
                            .accessibilityIdentifier("settings.profiles.active.\(name)")
                    }
                }
                Text(verbatim: detail)
                    .font(metrics.isWebInterface ? metrics.font(size: 11) : .callout)
                    .foregroundStyle(theme[.textSecondary])
                    .monospacedDigit()
            }
            Spacer()
            if !isRunning {
                Button("settings.profiles.switch", action: onSwitch)
                    .accessibilityIdentifier("settings.profiles.switch.\(name)")
            }
            HStack(spacing: metrics.space(.xs)) {
                Button(action: onRename) {
                    Label { Text("settings.profiles.rename") } icon: { Image(systemName: "pencil").webProfileSized(14) }
                }
                .help(Text("settings.profiles.rename"))
                .accessibilityIdentifier("settings.profiles.rename.\(name)")
                Button(action: onDuplicate) {
                    Label { Text("settings.profiles.duplicate") } icon: { Image(systemName: "plus.square.on.square").webProfileSized(14) }
                }
                .help(Text("settings.profiles.duplicate"))
                .accessibilityIdentifier("settings.profiles.duplicate.\(name)")
                Button(action: onDelete) {
                    Label { Text("settings.profiles.delete") } icon: { Image(systemName: "trash").webProfileSized(14) }
                }
                .help(Text(isRunning ? "settings.profiles.delete.running" : "settings.profiles.delete"))
                .disabled(isRunning)
                .accessibilityIdentifier("settings.profiles.delete.\(name)")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.profiles.row.\(name)")
    }

    private var detail: String {
        guard let summary else { return String(localized: "settings.profiles.loading") }
        return String(format: String(localized: "settings.profiles.summary"), summary.projects, summary.terminals,
                      summary.bytes.formatted(.byteCount(style: .file)))
    }
}
