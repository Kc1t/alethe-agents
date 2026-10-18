import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// ProfilesModal.tsx / ProfilesModal.module.css: the standalone accounts modal, with the typed-name
/// deletion confirmation that follows a per-profile backup. Rendered only in the web interface.
struct ProfilesWebModal: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @AppStorage("sidebar.web.avatarImages") private var avatars = "{}"
    @State private var summaries: [ProfileID: ProfileSummary] = [:]
    @State private var newName = ""
    @State private var editing: ProfileID?
    @State private var editingName = ""
    @State private var pendingDelete: ProfileEntry?
    @State private var confirmName = ""
    @State private var backupReady = false
    @State private var switching: ProfileEntry?
    @State private var busy: Busy?
    @State private var error: String?
    @State private var notice: String?
    @FocusState private var focusedRename: Bool

    private enum Busy { case load, create, rename, switching, backup, delete }

    private var entries: [ProfileEntry] {
        environment.profiles?.document.ordered(defaultName: AppEnvironment.defaultProfileName) ?? []
    }

    private func closeModal() { if let closeOverlay { closeOverlay() } else { dismiss() } }

    var body: some View {
        ModalsM2WebModal(title: Text("profiles.web.title"), close: closeModal, width: 760) {
            VStack(alignment: .leading, spacing: metrics.size(16)) {
                intro
                if let error { feedback(error, color: .statusOffline).accessibilityIdentifier("settings.profiles.error") }
                if let notice { feedback(notice, color: .statusWorking) }
                createCard
                listSection
                if let active = entries.first(where: { $0.id == environment.profileID }) {
                    Text(verbatim: String(format: String(localized: "profiles.web.activeHint"), environment.profileName(active)))
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
                if let pending = pendingDelete { deletePanel(pending) }
            }
        } footer: {}
        .task(id: environment.profiles?.document) { await load() }
        .gitWebSheet(item: $switching, width: 440) { entry in
            WebConfirmationModal(
                title: Text(verbatim: String(format: String(localized: "settings.profiles.switch.confirm"), environment.profileName(entry))),
                message: Text("settings.profiles.switch.message"), confirm: "settings.profiles.switch", destructive: false,
                confirmIdentifier: "settings.profiles.switchConfirm") { switchProfile(entry) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.profiles")
    }

    // MARK: Sections

    private var intro: some View {
        HStack(alignment: .top, spacing: metrics.size(12)) {
            iconBox(symbol: "checkmark.shield", side: 32, glyph: 18)
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                Text("profiles.web.localTitle").font(metrics.font(size: 13, weight: .bold))
                Text("profiles.web.subtitle").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(metrics.size(14)).frame(maxWidth: .infinity, alignment: .leading)
        .modifier(CardChrome(fill: .bgSunken))
    }

    private func iconBox(symbol: String, side: CGFloat, glyph: CGFloat) -> some View {
        Image(systemName: symbol).font(metrics.font(size: glyph)).foregroundStyle(theme[.accent])
            .frame(width: metrics.size(side), height: metrics.size(side))
            .background(theme[.accentFaint], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay {
                if side > 32 {
                    RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.accent].opacity(0.45), lineWidth: metrics.size(1))
                }
            }
    }

    private func feedback(_ text: String, color: ThemeToken) -> some View {
        Text(verbatim: text).font(metrics.font(size: 12)).foregroundStyle(theme[color])
            .padding(.horizontal, metrics.size(11)).padding(.vertical, metrics.size(9))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[color].opacity(0.12), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
    }

    private var createCard: some View {
        HStack(spacing: metrics.size(14)) {
            iconBox(symbol: "plus", side: 34, glyph: 17)
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                Text("profiles.web.createTitle").font(metrics.font(size: 13, weight: .bold))
                Text("profiles.web.createDescription").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            }
            Spacer(minLength: 0)
            HStack(spacing: metrics.size(8)) {
                TextField("", text: $newName, prompt: Text("profiles.web.createPlaceholder"))
                    .modifier(ProjectGroupWebInput())
                    .onSubmit(create).disabled(busy != nil)
                    .accessibilityIdentifier("settings.profiles.newName")
                Button(action: create) {
                    Label { Text("profiles.web.createButton") } icon: { icon(busy == .create ? "arrow.triangle.2.circlepath" : "plus") }
                        .frame(minWidth: metrics.size(112 - 28))
                }
                .buttonStyle(AletheButtonStyle(.primary)).disabled(busy != nil)
                .accessibilityIdentifier("settings.profiles.create")
            }
            .frame(width: metrics.size(300))
        }
        .padding(.horizontal, metrics.size(18)).padding(.vertical, metrics.size(16))
        .modifier(CardChrome(fill: .panel))
    }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: metrics.size(10)) {
            HStack {
                VStack(alignment: .leading, spacing: metrics.size(4)) {
                    Text("profiles.web.listTitle").font(metrics.font(size: 13, weight: .bold))
                    Text("profiles.web.listDescription").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
                Spacer()
                if busy == .load { ProgressView().controlSize(.small) }
            }
            if entries.isEmpty {
                Text("profiles.web.noProfiles").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    .frame(maxWidth: .infinity).padding(metrics.size(18))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.border], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(4)])))
            } else {
                VStack(spacing: metrics.size(8)) { ForEach(entries) { row($0) } }
            }
        }
    }

    private func row(_ entry: ProfileEntry) -> some View {
        let name = environment.profileName(entry)
        let active = entry.id == environment.profileID
        let summary = summaries[entry.id]
        return HStack(spacing: metrics.size(14)) {
            avatar(entry, name: name)
            VStack(alignment: .leading, spacing: metrics.size(6)) {
                HStack(spacing: metrics.size(8)) {
                    Text(verbatim: name).font(metrics.font(size: 14, weight: .bold)).lineLimit(1)
                        .accessibilityIdentifier("settings.profiles.name.\(name)")
                    if active {
                        Label { Text("profiles.web.current") } icon: { Image(systemName: "checkmark").font(metrics.font(size: 11)) }
                            .font(metrics.font(size: 10, weight: .semibold)).foregroundStyle(theme[.accent])
                            .padding(.horizontal, metrics.size(7)).padding(.vertical, metrics.size(3))
                            .background(theme[.accentFaint], in: Capsule())
                            .accessibilityIdentifier("settings.profiles.active.\(name)")
                    }
                }
                HStack(spacing: metrics.size(14)) {
                    Text(verbatim: String(format: String(localized: "profiles.web.projects"), summary?.projects ?? 0))
                    Text(verbatim: String(format: String(localized: "profiles.web.terminals"), summary?.terminals ?? 0))
                    Text(verbatim: String(format: String(localized: "profiles.web.lastUsed"), lastUsed(entry)))
                }
                .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted]).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if editing == entry.id { renameRow(entry) } else { actions(entry, name: name, active: active) }
        }
        .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(12))
        .modifier(CardChrome(fill: .bgSunken, accent: active))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.profiles.row.\(name)")
    }

    private func actions(_ entry: ProfileEntry, name: String, active: Bool) -> some View {
        HStack(spacing: metrics.size(7)) {
            if !active {
                Button { switching = entry } label: {
                    Label { Text("profiles.web.switchButton") } icon: { icon(busy == .switching ? "arrow.triangle.2.circlepath" : "arrow.left.arrow.right") }
                }
                .buttonStyle(AletheButtonStyle(.primary)).disabled(busy != nil)
                .accessibilityIdentifier("settings.profiles.switch.\(name)")
            }
            Button { editing = entry.id; editingName = name; error = nil; focusedRename = true } label: {
                Label { Text("profiles.web.renameButton") } icon: { icon("square.and.pencil") }
            }
            .disabled(busy != nil).accessibilityIdentifier("settings.profiles.rename.\(name)")
            Button { duplicate(entry) } label: {
                Label { Text("settings.profiles.duplicate") } icon: { icon("plus.square.on.square") }
            }
            .help(Text("settings.profiles.duplicate"))
            .disabled(busy != nil).accessibilityIdentifier("settings.profiles.duplicate.\(name)")
            Button { startDelete(entry) } label: {
                Label { Text("profiles.web.deleteButton") } icon: { icon("trash") }
            }
            .buttonStyle(AletheButtonStyle(.danger))
            .disabled(busy != nil || entries.count <= 1 || active)
            .help(active ? Text("settings.profiles.delete.running") : Text("profiles.web.deleteButton"))
            .accessibilityIdentifier("settings.profiles.delete.\(name)")
        }
        .labelStyle(WebProfileActionLabelStyle())
    }

    private func renameRow(_ entry: ProfileEntry) -> some View {
        HStack(spacing: metrics.size(7)) {
            TextField("", text: $editingName, prompt: Text("profiles.web.renamePlaceholder"))
                .modifier(ProjectGroupWebInput()).frame(minWidth: metrics.size(160))
                .focused($focusedRename)
                .onSubmit { saveRename(entry) }
                .onExitCommand { editing = nil }
                .accessibilityIdentifier("settings.profiles.renameField")
            Button { saveRename(entry) } label: {
                Label { Text("editor.save") } icon: { icon("checkmark") }
            }
            .buttonStyle(AletheButtonStyle(.primary)).disabled(busy != nil)
            .accessibilityIdentifier("settings.profiles.renameConfirm")
            Button { editing = nil } label: {
                Label { Text("editor.cancel") } icon: { icon("xmark") }
            }
            .disabled(busy != nil)
        }
        .labelStyle(WebProfileActionLabelStyle())
    }

    private func deletePanel(_ entry: ProfileEntry) -> some View {
        let name = environment.profileName(entry)
        let summary = summaries[entry.id]
        let matches = confirmName.trimmingCharacters(in: .whitespacesAndNewlines) == name
        return VStack(alignment: .leading, spacing: metrics.size(12)) {
            HStack(alignment: .top, spacing: metrics.size(12)) {
                VStack(alignment: .leading, spacing: metrics.size(4)) {
                    Text(verbatim: String(format: String(localized: "profiles.web.deleteTitle"), name))
                        .font(metrics.font(size: 13, weight: .bold)).foregroundStyle(theme[.statusOffline])
                    Text(verbatim: String(format: String(localized: "profiles.web.deleteDescription"),
                                          summary?.projects ?? 0, summary?.terminals ?? 0))
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
                Spacer(minLength: 0)
                Button { pendingDelete = nil } label: { Image(systemName: "xmark").font(metrics.font(size: 15)) }
                    .buttonStyle(AletheIconButtonStyle(side: 28))
                    .accessibilityLabel(Text("modalsM2.close"))
            }
            Button { exportBackup(entry) } label: {
                Label { Text(backupReady ? "profiles.web.backupDone" : "profiles.web.exportBackup") }
                    icon: { icon(busy == .backup ? "arrow.triangle.2.circlepath" : "square.and.arrow.down") }
            }
            .labelStyle(WebProfileActionLabelStyle())
            .disabled(busy != nil || backupReady).accessibilityIdentifier("settings.profiles.backup")
            ProjectGroupWebField(title: "profiles.web.confirmDeleteInput") {
                TextField("", text: $confirmName, prompt: Text(verbatim: name))
                    .modifier(ProjectGroupWebInput())
                    .disabled(!backupReady || busy != nil)
                    .accessibilityIdentifier("settings.profiles.deleteName")
            }
            .padding(.bottom, 0)
            HStack(spacing: metrics.size(7)) {
                Spacer()
                Button("editor.cancel") { pendingDelete = nil }.disabled(busy != nil)
                Button { remove(entry) } label: {
                    Label { Text("profiles.web.confirmDeleteButton") } icon: { icon(busy == .delete ? "arrow.triangle.2.circlepath" : "trash") }
                }
                .labelStyle(WebProfileActionLabelStyle())
                .buttonStyle(AletheButtonStyle(.danger))
                .disabled(!backupReady || !matches || busy != nil)
                .accessibilityIdentifier("settings.profiles.deleteConfirm")
            }
        }
        .padding(metrics.size(14))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
            .strokeBorder(theme[.statusOffline].opacity(0.5), lineWidth: metrics.size(1)))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
    }

    private func icon(_ symbol: String) -> some View { Image(systemName: symbol).font(metrics.font(size: 14)) }

    private struct CardChrome: ViewModifier {
        let fill: ThemeToken
        var accent = false
        @Environment(\.metrics) private var metrics
        @Environment(\.theme) private var theme
        func body(content: Content) -> some View {
            content
                .background(theme[fill], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
                .background(theme[.accentFaint].opacity(accent ? 0.35 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
                    .strokeBorder(accent ? theme[.accent].opacity(0.65) : theme[.border], lineWidth: metrics.size(1)))
        }
    }

    private func avatar(_ entry: ProfileEntry, name: String) -> some View {
        let key = entry.id.rawValue
        let stored = ((try? JSONDecoder().decode([String: String].self, from: Data(avatars.utf8))) ?? [:])[key]
            .flatMap { Data(base64Encoded: $0) }.flatMap { NSImage(data: $0) }
        let source = entry.id == environment.profileID ? (environment.preferences?.document.profileImageUrl ?? "") : ""
        return SidebarCoverImage(source: source, side: 38, cornerRadius: 19) {
            if let stored { Image(nsImage: stored).resizable().aspectRatio(contentMode: .fill) }
            else { Image("DefaultProfile").resizable().aspectRatio(contentMode: .fill) }
        }
        .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityLabel(Text(verbatim: name))
    }

    private func lastUsed(_ entry: ProfileEntry) -> String {
        guard let date = entry.lastUsedAt else { return "—" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    // MARK: Actions

    private func load() async {
        busy = .load
        summaries = await environment.profileSummaries()
        busy = nil
    }

    private func perform(_ kind: Busy, _ action: @escaping @MainActor () async throws -> Void) {
        busy = kind
        error = nil
        Task {
            defer { busy = nil }
            do { try await action() }
            catch let failure as ProfileError { error = failure.localizedMessage }
            catch let failure as BackupError { error = failure.localizedMessage }
            catch {
                self.error = String(format: String(localized: "settings.profiles.error.operation"), error.localizedDescription)
            }
        }
    }

    private func create() {
        guard ProfileIndexDocument.normalizedName(newName) != nil else {
            error = ProfileError.nameRequired.localizedMessage
            return
        }
        let name = newName
        perform(.create) {
            try await environment.createProfile(named: name)
            newName = ""
        }
    }

    private func duplicate(_ entry: ProfileEntry) {
        perform(.create) { try await environment.duplicateProfile(entry.id) }
    }

    private func saveRename(_ entry: ProfileEntry) {
        guard ProfileIndexDocument.normalizedName(editingName) != nil else {
            error = ProfileError.nameRequired.localizedMessage
            return
        }
        let name = editingName
        perform(.rename) {
            try await environment.renameProfile(entry.id, to: name)
            editing = nil
        }
    }

    private func switchProfile(_ entry: ProfileEntry) {
        notice = String(localized: "profiles.web.switchBusy")
        perform(.switching) {
            defer { notice = nil }
            try await environment.switchProfile(to: entry.id)
        }
    }

    private func startDelete(_ entry: ProfileEntry) {
        pendingDelete = entry
        confirmName = ""
        backupReady = false
        error = nil
        notice = nil
    }

    private func exportBackup(_ entry: ProfileEntry) {
        let name = environment.profileName(entry)
        let panel = NSSavePanel()
        panel.title = String(localized: "profiles.web.backupDialogTitle")
        panel.allowedContentTypes = [.zip]
        let slug = name.replacingOccurrences(of: "[^A-Za-z0-9_-]+", with: "-", options: .regularExpression).lowercased()
        panel.nameFieldStringValue = "alethe-\(slug)-backup.zip"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        perform(.backup) {
            try await environment.exportProfileBackup(entry.id, to: url)
            backupReady = true
            notice = String(localized: "profiles.web.backupReady")
        }
    }

    private func remove(_ entry: ProfileEntry) {
        guard backupReady, confirmName.trimmingCharacters(in: .whitespacesAndNewlines) == environment.profileName(entry) else { return }
        perform(.delete) {
            try await environment.deleteProfile(entry.id)
            pendingDelete = nil
            notice = nil
        }
    }
}

/// Icon and title side by side at the web button's 6-point gap.
private struct WebProfileActionLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(6)) { configuration.icon; configuration.title }
    }
}
