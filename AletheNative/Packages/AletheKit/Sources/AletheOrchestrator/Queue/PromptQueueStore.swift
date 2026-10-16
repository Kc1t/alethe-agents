import Foundation

/// Separate file beside orchestrator-jobs.json; job history retains its existing schema.
public struct PromptQueueStore: Sendable {
    public static let fileName = "orchestrator-queue.json"
    public let url: URL

    public init(url: URL) { self.url = url }

    public func load() throws -> [QueueItem] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let items = try JSONDecoder().decode([QueueItem].self, from: Data(contentsOf: url))
        guard Set(items.map(\.id)).count == items.count else { throw CocoaError(.fileReadCorruptFile) }
        return items
    }

    public func save(_ items: [QueueItem]) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(items)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}
