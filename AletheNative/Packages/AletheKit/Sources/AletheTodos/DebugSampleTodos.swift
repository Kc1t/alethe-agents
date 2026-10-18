#if DEBUG
import Foundation

/// Preview fixtures stay out of Release and never replace the user's todos.
public enum DebugSampleTodos {
    @MainActor
    public static func load(into store: TodoStore, titles: [String], projectID: String) {
        let existing = Set(store.todos.map(\.id))
        let added = titles.prefix(25).enumerated().compactMap { index, title -> Todo? in
            let id = "alethe-sample-todo-\(index)"
            guard !existing.contains(id) else { return nil }
            let tags = [["preview", "design"], ["preview", "docs"], ["preview", "review", "high"],
                        ["preview", "testing"], ["preview", "planning", "low"]][index % 5]
            return Todo(id: id, title: TodoRules.normalizeTitle(title), done: index % 4 == 3,
                        tags: tags, projectID: index % 3 == 0 ? projectID : nil,
                        createdAt: Date().addingTimeInterval(-Double(index) * 3600))
        }
        guard !added.isEmpty else { return }
        let combined = store.todos + added
        store.replaceAll(combined.filter { !$0.done } + combined.filter(\.done))
    }
}
#endif
