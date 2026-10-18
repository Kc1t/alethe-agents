import AlethePluginKit
import Foundation

/// Built-in Todos plugin (upstream `plugins/todos`): a right-sidebar tab rendered by the app's
/// `todos` view and a "New Todo" command. Storage holds the list and settings;
/// the filesystem capabilities cover the external JSONC template.
@MainActor
public final class TodosPlugin: AlethePlugin {
    public static let manifest = PluginManifest(
        id: "com.alethe.todos",
        version: "1.0.0",
        name: "Todo List",
        capabilities: [.storage, .filesystemRead, .filesystemWrite]
    )

    public static let viewID = "todos"
    public static let sidebarTabID = "todos"
    public static let newTodoCommandID = "todos.new"

    /// The store of the active instance, for the app's views; nil while the plugin is disabled.
    public static var activeStore: TodoStore? { activePlugin?.store }
    /// The active instance (template file access goes through it); nil while disabled.
    public private(set) static var activePlugin: TodosPlugin?
    /// Set by the app to reveal the tab and focus the new-todo field.
    public static var onNewTodo: (@MainActor () -> Void)?

    public private(set) var store: TodoStore?
    private var context: PluginContext?

    public init() {}

    public func activate(context: PluginContext) throws {
        let store = TodoStore(storage: try context.storage())
        try context.addSidebarTab(SidebarTabContribution(
            id: Self.sidebarTabID,
            title: "Todo",
            symbol: "checklist",
            side: .right,
            viewID: Self.viewID
        ))
        try context.addCommand(CommandContribution(
            id: Self.newTodoCommandID,
            title: "New Todo"
        ) {
            TodosPlugin.onNewTodo?()
        })
        self.store = store
        self.context = context
        Self.activePlugin = self
        Task { await store.load() }
    }

    public func deactivate() {
        if Self.activePlugin === self { Self.activePlugin = nil }
        store = nil
        context = nil
    }

    // MARK: Template (filesystem capability)

    public enum TemplateAccessError: Error, Equatable {
        case inactive
    }

    /// File access through the context's declared `filesystemRead`/`filesystemWrite` capabilities.
    public var fileAccess: TodoFileAccess? {
        guard let context else { return nil }
        return TodoFileAccess(
            read: { url in try await context.readFile(at: url) },
            write: { data, url in try await context.writeFile(data, to: url) }
        )
    }

    /// Creates the template in the settings' folder when missing; returns its URL.
    public func ensureTemplate() async throws -> URL {
        guard let store, let fileAccess else { throw TemplateAccessError.inactive }
        return try await store.ensureTemplate(using: fileAccess)
    }

    /// Replaces the list with the template file's todos (creating the template first when missing).
    public func importTemplate() async throws {
        guard let store, let fileAccess else { throw TemplateAccessError.inactive }
        let url = try await store.ensureTemplate(using: fileAccess)
        try await store.importTemplate(from: url, using: fileAccess)
    }

    /// Writes the list to the template file.
    public func exportTemplate() async throws -> URL {
        guard let store, let fileAccess else { throw TemplateAccessError.inactive }
        guard let url = store.templateURL else { throw TodoTemplate.TemplateError.emptyDirectory }
        try await store.exportTemplate(to: url, using: fileAccess)
        return url
    }
}
