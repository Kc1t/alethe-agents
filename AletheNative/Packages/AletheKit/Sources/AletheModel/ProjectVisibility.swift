import Foundation

extension WorkspaceDocument {
    /// Legacy entries are profile-qualified. Explicit model flags win, including a later restore.
    public mutating func migrateProjectVisibility(hidden: Set<String>, archived: Set<String>, profile: ProfileID?) {
        let prefix = (profile?.rawValue ?? "default") + ":"
        for index in projects.indices {
            let key = prefix + projects[index].id.rawValue
            if projects[index].hidden == nil, hidden.contains(key) { projects[index].hidden = true }
            if projects[index].archived == nil, archived.contains(key) { projects[index].archived = true }
        }
    }
}
