import Foundation
import Testing
@testable import AlethePluginKit

@Suite struct PluginWebRegistryTests {
    private let raw = Data(#"{"id":"test.notes","name":"Notes","version":"1.0","kind":"ui","apiVersion":1,"description":"Notes panel","capabilities":["ui.sidebarTab"],"spec":{"unknown":{"retained":true}},"entry":"index.js"}"#.utf8)

    @Test func registrationPreservesUnknownFieldsAndDoesNotEnableExecution() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let registry = PluginWebRegistry(root: directory)
        try await registry.install(manifest: raw)
        let records = try await registry.installed()
        #expect(records.count == 1)
        #expect(records.first?.capabilities == ["ui.sidebarTab"])
        #expect(try Data(contentsOf: directory.appending(path: "test.notes/manifest.json")) == raw)
        #expect(!FileManager.default.fileExists(atPath: directory.appending(path: "test.notes/index.js").path))
        let encoded = try JSONEncoder().encode(#require(records.first))
        let decoded = try JSONDecoder().decode(WebPluginManifest.self, from: encoded)
        #expect(decoded.id == "test.notes")
        #expect(decoded.version == "1.0")
        try await registry.uninstall("test.notes")
        #expect(try await registry.installed().isEmpty)
    }

    @Test func invalidIDsAndUnsupportedAPIsAreRejected() throws {
        let string = String(decoding: raw, as: UTF8.self)
        for id in ["../escape", "/absolute", "bad/id", "", "UPPERCASE"] {
            let changed = Data(string.replacingOccurrences(of: "test.notes", with: id).utf8)
            #expect(throws: (any Error).self) { try WebPluginManifest.validate(changed) }
        }
        let future = Data(string.replacingOccurrences(of: "\"apiVersion\":1", with: "\"apiVersion\":2").utf8)
        #expect(throws: (any Error).self) { try WebPluginManifest.validate(future) }
    }

    @Test func builtinsCannotBeOverwrittenOrUninstalled() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let registry = PluginWebRegistry(root: directory, protectedIDs: ["test.notes"])
        await #expect(throws: (any Error).self) { try await registry.install(manifest: raw) }
        await #expect(throws: (any Error).self) { try await registry.uninstall("test.notes") }
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    @Test func minimalCatalogEntryUsesWebDefaults() throws {
        let data = Data(#"{"id":"notes","name":"Notes","downloadUrl":"https://example.com/notes"}"#.utf8)
        let entry = try JSONDecoder().decode(WebCatalogEntry.self, from: data)
        #expect(entry.minApiVersion == 1)
        #expect(entry.capabilities.isEmpty)
        #expect(entry.version.isEmpty)
        #expect(entry.package == nil)
    }

    @Test func folderImportAndRescanUseManifestOnDisk() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appending(path: "source", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try raw.write(to: source.appending(path: "manifest.json"))
        let registry = PluginWebRegistry(root: directory.appending(path: "registry"))
        try await registry.importFile(source)
        #expect(try await registry.installed().map(\.id) == ["test.notes"])
    }
}

extension PluginWebRegistryTests {
    @Test func zipImportReadsManifestWithoutExtractingAssets() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try raw.write(to: directory.appending(path: "manifest.json"))
        try Data("throw new Error('must never execute');".utf8).write(to: directory.appending(path: "index.js"))
        let archive = directory.appending(path: "plugin.zip")
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/zip")
        process.currentDirectoryURL = directory
        process.arguments = ["-q", archive.path, "manifest.json", "index.js"]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        let root = directory.appending(path: "registry")
        let registry = PluginWebRegistry(root: root)
        try await registry.importFile(archive)
        #expect(try await registry.installed().map(\.id) == ["test.notes"])
        #expect(!FileManager.default.fileExists(atPath: root.appending(path: "test.notes/index.js").path))
    }

    @Test func freshCatalogCacheWorksWithoutNetwork() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let snapshot = WebCatalogSnapshot(plugins: [], fetchedAt: Date(), stale: false)
        try JSONEncoder().encode(snapshot).write(to: directory.appending(path: "catalog-cache.json"))
        let registry = PluginWebRegistry(root: directory)
        let result = try await registry.catalog(refresh: false)
        #expect(!result.stale)
        #expect(result.fetchedAt == snapshot.fetchedAt)
    }
}
