#if DEBUG
import AletheModel
import AletheTodos
import AppKit
import SwiftUI

struct DebugSampleDataCommands: Commands {
    let environment: AppEnvironment

    var body: some Commands {
        CommandMenu("debug.menu") {
            Button("debug.sample.load") { Task { await environment.loadSampleData() } }
                .disabled(environment.workspace == nil || environment.todoStore?.isLoaded != true || environment.loadingSampleData)
        }
    }
}

extension AppEnvironment {
    /// Explicit opt-in only; fixtures live in the active profile's support directory.
    func loadSampleData() async {
        guard !loadingSampleData, let workspace, let locations, let profileID, let store = todoStore else { return }
        loadingSampleData = true
        defer { loadingSampleData = false }
        // Plugin activation starts its load asynchronously. Do not seed before it can overwrite us.
        while !store.isLoaded {
            do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
        }
        let folder = locations.profileDirectory(profileID).appending(path: "Samples/Markdown", directoryHint: .isDirectory)
        let documents = [
            "README.md": String(localized: "debug.sample.readme"),
            "guides/Getting-started.md": String(localized: "debug.sample.guide"),
            "Code-examples.md": String(localized: "debug.sample.code"),
            "Long-document.md": String(repeating: String(localized: "debug.sample.longSection") + "\n\n", count: 18),
        ]
        do {
            try await Task.detached { try DebugSampleProject.writeFiles(in: folder, documents: documents) }.value
            var projectID: ProjectID?
            workspace.update {
                projectID = DebugSampleProject.open(in: &$0, folder: folder, name: String(localized: "debug.sample.project"),
                                                    webInterface: metrics.isWebInterface)
            }
            guard let projectID else { return }
            let titles = [
                String(localized: "debug.sample.todo01"), String(localized: "debug.sample.todo02"),
                String(localized: "debug.sample.todo03"), String(localized: "debug.sample.todo04"),
                String(localized: "debug.sample.todo05"), String(localized: "debug.sample.todo06"),
                String(localized: "debug.sample.todo07"), String(localized: "debug.sample.todo08"),
                String(localized: "debug.sample.todo09"), String(localized: "debug.sample.todo10"),
                String(localized: "debug.sample.todo11"), String(localized: "debug.sample.todo12"),
                String(localized: "debug.sample.todo13"), String(localized: "debug.sample.todo14"),
                String(localized: "debug.sample.todo15"), String(localized: "debug.sample.todo16"),
                String(localized: "debug.sample.todo17"), String(localized: "debug.sample.todo18"),
                String(localized: "debug.sample.todo19"), String(localized: "debug.sample.todo20"),
                String(localized: "debug.sample.todo21"), String(localized: "debug.sample.todo22"),
                String(localized: "debug.sample.todo23"), String(localized: "debug.sample.todo24"),
                String(localized: "debug.sample.todo25"),
            ]
            DebugSampleTodos.load(into: store, titles: titles, projectID: projectID.rawValue)
            try await store.flush()
            await workspace.flush()
            showingHome = false
            showTodos()
        } catch {
            let alert = NSAlert()
            alert.messageText = String(localized: "debug.sample.error")
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
#endif
