import CryptoKit
import Foundation

/// Web manifests are retained verbatim. Registration never loads JavaScript or grants host services.
public struct WebPluginManifest: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let version: String
    public let kind: String
    public let apiVersion: Int
    public let description: String
    public let capabilities: [String]

    public static func validate(_ data: Data) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard PluginManifest(id: value.id, version: value.version, name: value.name).hasValidID,
              !value.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !value.version.isEmpty, value.apiVersion == 1,
              ["agentType", "skill", "validationPipeline", "ui", "theme"].contains(value.kind)
        else { throw WebPluginRegistryError.invalidManifest }
        return value
    }
}

public enum WebPluginRegistryError: Error {
    case invalidManifest, invalidArchive, invalidCatalog, downloadFailed, checksumMismatch, protectedPlugin
}

public struct WebCatalogEntry: Codable, Sendable, Identifiable {
    public struct Package: Codable, Sendable {
        public let url: String
        public let sha256: String
    }
    public let id: String
    public let name: String
    public var description: String = ""
    public var author: String = ""
    public var repo: String = ""
    public let downloadUrl: String
    public var version: String = ""
    public var minApiVersion: Int = 1
    public var capabilities: [String] = []
    public var package: Package?

    enum CodingKeys: String, CodingKey {
        case id, name, description, author, repo, downloadUrl, version, minApiVersion, capabilities, package
    }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        downloadUrl = try values.decode(String.self, forKey: .downloadUrl)
        description = try values.decodeIfPresent(String.self, forKey: .description) ?? ""
        author = try values.decodeIfPresent(String.self, forKey: .author) ?? ""
        repo = try values.decodeIfPresent(String.self, forKey: .repo) ?? ""
        version = try values.decodeIfPresent(String.self, forKey: .version) ?? ""
        minApiVersion = try values.decodeIfPresent(Int.self, forKey: .minApiVersion) ?? 1
        capabilities = try values.decodeIfPresent([String].self, forKey: .capabilities) ?? []
        package = try values.decodeIfPresent(Package.self, forKey: .package)
    }
}

public struct WebCatalogSnapshot: Codable, Sendable {
    public var plugins: [WebCatalogEntry]
    public var fetchedAt: Date
    public var stale: Bool
}

public actor PluginWebRegistry {
    public let root: URL
    private let protectedIDs: Set<String>
    private let files = FileManager.default
    public init(root: URL, protectedIDs: Set<String> = []) {
        self.root = root
        self.protectedIDs = protectedIDs
    }

    public func installed() throws -> [WebPluginManifest] {
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        return try files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.hasDirectoryPath }
            .compactMap { directory in
                guard let data = try? Data(contentsOf: directory.appending(path: "manifest.json")),
                      let manifest = try? WebPluginManifest.validate(data),
                      manifest.id == directory.lastPathComponent else { return nil }
                return manifest
            }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    public func install(manifest data: Data) throws {
        guard data.count <= 4 * 1024 * 1024 else { throw WebPluginRegistryError.invalidManifest }
        let manifest = try WebPluginManifest.validate(data)
        guard !protectedIDs.contains(manifest.id) else { throw WebPluginRegistryError.protectedPlugin }
        let directory = root.appending(path: manifest.id, directoryHint: .isDirectory)
        if files.fileExists(atPath: directory.path),
           try directory.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
            throw WebPluginRegistryError.invalidManifest
        }
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appending(path: "manifest.json"), options: .atomic)
    }

    public func uninstall(_ id: String) throws {
        guard !protectedIDs.contains(id),
              PluginManifest(id: id, version: "", name: "").hasValidID else {
            throw WebPluginRegistryError.protectedPlugin
        }
        try files.removeItem(at: root.appending(path: id))
    }

    /// Imports metadata only; executable assets cannot enter the native runtime through this path.
    public func importFile(_ source: URL) throws {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        if source.hasDirectoryPath {
            try install(manifest: Data(contentsOf: source.appending(path: "manifest.json")))
        } else if source.pathExtension.lowercased() == "zip" {
            try importArchive(source)
        } else {
            try install(manifest: Data(contentsOf: source))
        }
    }

    private func output(_ arguments: [String]) throws -> Data {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/unzip")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        var data = Data()
        while true {
            let chunk = pipe.fileHandleForReading.readData(ofLength: 64 * 1024)
            if chunk.isEmpty { break }
            data.append(chunk)
            if data.count > 4 * 1024 * 1024 {
                process.terminate()
                pipe.fileHandleForReading.closeFile()
                process.waitUntilExit()
                throw WebPluginRegistryError.invalidArchive
            }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw WebPluginRegistryError.invalidArchive
        }
        return data
    }

    private func importArchive(_ source: URL) throws {
        // Stream only a manifest; never extract archive paths or follow archive symlinks.
        let listing = try output(["-Z1", source.path])
        let paths = String(decoding: listing, as: UTF8.self).split(separator: "\n").map(String.init)
        let candidates = paths.filter { path in
            let parts = path.split(separator: "/")
            return !path.hasPrefix("/") && !parts.contains("..") && parts.last == "manifest.json"
        }
        guard candidates.count == 1, let path = candidates.first,
              !path.contains("*"), !path.contains("?"), !path.contains("[") else {
            throw WebPluginRegistryError.invalidArchive
        }
        try install(manifest: output(["-p", source.path, path]))
    }

    public func catalog(refresh: Bool) async throws -> WebCatalogSnapshot {
        let cache = root.appending(path: "catalog-cache.json")
        let cached = (try? Data(contentsOf: cache)).flatMap { try? JSONDecoder().decode(WebCatalogSnapshot.self, from: $0) }
        if !refresh, let cached, Date().timeIntervalSince(cached.fetchedAt) < 6 * 60 * 60 { return cached }
        do {
            let url = URL(string: "https://raw.githubusercontent.com/Kc1t/alethe-agents/main/plugins.json")!
            var request = URLRequest(url: url)
            request.timeoutInterval = 8
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, response.url?.scheme == "https", data.count <= 4 * 1024 * 1024 else {
                throw WebPluginRegistryError.downloadFailed
            }
            struct Index: Decodable { let schema: Int; let plugins: [WebCatalogEntry] }
            let index = try JSONDecoder().decode(Index.self, from: data)
            guard index.schema == 1 else { throw WebPluginRegistryError.invalidCatalog }
            let entries = index.plugins.filter { entry in
                guard PluginManifest(id: entry.id, version: entry.version, name: entry.name).hasValidID,
                      !entry.name.isEmpty, entry.minApiVersion <= 1,
                      URL(string: entry.downloadUrl)?.scheme == "https" else { return false }
                if let package = entry.package {
                    return URL(string: package.url)?.scheme == "https" && package.sha256.count == 64 &&
                        package.sha256.allSatisfy { $0.isHexDigit && $0.isASCII }
                }
                return true
            }
            let snapshot = WebCatalogSnapshot(plugins: entries, fetchedAt: Date(), stale: false)
            try files.createDirectory(at: root, withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: cache, options: .atomic)
            return snapshot
        } catch {
            if var cached { cached.stale = true; return cached }
            throw error
        }
    }

    public func install(_ entry: WebCatalogEntry) async throws {
        guard let package = entry.package, let url = URL(string: package.url), url.scheme == "https" else {
            throw WebPluginRegistryError.invalidCatalog
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, response.url?.scheme == "https", data.count <= 64 * 1024 * 1024 else {
            throw WebPluginRegistryError.downloadFailed
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard hash == package.sha256.lowercased() else { throw WebPluginRegistryError.checksumMismatch }
        let temporary = files.temporaryDirectory.appending(path: UUID().uuidString + ".zip")
        try data.write(to: temporary)
        defer { try? files.removeItem(at: temporary) }
        // Validate identity before changing the registry.
        let listing = try output(["-Z1", temporary.path])
        let paths = String(decoding: listing, as: UTF8.self).split(separator: "\n").map(String.init)
        let manifests = paths.filter { $0.split(separator: "/").last == "manifest.json" }
        guard manifests.count == 1, let path = manifests.first,
              !path.contains("*"), !path.contains("?"), !path.contains("[") else {
            throw WebPluginRegistryError.invalidArchive
        }
        let raw = try output(["-p", temporary.path, path])
        let manifest = try WebPluginManifest.validate(raw)
        guard manifest.id == entry.id, manifest.version == entry.version else {
            throw WebPluginRegistryError.invalidManifest
        }
        try install(manifest: raw)
    }
}
