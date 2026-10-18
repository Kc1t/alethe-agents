import AletheModel
import Foundation

/// Local sidebar state until the workspace schema supports hide/archive flags.
/// Profile and project identifiers prevent state leaking between local accounts.
enum SidebarProjectVisibility {
    static let archivedGroupsKey = "sidebar.web.archivedGroups"
    static let hiddenKey = "sidebar.web.hiddenProjects"
    static let archivedKey = "sidebar.web.archivedProjects"
    static let revealKey = "sidebar.web.revealHiddenProjects"

    static func key(_ project: ProjectID, profile: ProfileID?) -> String {
        "\(profile?.rawValue ?? "default"):\(project.rawValue)"
    }

    static func contains(_ value: String, project: ProjectID, profile: ProfileID?) -> Bool {
        decode(value).contains(key(project, profile: profile))
    }

    static func setting(_ value: String, project: ProjectID, profile: ProfileID?, enabled: Bool) -> String {
        var ids = decode(value)
        let id = key(project, profile: profile)
        if enabled { ids.insert(id) } else { ids.remove(id) }
        guard let data = try? JSONEncoder().encode(ids.sorted()), let text = String(data: data, encoding: .utf8) else {
            return value
        }
        return text
    }

    static func visible(_ project: ProjectID, profile: ProfileID?, hidden: String, archived: String, reveal: Bool) -> Bool {
        !contains(archived, project: project, profile: profile)
            && (reveal || !contains(hidden, project: project, profile: profile))
    }

    static func containsGroup(_ value: String, group: GroupID, profile: ProfileID?) -> Bool {
        decode(value).contains("\(profile?.rawValue ?? "default"):\(group.rawValue)")
    }

    static func settingGroup(_ value: String, group: GroupID, profile: ProfileID?, enabled: Bool) -> String {
        var ids = decode(value)
        let key = "\(profile?.rawValue ?? "default"):\(group.rawValue)"
        if enabled { ids.insert(key) } else { ids.remove(key) }
        guard let data = try? JSONEncoder().encode(ids.sorted()), let text = String(data: data, encoding: .utf8) else { return value }
        return text
    }

    private static func decode(_ value: String) -> Set<String> {
        Set((try? JSONDecoder().decode([String].self, from: Data(value.utf8))) ?? [])
    }
}
