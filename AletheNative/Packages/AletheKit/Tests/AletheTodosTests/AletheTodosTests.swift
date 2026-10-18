import Foundation
import Testing
@testable import AlethePluginKit
@testable import AletheTodos

private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "AletheTodosTests-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@MainActor
@Suite struct TodoStoreTests {
    @Test func addInsertsBeforeCompletedAndNormalizes() {
        let store = TodoStore(storage: nil)
        let a = store.add(title: "  A  ", tags: ["#Review", "review", "a b!"])!
        #expect(a.title == "A")
        #expect(a.tags == ["review", "a", "b"])
        #expect(store.add(title: "   ") == nil)
        let b = store.add(title: "B")!
        store.toggle(a.id)
        let c = store.add(title: "C")!
        #expect(store.todos.map(\.id) == [b.id, c.id, a.id])
        #expect(store.todos.map(\.order) == [0, 1, 2])
        store.toggle(a.id)
        #expect(store.todos.map(\.id) == [b.id, c.id, a.id])
        #expect(store.todo(id: a.id)?.done == false)
    }

    @Test func editTagsDeleteAndScopes() {
        let store = TodoStore(storage: nil)
        let a = store.add(title: "Global")!
        let b = store.add(title: "Mine", scope: .project("p1"))!
        store.rename(a.id, to: "Renamed")
        store.rename(a.id, to: "  ")
        store.addTag(a.id, "Bug")
        store.addTag(a.id, "bug")
        store.removeTag(a.id, "BUG")
        store.addTag(a.id, "ui")
        #expect(store.todo(id: a.id)?.title == "Renamed")
        #expect(store.todo(id: a.id)?.tags == ["ui"])
        #expect(store.todos(in: .global).map(\.id) == [a.id])
        #expect(store.todos(in: .project("p1")).map(\.id) == [b.id])
        store.move(b.id, to: .global)
        #expect(store.todos(in: .project("p1")).isEmpty)
        store.delete(a.id)
        #expect(store.todos.map(\.id) == [b.id])
    }

    @Test func reorderStaysWithinCompletionGroup() {
        let store = TodoStore(storage: nil)
        let a = store.add(title: "A")!, b = store.add(title: "B")!, c = store.add(title: "C")!
        let d = store.add(title: "D")!
        store.toggle(d.id)
        store.reorder(c.id, onto: a.id)
        #expect(store.todos.map(\.title) == ["C", "A", "B", "D"])
        store.reorder(c.id, onto: b.id)
        #expect(store.todos.map(\.title) == ["A", "C", "B", "D"])
        store.reorder(a.id, onto: d.id)
        #expect(store.todos.map(\.title) == ["A", "C", "B", "D"])
        #expect(store.todos.map(\.order) == [0, 1, 2, 3])
        _ = b
    }

    @Test func pullRequestTodosAreDeduplicated() {
        let store = TodoStore(storage: nil)
        let url = URL(string: "https://github.com/o/r/pull/7")!
        let first = store.addPullRequest(number: 7, title: "Fix", url: url)!
        let again = store.addPullRequest(number: 7, title: "Fix", url: url)!
        #expect(first.id == again.id)
        #expect(first.title == "PR #7: Fix")
        #expect(first.tags == ["pr"])
        #expect(store.todos.count == 1)
    }

    @Test func persistenceRoundTripThroughPluginStorage() async throws {
        let root = temporaryDirectory()
        let storage = PluginStorage(root: root, pluginID: TodosPlugin.manifest.id, debounce: .milliseconds(1))
        let store = TodoStore(storage: storage)
        await store.load()
        let a = store.add(title: "Persist me", tags: ["x"], scope: .project("p"))!
        store.add(title: "Second")
        store.toggle(a.id)
        store.setPullRequestURL(a.id, URL(string: "https://example.com/pr/1"))
        store.updateSettings { $0.storagePath = "/tmp/todos" }
        try await store.flush()

        let reopened = TodoStore(storage: PluginStorage(root: root, pluginID: TodosPlugin.manifest.id))
        await reopened.load()
        #expect(reopened.todos == store.todos)
        #expect(reopened.settings.storagePath == "/tmp/todos")
    }
    @Test func legacyTimerKeysDoNotAffectTodoPersistence() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = PluginStorage(root: root, pluginID: TodosPlugin.manifest.id)
        let todo = Todo(title: "Keep me", tags: ["legacy"], projectID: "project")
        try await storage.encode([todo], forKey: "todos")
        await storage.set(.object([
            "storagePath": .string("/tmp/legacy-todos"),
            "pomodoroWorkMinutes": .number(50),
            "pomodoroShortBreakMinutes": .null,
            "pomodoroLongBreakMinutes": .string("invalid legacy value"),
        ]), forKey: "settings")
        // Even a malformed legacy session must be ignored when loading the list.
        await storage.set(.string("unused legacy session"), forKey: "pomodoro")
        try await storage.flush()

        let store = TodoStore(storage: storage)
        await store.load()
        #expect(store.todos == [todo])
        #expect(store.settings.storagePath == "/tmp/legacy-todos")
        store.rename(todo.id, to: "Still editable")
        store.updateSettings { $0.storagePath = "/tmp/current-todos" }
        try await store.flush()

        let reopenedStorage = PluginStorage(root: root, pluginID: TodosPlugin.manifest.id)
        let reopened = TodoStore(storage: reopenedStorage)
        await reopened.load()
        #expect(reopened.todos.first?.title == "Still editable")
        #expect(reopened.todos.first?.tags == ["legacy"])
        #expect(reopened.todos.first?.projectID == "project")
        #expect(reopened.settings.storagePath == "/tmp/current-todos")
        let settings = try #require(try await reopenedStorage.decode([String: String].self, forKey: "settings"))
        #expect(settings == ["storagePath": "/tmp/current-todos"])
    }

}

@Suite struct TodoTemplateTests {
    @Test func parsesUpstreamTemplate() throws {
        let todos = try TodoTemplate.parse(Data(TodoTemplate.defaultContent.utf8))
        #expect(todos.map(\.id) == ["task-example-1"])
        #expect(todos.first?.title == "Example task")
        #expect(todos.first?.done == false)
    }

    @Test func parsesOptionalFieldsAndSkipsInvalidEntries() throws {
        let source = """
        { "todos": [
          { "id": "x", "title": "One", "completed": true, "tags": ["A"], "projectId": "p", "prUrl": "https://g/1", },
          { "title": "  " },
          { "id": "x", "title": "Dup id" },
        ], }
        """
        let todos = try TodoTemplate.parse(Data(source.utf8))
        #expect(todos.count == 2)
        #expect(todos[0].done && todos[0].tags == ["a"] && todos[0].projectID == "p")
        #expect(todos[0].prURL?.absoluteString == "https://g/1")
        #expect(todos[1].id != "x")
        #expect(throws: TodoTemplate.TemplateError.self) { try TodoTemplate.parse(Data("{ nope".utf8)) }
    }

    @Test func ensureCreatesOnceAndNeverOverwrites() throws {
        let directory = temporaryDirectory().appending(path: "nested/dir")
        let url = try TodoTemplate.ensure(in: directory)
        #expect(url.lastPathComponent == TodoTemplate.fileName)
        #expect(try String(contentsOf: url, encoding: .utf8) == TodoTemplate.defaultContent)
        try Data("// custom\n{\"todos\": []}".utf8).write(to: url)
        try TodoTemplate.ensure(in: directory)
        #expect(try String(contentsOf: url, encoding: .utf8).hasPrefix("// custom"))
    }
}

@MainActor
@Suite(.serialized) struct TodosPluginTests {
    @Test func activationContributesTabAndCommand() async throws {
        let host = PluginHost(plugins: [TodosPlugin.self], dataRoot: temporaryDirectory())
        await host.load()
        #expect(host.record(for: TodosPlugin.manifest.id)?.state == .active)
        let tab = try #require(host.contributions.sidebarTabs.first)
        #expect(tab.viewID == "todos")
        #expect(tab.side == .right)
        let command = try #require(host.contributions.commands.first)
        #expect(command.id == TodosPlugin.newTodoCommandID)
        #expect(TodosPlugin.activeStore != nil)

        var fired = false
        TodosPlugin.onNewTodo = { fired = true }
        command.perform()
        #expect(fired)
        TodosPlugin.onNewTodo = nil

        try await host.setEnabled(false, for: TodosPlugin.manifest.id)
        #expect(TodosPlugin.activeStore == nil)
        #expect(host.contributions.sidebarTabs.isEmpty)
    }

    @Test func templateFilesGoThroughTheFilesystemCapability() async throws {
        let files = MemoryFiles()
        let services = PluginServices(
            readFile: { url in try await files.read(url) },
            writeFile: { data, url in await files.write(data, url) }
        )
        let host = PluginHost(plugins: [TodosPlugin.self], dataRoot: temporaryDirectory(), services: services)
        await host.load()
        let plugin = try #require(host.instance(for: TodosPlugin.manifest.id) as? TodosPlugin)
        let store = try #require(plugin.store)
        await store.load()

        await #expect(throws: TodoTemplate.TemplateError.emptyDirectory) { try await plugin.ensureTemplate() }
        store.updateSettings { $0.storagePath = "/virtual/todos" }
        let url = try await plugin.ensureTemplate()
        #expect(url.path == "/virtual/todos/\(TodoTemplate.fileName)")
        #expect(await files.writes == [url.path])

        try await plugin.importTemplate()
        #expect(store.todos.map(\.title) == ["Example task"])
        #expect(await files.writes == [url.path])

        store.add(title: "Exported", tags: ["io"], scope: .project("p"))
        #expect(try await plugin.exportTemplate() == url)
        #expect(await files.writes == [url.path, url.path])
        let exported = try TodoTemplate.parse(try await files.read(url))
        #expect(exported.map(\.title) == ["Example task", "Exported"])
        #expect(exported.last?.projectID == "p")

        try await host.setEnabled(false, for: TodosPlugin.manifest.id)
        await #expect(throws: TodosPlugin.TemplateAccessError.inactive) { try await plugin.ensureTemplate() }
    }

    @Test func pluginWithoutFileServicesCannotTouchTheTemplate() async throws {
        let host = PluginHost(plugins: [TodosPlugin.self], dataRoot: temporaryDirectory())
        await host.load()
        let plugin = try #require(host.instance(for: TodosPlugin.manifest.id) as? TodosPlugin)
        plugin.store?.updateSettings { $0.storagePath = "/virtual/none" }
        await #expect(throws: PluginError.serviceUnavailable(.filesystemRead)) { try await plugin.ensureTemplate() }
        try await host.setEnabled(false, for: TodosPlugin.manifest.id)
    }
}
