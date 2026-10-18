import AletheModel
import Foundation

/// Profile management (P5-9, upstream `profiles.rs`): the index changes at once; switching saves
/// everything and relaunches into the other profile.
extension AppEnvironment {
    static var defaultProfileName: String { String(localized: "profiles.defaultName") }

    func profileName(_ entry: ProfileEntry) -> String {
        profiles?.document.displayName(of: entry, defaultName: Self.defaultProfileName) ?? Self.defaultProfileName
    }

    /// The running profile's name (the toolbar menu's title).
    var activeProfileName: String {
        guard let profileID, let entry = profiles?.document.profile(profileID) else { return Self.defaultProfileName }
        return profileName(entry)
    }

    /// Web account display name when set, otherwise the profile name.
    var webDisplayName: String {
        if let name = preferences?.document.displayName, !name.isEmpty { return name }
        return activeProfileName
    }

    /// Adds a profile with an empty folder.
    @discardableResult
    func createProfile(named name: String) async throws -> ProfileID {
        let id = try changeProfiles { try $0.createProfile(named: name, defaultName: Self.defaultProfileName) }
        if let locations {
            try? FileManager.default.createDirectory(at: locations.profileDirectory(id), withIntermediateDirectories: true)
        }
        await profiles?.flush()
        return id
    }

    func renameProfile(_ id: ProfileID, to name: String) async throws {
        try changeProfiles { try $0.renameProfile(id, to: name, defaultName: Self.defaultProfileName) }
        await profiles?.flush()
    }

    /// A new profile holding a copy of `id`'s projects, settings and scrollback. The running profile
    /// is saved first so the copy is current.
    @discardableResult
    func duplicateProfile(_ id: ProfileID) async throws -> ProfileID {
        guard let locations, let index = profiles?.document else { throw ProfileError.notFound }
        let name = index.duplicateName(for: id, format: String(localized: "profiles.copyName"),
                                       defaultName: Self.defaultProfileName)
        if id == profileID { await saveDocuments() }
        let copy = try changeProfiles { try $0.createProfile(named: name, defaultName: Self.defaultProfileName) }
        let source = locations.profileDirectory(id), destination = locations.profileDirectory(copy)
        do {
            try await Task.detached { try ProfileFiles.copyProfileFolder(from: source, to: destination) }.value
        } catch {
            try? changeProfiles { try $0.removeProfile(copy) }
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        await profiles?.flush()
        return copy
    }

    /// Removes a profile other than the running one; its folder goes to the Trash.
    func deleteProfile(_ id: ProfileID) async throws {
        guard let locations else { throw ProfileError.notFound }
        guard id != profileID else { throw ProfileError.activeProfile }
        var next = profiles?.document ?? .initial
        try next.removeProfile(id)
        let folder = locations.profileDirectory(id)
        try await Task.detached { try ProfileFiles.trashProfileFolder(folder) }.value
        profiles?.update { $0 = next }
        await profiles?.flush()
    }

    /// Makes `id` active, saves and relaunches into it.
    func switchProfile(to id: ProfileID) async throws {
        guard id != profileID else { return }
        try changeProfiles { try $0.activate(id) }
        await profiles?.flush()
        relaunch()
    }

    /// Quits (saving everything on the way out) and reopens the app, without the quit question.
    func relaunch() {
        relaunching = true
        AppRelaunch.relaunch()
    }

    /// Summaries read from disk off the main thread; the running profile's counts come from memory,
    /// its file may be behind.
    func profileSummaries() async -> [ProfileID: ProfileSummary] {
        guard let locations, let ids = profiles?.document.profiles.map(\.id) else { return [:] }
        var summaries = await Task.detached {
            Dictionary(uniqueKeysWithValues: ids.map { ($0, ProfileFiles.summary(of: $0, in: locations)) })
        }.value
        if let profileID, let document = workspace?.document {
            summaries[profileID]?.projects = document.projects.count
            summaries[profileID]?.terminals = document.projects.flatMap(\.panes).reduce(0) { $0 + $1.tabs.count }
        }
        return summaries
    }

    /// Writes the running profile's documents now (before its folder is copied or archived).
    func saveDocuments() async {
        await workspace?.flush()
        await preferences?.flush()
        await promptHistory?.flush()
        await pullRequestReviews?.flush()
        await profiles?.flush()
    }

    @discardableResult
    private func changeProfiles<T>(_ body: (inout ProfileIndexDocument) throws -> T) throws -> T {
        guard let profiles else { throw ProfileError.notFound }
        var next = profiles.document
        let result = try body(&next)
        profiles.update { $0 = next }
        return result
    }
}

extension ProfileError {
    var localizedMessage: String {
        switch self {
        case .nameRequired: String(localized: "profiles.error.nameRequired")
        case .nameExists: String(localized: "profiles.error.nameExists")
        case .notFound: String(localized: "profiles.error.notFound")
        case .activeProfile: String(localized: "profiles.error.activeProfile")
        case .lastProfile: String(localized: "profiles.error.lastProfile")
        }
    }
}

extension AppEnvironment {
    /// Archives any profile into `archive` (the running one is saved first). The web's per-profile
    /// backup that precedes a delete.
    func exportProfileBackup(_ id: ProfileID, to archive: URL) async throws {
        guard let locations, let entry = profiles?.document.profile(id) else { throw ProfileError.notFound }
        if id == profileID { await saveDocuments() }
        let folder = locations.profileDirectory(id), name = profileName(entry)
        try await Task.detached { try ProfileBackup.export(folder, to: archive, profileName: name) }.value
    }
}
