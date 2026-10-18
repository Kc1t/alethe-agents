import AletheModel
import AppKit
import UniformTypeIdentifiers

@MainActor
enum WebProjectTransfer {
    static func export(_ project: Project, group: GroupID?) {
        let panel = NSSavePanel()
        panel.title = String(localized: "projectSettings.export.title")
        let name = project.name.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "-", options: .regularExpression)
        panel.nameFieldStringValue = "\(name).alethe-project.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try WebProjectFile.data(project, group: group).write(to: url, options: .atomic) }
        catch { inform("projectSettings.export.failed", message: error.localizedDescription) }
    }

    static func importProject(nextTo project: ProjectID, workspace: WorkspaceModel, undoManager: UndoManager?) {
        let panel = NSOpenPanel()
        panel.title = String(localized: "projectSettings.import.title")
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            var imported = try WebProjectFile.importing(Data(contentsOf: url), avoiding: workspace.document)
            imported.id = .make()
            imported.createdAt = Date()
            let snapshot = imported
            let location = workspace.document.location(of: project) ?? .ungrouped
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.importProjectSettings")) { document in
                document.projects.append(snapshot)
                switch location {
                case .ungrouped: document.ungroupedProjectIDs.append(snapshot.id)
                case .group(let id): document.updateGroup(id) { $0.projectIDs.append(snapshot.id) }
                }
            }
        } catch { inform("projectSettings.import.failed", message: String(localized: "projectSettings.import.invalid")) }
    }

    private static func inform(_ key: String.LocalizationValue, message: String) {
        let alert = NSAlert()
        alert.messageText = String(localized: key)
        alert.informativeText = message
        alert.runModal()
    }
}
