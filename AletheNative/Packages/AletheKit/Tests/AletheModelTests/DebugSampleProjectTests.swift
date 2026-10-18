#if DEBUG
import Foundation
import Testing
@testable import AletheModel

@Suite struct DebugSampleProjectTests {
    @Test func webPreviewOpensItsOwnTabAndReusesIt() {
        let folder = URL(filePath: "/sample/markdown")
        var document = WorkspaceDocument()
        let other = document.addProject(name: "Other", folder: "/other")
        document.openWebProject(other)
        let id = DebugSampleProject.open(in: &document, folder: folder, name: "Sample", webInterface: true)
        let pane = document.workspace.focusedPaneID
        #expect(document.workspace.openProjectIDs == [id])
        #expect(document.activeWorkspaceTab?.projectID == id)
        #expect(pane != nil)
        document.openWebProject(other)
        DebugSampleProject.open(in: &document, folder: folder, name: "Sample", webInterface: true)
        #expect(document.workspace.openProjectIDs == [id])
        #expect(document.workspace.focusedPaneID == pane)
        #expect(document.workspace.tabs.filter { $0.projectID == id }.count == 1)
        #expect(document.project(id)?.panes.count == 1)
    }

    @Test func repeatedLoadsReuseProjectAndPaneAndKeepEditedFiles() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let documents = ["README.md": "# Preview", "guides/Guide.md": "## Guide"]
        try DebugSampleProject.writeFiles(in: folder, documents: documents)
        let readme = folder.appending(path: "README.md")
        try "# Edited".write(to: readme, atomically: true, encoding: .utf8)
        try DebugSampleProject.writeFiles(in: folder, documents: documents)
        #expect(try String(contentsOf: readme, encoding: .utf8) == "# Edited")
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "guides/Guide.md").path))
        var document = WorkspaceDocument()
        let userProject = document.addProject(name: "User project", folder: "/user/project")
        let id = DebugSampleProject.open(in: &document, folder: folder, name: "Sample workspace")
        let snapshot = document.projects
        let again = DebugSampleProject.open(in: &document, folder: folder, name: "Sample workspace")
        #expect(again == id)
        #expect(document.projects == snapshot)
        #expect(document.project(userProject)?.name == "User project")
        #expect(document.project(id)?.panes.count == 1)
        #expect(document.workspace.selectedProjectID == id)
        var reopened = try JSONDecoder().decode(WorkspaceDocument.self, from: JSONEncoder().encode(document))
        #expect(DebugSampleProject.open(in: &reopened, folder: folder, name: "Sample workspace") == id)
        #expect(reopened.projects == snapshot)
    }
}
#endif
