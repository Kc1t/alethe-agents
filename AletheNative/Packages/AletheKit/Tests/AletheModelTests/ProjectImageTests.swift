import Foundation
import Testing
@testable import AletheModel

@Suite struct ProjectImageTests {
    @Test func projectAndGroupRoundTripWithWebFieldName() throws {
        for source in ["https://example.com/icon.svg", "data:image/png;base64,aGVsbG8="] {
            var project = Project(name: "API", folder: "/api")
            project.iconUrl = source
            var group = ProjectGroup(name: "Work")
            group.iconUrl = source
            let projectData = try JSONEncoder().encode(project)
            let groupData = try JSONEncoder().encode(group)
            #expect(try JSONDecoder().decode(Project.self, from: projectData) == project)
            #expect(try JSONDecoder().decode(ProjectGroup.self, from: groupData) == group)
            for data in [projectData, groupData] {
                let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                #expect(json["iconUrl"] as? String == source)
            }
        }
    }

    @Test func uploadedSVGSurvivesEditingAndJSONRoundTripWithoutRecompression() throws {
        let bytes = Data(#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>"#.utf8)
        let source = try ProjectImageInput.dataURL(bytes, mimeType: "image/svg+xml")
        var project = Project(name: "API", folder: "/api")
        project.iconUrl = ProjectImageInput.normalized(" \n" + source + "\n ")
        let decoded = try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project))
        let persisted = try #require(decoded.iconUrl)
        let payload = try #require(persisted.split(separator: ",", maxSplits: 1).last)
        #expect(Data(base64Encoded: String(payload)) == bytes)

        var group = ProjectGroup(name: "Work")
        group.iconUrl = decoded.iconUrl
        group.iconUrl = ProjectImageInput.normalized("")
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(group)) as? [String: Any])
        #expect(object["iconUrl"] == nil)
    }

    @Test func olderDocumentsNeedNoMigration() throws {
        let project = Project(name: "API", folder: "/api")
        let group = ProjectGroup(name: "Work")
        #expect(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)).iconUrl == nil)
        #expect(try JSONDecoder().decode(ProjectGroup.self, from: JSONEncoder().encode(group)).iconUrl == nil)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(project)) as? [String: Any])
        #expect(json["iconUrl"] == nil)
    }

    @Test func explicitWebNullImagesDecodeAsDefaultIcons() throws {
        let values: [Data] = [
            try JSONEncoder().encode(Project(name: "API", folder: "/api")),
            try JSONEncoder().encode(ProjectGroup(name: "Work"))
        ]
        for (index, data) in values.enumerated() {
            var json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            json["iconUrl"] = NSNull()
            let encoded = try JSONSerialization.data(withJSONObject: json)
            if index == 0 {
                #expect(try JSONDecoder().decode(Project.self, from: encoded).iconUrl == nil)
            } else {
                #expect(try JSONDecoder().decode(ProjectGroup.self, from: encoded).iconUrl == nil)
            }
        }
    }

    @Test func importedWebImagesSurviveNativeSave() throws {
        let fixture = try #require(Bundle.module.url(forResource: "projects-v9", withExtension: "json",
                                                     subdirectory: "Fixtures/Tauri"))
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        var projects = try #require(json["projects"] as? [[String: Any]])
        var groups = try #require(json["groups"] as? [[String: Any]])
        projects[0]["iconUrl"] = "data:image/png;base64,AAH+/w=="
        groups[0]["iconUrl"] = "https://example.com/work.svg"
        json["projects"] = projects
        json["groups"] = groups
        let file = try TauriImport.File(data: JSONSerialization.data(withJSONObject: json))
        var workspace = WorkspaceDocument()
        var preferences = PreferencesDocument()
        _ = TauriImport.apply(file, to: &workspace, preferences: &preferences,
                              context: .init(agents: ["shell"], themes: ["elite-indigo"]))
        let saved = try JSONDecoder().decode(WorkspaceDocument.self, from: JSONEncoder().encode(workspace))
        #expect(saved.projects.contains { $0.iconUrl == "data:image/png;base64,AAH+/w==" })
        #expect(saved.groups.contains { $0.iconUrl == "https://example.com/work.svg" })
    }

    @Test func preservesOriginalBytesForEveryWebImageType() throws {
        let bytes = Data([0, 1, 254, 255])
        for mime in ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"] {
            #expect(try ProjectImageInput.dataURL(bytes, mimeType: mime) == "data:\(mime);base64,AAH+/w==")
        }
    }

    @Test func rejectsNonImagesAndOversizedFiles() throws {
        #expect(throws: ProjectImageInput.ValidationError.mustBeImage) {
            try ProjectImageInput.dataURL(Data(), mimeType: "text/plain")
        }
        #expect(throws: ProjectImageInput.ValidationError.tooLarge) {
            try ProjectImageInput.dataURL(Data(count: ProjectImageInput.maximumBytes + 1), mimeType: "image/png")
        }
        let boundary = try ProjectImageInput.dataURL(Data(count: ProjectImageInput.maximumBytes), mimeType: "image/png")
        #expect(boundary.hasPrefix("data:image/png;base64,"))
    }

    @Test func trimsURLsAndOmitsRemovedImages() {
        #expect(ProjectImageInput.normalized(" \n ") == nil)
        #expect(ProjectImageInput.normalized(" https://example.com/icon.png\n") == "https://example.com/icon.png")
    }

    @Test func localFilesPreserveBytesAndEnforceTheWebLimit() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "alethe-cover-\(UUID().uuidString).svg")
        defer { try? FileManager.default.removeItem(at: url) }
        let bytes = Data("<svg/>".utf8)
        try bytes.write(to: url)
        #expect(try ProjectImageInput.fileDataURL(url, mimeType: "image/svg+xml") ==
                ProjectImageInput.dataURL(bytes, mimeType: "image/svg+xml"))
        try Data(count: ProjectImageInput.maximumBytes + 1).write(to: url)
        #expect(throws: ProjectImageInput.ValidationError.tooLarge) {
            try ProjectImageInput.fileDataURL(url, mimeType: "image/svg+xml")
        }
        #expect(throws: ProjectImageInput.ValidationError.mustBeImage) {
            try ProjectImageInput.fileDataURL(url, mimeType: "text/plain")
        }
    }

}
