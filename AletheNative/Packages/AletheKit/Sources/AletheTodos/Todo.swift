import Foundation

/// One checklist item. `projectID == nil` puts it in the global list; otherwise it belongs to that
/// project's list. Upstream `TodoItem` (`src/lib/types.ts`).
public struct Todo: Hashable, Sendable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var done: Bool
    public var tags: [String]
    /// Set when the todo was created from a GitHub pull request.
    public var prURL: URL?
    public var projectID: String?
    /// Position in the store's list; rewritten after every change.
    public var order: Int
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString,
        title: String,
        done: Bool = false,
        tags: [String] = [],
        prURL: URL? = nil,
        projectID: String? = nil,
        order: Int = 0,
        createdAt: Date = Date(),
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.done = done
        self.tags = tags
        self.prURL = prURL
        self.projectID = projectID
        self.order = order
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

/// Which list a todo lives in.
public enum TodoScope: Hashable, Sendable {
    case global
    case project(String)

    public var projectID: String? {
        if case .project(let id) = self { return id }
        return nil
    }

    public func contains(_ todo: Todo) -> Bool {
        todo.projectID == projectID
    }
}

/// Upstream `src/lib/todos.ts` normalization rules.
public enum TodoRules {
    public static let titleMaxLength = 200
    public static let tagMaxLength = 24
    public static let maxTags = 6

    public static func normalizeTitle(_ value: String) -> String {
        String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(titleMaxLength))
    }

    /// Lowercased, `#` stripped, letters/digits/`_`/`-` only, deduplicated, at most six.
    public static func normalizeTags(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var tags: [String] = []
        let separators = CharacterSet(charactersIn: ",#").union(.whitespacesAndNewlines)
        for raw in values.flatMap({ $0.components(separatedBy: separators) }) {
            let scalars = raw.unicodeScalars.filter {
                CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || $0 == "_" || $0 == "-"
            }
            let tag = String(String.UnicodeScalarView(scalars)).prefix(tagMaxLength).lowercased()
            guard !tag.isEmpty, seen.insert(tag).inserted else { continue }
            tags.append(tag)
        }
        return Array(tags.prefix(maxTags))
    }

    /// Upstream defaults shown on first run and after "reset".
    public static let defaultTitles: [(title: String, tags: [String])] = [
        ("Review active workspace", ["review"]),
        ("Open project README", ["docs"]),
        ("Plan next implementation step", ["plan"]),
    ]
}

/// The template folder used by the Todos plugin. Unknown legacy settings are ignored on decode.
public struct TodoSettings: Hashable, Sendable, Codable {
    public var storagePath: String

    public init(storagePath: String = "") {
        self.storagePath = storagePath
    }
}
