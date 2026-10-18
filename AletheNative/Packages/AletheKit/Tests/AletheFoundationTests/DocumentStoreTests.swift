import Foundation
import Testing
@testable import AletheFoundation

/// Version 3 of a test document; v1 had `title`, v2 renamed it to `name`, v3 added `count`.
private struct Sample: VersionedDocument, Equatable {
    static let currentVersion = 3
    static let migrations: [Int: @Sendable (inout JSONObject) throws -> Void] = [
        1: { object in object["name"] = object.removeValue(forKey: "title") },
        2: { object in object["count"] = .number(0) },
    ]
    static let initial = Sample(schemaVersion: 3, name: "initial", count: 0)
    var schemaVersion: Int
    var name: String
    var count: Int
}

private func temporaryURL() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "alethe-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        .appending(path: "doc.json")
}

@Suite struct DocumentStoreTests {
    @Test func missingFileStartsFresh() async throws {
        let store = DocumentStore<Sample>(url: temporaryURL())
        let (document, outcome) = try await store.load()
        #expect(document == Sample.initial)
        #expect(outcome == .fresh)
    }

    @Test func savesAtomicallyAndLoadsBack() async throws {
        let url = temporaryURL()
        let store = DocumentStore<Sample>(url: url)
        try await store.save(Sample(schemaVersion: 3, name: "hello", count: 2), revision: 1)
        let (document, outcome) = try await DocumentStore<Sample>(url: url).load()
        #expect(document.name == "hello" && document.count == 2)
        #expect(outcome == .loaded)
    }

    @Test func migratesOldVersionsAndKeepsABackup() async throws {
        let url = temporaryURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"schemaVersion":1,"title":"old"}"#.utf8).write(to: url)
        let (document, outcome) = try await DocumentStore<Sample>(url: url).load()
        #expect(document == Sample(schemaVersion: 3, name: "old", count: 0))
        guard case .migrated(let from, let backup) = outcome else { Issue.record("not migrated"); return }
        #expect(from == 1)
        #expect(try String(contentsOf: backup, encoding: .utf8).contains("\"title\":\"old\""))
        // The migrated document was written back at the current version.
        let (_, second) = try await DocumentStore<Sample>(url: url).load()
        #expect(second == .loaded)
    }

    @Test func corruptedFileIsQuarantinedNotLost() async throws {
        let url = temporaryURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: url)
        let (document, outcome) = try await DocumentStore<Sample>(url: url).load()
        #expect(document == Sample.initial)
        guard case .recoveredFromCorruption(let moved) = outcome else { Issue.record("not recovered"); return }
        #expect(try String(contentsOf: moved, encoding: .utf8) == "{ not json")
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func newerFileIsNeverOverwritten() async throws {
        let url = temporaryURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let future = #"{"schemaVersion":99,"name":"future"}"#
        try Data(future.utf8).write(to: url)
        let store = DocumentStore<Sample>(url: url)
        await #expect(throws: DocumentStoreError.newerVersion(found: 99, supported: 3)) { try await store.load() }
        try await store.save(Sample.initial, revision: 1)
        await store.scheduleSave(Sample.initial, revision: 2)
        await store.flush()
        #expect(try String(contentsOf: url, encoding: .utf8) == future)
    }

    @Test func debouncedSavesWriteOnlyTheLatestSnapshot() async throws {
        let url = temporaryURL()
        let store = DocumentStore<Sample>(url: url, debounce: .milliseconds(50))
        for count in 1...20 {
            await store.scheduleSave(Sample(schemaVersion: 3, name: "n", count: count), revision: UInt64(count))
        }
        try await Task.sleep(for: .milliseconds(250))
        let (document, _) = try await DocumentStore<Sample>(url: url).load()
        #expect(document.count == 20)
    }

    @Test func lateOlderRevisionNeverReplacesANewerOne() async throws {
        let url = temporaryURL()
        let store = DocumentStore<Sample>(url: url, debounce: .milliseconds(20))
        await store.scheduleSave(Sample(schemaVersion: 3, name: "new", count: 2), revision: 2)
        await store.scheduleSave(Sample(schemaVersion: 3, name: "old", count: 1), revision: 1)
        await store.flush()
        try await store.save(Sample(schemaVersion: 3, name: "older", count: 0), revision: 1)
        let (document, _) = try await DocumentStore<Sample>(url: url).load()
        #expect(document.name == "new")
    }

    @Test func failedDebouncedWriteCanBeRetriedByFlushing() async throws {
        let parent = FileManager.default.temporaryDirectory.appending(
            path: "alethe-blocked-\(UUID().uuidString)", directoryHint: .notDirectory)
        let url = parent.appending(path: "doc.json")
        try Data("blocks directory creation".utf8).write(to: parent)
        defer { try? FileManager.default.removeItem(at: parent) }
        let store = DocumentStore<Sample>(url: url, debounce: .seconds(60))
        await store.scheduleSave(Sample(schemaVersion: 3, name: "latest", count: 7), revision: 7)
        await store.flush()
        try FileManager.default.removeItem(at: parent)
        await store.flush()
        let (document, _) = try await DocumentStore<Sample>(url: url).load()
        #expect(document.name == "latest")
    }

    @Test func failedImmediateWriteDoesNotConsumeItsRevision() async throws {
        let parent = FileManager.default.temporaryDirectory.appending(
            path: "alethe-blocked-\(UUID().uuidString)", directoryHint: .notDirectory)
        let url = parent.appending(path: "doc.json")
        try Data("blocks directory creation".utf8).write(to: parent)
        defer { try? FileManager.default.removeItem(at: parent) }
        let store = DocumentStore<Sample>(url: url)
        do {
            try await store.save(Sample.initial, revision: 1)
            Issue.record("Expected the blocked write to fail")
        } catch { }
        try FileManager.default.removeItem(at: parent)
        try await store.save(Sample(schemaVersion: 3, name: "retry", count: 1), revision: 1)
        let (document, _) = try await DocumentStore<Sample>(url: url).load()
        #expect(document.name == "retry")
    }

}
