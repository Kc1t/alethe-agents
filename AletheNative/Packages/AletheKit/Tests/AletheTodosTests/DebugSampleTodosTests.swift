#if DEBUG
import Foundation
import Testing
@testable import AlethePluginKit
@testable import AletheTodos

@MainActor
@Suite struct DebugSampleTodosTests {
    @Test func repeatedLoadsPreserveUserDataAndEdits() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = PluginStorage(root: directory, pluginID: "sample-tests")
        let store = TodoStore(storage: storage)
        await store.load()
        let original = try #require(store.add(title: "User task", tags: ["personal"]))
        let titles = (1...25).map { "Sample task \($0)" }
        DebugSampleTodos.load(into: store, titles: titles, projectID: "sample-project")
        #expect(store.todos.count == 26)
        #expect(store.todos.contains { $0.done })
        #expect(store.todos.contains { $0.projectID == "sample-project" })
        #expect(store.todos.contains { $0.projectID == nil && $0.id != original.id })
        #expect(store.todo(id: original.id) == original)
        store.rename("alethe-sample-todo-0", to: "Edited preview task")
        store.toggle("alethe-sample-todo-1")
        let snapshot = store.todos
        DebugSampleTodos.load(into: store, titles: titles, projectID: "sample-project")
        #expect(store.todos == snapshot)
        try await store.flush()
        let reopened = TodoStore(storage: PluginStorage(root: directory, pluginID: "sample-tests"))
        await reopened.load()
        DebugSampleTodos.load(into: reopened, titles: titles, projectID: "sample-project")
        #expect(reopened.todos == snapshot)
    }
}
#endif
