import Foundation

/// A document persisted as one JSON file with a `schemaVersion` field.
public protocol VersionedDocument: Codable, Sendable, Equatable {
    /// Version this build writes.
    static var currentVersion: Int { get }
    /// `migrations[n]` turns a version-`n` object into a version-`n + 1` object.
    static var migrations: [Int: @Sendable (inout JSONObject) throws -> Void] { get }
    /// The document a first launch starts with.
    static var initial: Self { get }
    var schemaVersion: Int { get set }
}

public enum DocumentLoadOutcome: Equatable, Sendable {
    /// No file yet: the initial document.
    case fresh
    case loaded
    /// Migrated from an older version; the original was backed up to `backup`.
    case migrated(from: Int, backup: URL)
    /// The file was unreadable; it was moved to `movedTo` and the initial document is used.
    case recoveredFromCorruption(movedTo: URL)
}

public enum DocumentStoreError: Error, Equatable {
    /// The file was written by a newer build. It is left untouched and nothing is saved over it.
    case newerVersion(found: Int, supported: Int)
    case missingMigration(from: Int)
}

/// Loads, migrates and atomically saves one versioned JSON document.
///
/// Saves are debounced (`scheduleSave`) and serialized by the actor; an older snapshot can never
/// overwrite a newer one (sequence guard). Writes go to a temporary file renamed over the target
/// (`Data.write(options: .atomic)`), so a crash never leaves a half-written document.
public actor DocumentStore<Document: VersionedDocument> {
    public let url: URL
    private let debounce: Duration
    private var pending: (document: Document, sequence: UInt64)?
    private var lastWrittenSequence: UInt64 = 0
    private var debounceTask: Task<Void, Never>?
    /// Set when the file on disk is newer than this build: saving is disabled to protect it.
    private var readOnly = false

    public init(url: URL, debounce: Duration = .milliseconds(300)) {
        self.url = url
        self.debounce = debounce
    }

    public func load() throws -> (document: Document, outcome: DocumentLoadOutcome) {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: url.path) else {
            return (Document.initial, .fresh)
        }
        let data: Data
        var object: JSONObject
        do {
            data = try Data(contentsOf: url)
            object = try JSONDecoder().decode(JSONObject.self, from: data)
        } catch {
            return (Document.initial, .recoveredFromCorruption(movedTo: try quarantine()))
        }
        guard let version = object["schemaVersion"]?.intValue else {
            return (Document.initial, .recoveredFromCorruption(movedTo: try quarantine()))
        }
        if version > Document.currentVersion {
            readOnly = true
            throw DocumentStoreError.newerVersion(found: version, supported: Document.currentVersion)
        }

        var outcome = DocumentLoadOutcome.loaded
        if version < Document.currentVersion {
            let backup = siblingURL(suffix: ".v\(version).bak")
            try? fileManager.removeItem(at: backup)
            try fileManager.copyItem(at: url, to: backup)
            for step in version..<Document.currentVersion {
                guard let migrate = Document.migrations[step] else {
                    throw DocumentStoreError.missingMigration(from: step)
                }
                try migrate(&object)
                object["schemaVersion"] = .number(Double(step + 1))
            }
            outcome = .migrated(from: version, backup: backup)
        }

        do {
            let payload: Data
            if version < Document.currentVersion {
                payload = try JSONEncoder().encode(object)
            } else {
                payload = data
            }
            let document = try Self.decoder.decode(Document.self, from: payload)
            if case .migrated = outcome { try write(document) }
            return (document, outcome)
        } catch {
            return (Document.initial, .recoveredFromCorruption(movedTo: try quarantine()))
        }
    }

    /// Writes after the debounce interval; only the latest scheduled snapshot is written.
    ///
    /// `revision` orders snapshots: the caller increments it on every change (on the thread that owns
    /// the document), so a snapshot that reaches the actor late can never replace a newer one.
    public func scheduleSave(_ document: Document, revision: UInt64) {
        guard !readOnly, revision > lastWrittenSequence, revision > (pending?.sequence ?? 0) else { return }
        pending = (document, revision)
        debounceTask?.cancel()
        debounceTask = Task { [debounce] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            self.flushPending()
        }
    }

    /// Writes any scheduled snapshot now (call on quit).
    public func flush() {
        debounceTask?.cancel()
        flushPending()
    }

    /// Writes immediately, bypassing the debounce.
    public func save(_ document: Document, revision: UInt64) throws {
        guard !readOnly, revision > lastWrittenSequence else { return }
        try write(document, sequence: revision)
        if let pending, pending.sequence <= revision { self.pending = nil }
    }

    /// True when the file on disk belongs to a newer build and is being protected from writes.
    public var isReadOnly: Bool { readOnly }

    private func flushPending() {
        guard let (document, sequence) = pending else { return }
        do {
            try write(document, sequence: sequence)
            pending = nil
        } catch {
            // Keep the latest snapshot available for a later flush or save.
        }
    }

    private func write(_ document: Document, sequence: UInt64? = nil) throws {
        if let sequence {
            guard sequence > lastWrittenSequence else { return }
        }
        var stamped = document
        stamped.schemaVersion = Document.currentVersion
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.encoder.encode(stamped).write(to: url, options: .atomic)
        if let sequence { lastWrittenSequence = sequence }
    }

    private func quarantine() throws -> URL {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let destination = siblingURL(suffix: ".corrupt-\(stamp)")
        try FileManager.default.moveItem(at: url, to: destination)
        return destination
    }

    private func siblingURL(suffix: String) -> URL {
        url.deletingLastPathComponent().appending(path: url.lastPathComponent + suffix)
    }

    static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
