import AlethePluginKit
import Foundation
import Observation

@MainActor @Observable
final class PluginCatalogWebModel {
    struct Row: Identifiable {
        let id: String
        let name: String
        let version: String
        let description: String
        let author: String
        let capabilities: [String]
        let source: String
        let enabled: Bool
        let catalog: WebCatalogEntry?
        let native: Bool
        var installed: Bool { source != "catalog" }
        var update: Bool { installed && catalog?.package != nil && catalog?.version != version }
    }
    var local: [WebPluginManifest] = []
    var catalog: [WebCatalogEntry] = []
    var loading = false
    var stale = false
    var failed = false
    var error = false
    var busy = false
    var registry: PluginWebRegistry?
    var folder: URL?

    func configure(_ environment: AppEnvironment) {
        guard registry == nil, let locations = environment.locations, let profile = environment.profileID else { return }
        let root = locations.profileDirectory(profile).appending(path: "plugins", directoryHint: .isDirectory)
        folder = root
        registry = PluginWebRegistry(root: root, protectedIDs: Set(environment.plugins?.records.map(\.id) ?? []))
    }

    func rescan() async {
        guard let registry else { return }
        do { local = try await registry.installed() } catch { self.error = true }
    }

    func reload(refresh: Bool = false) async {
        guard let registry, !loading else { return }
        loading = true
        defer { loading = false }
        await rescan()
        do {
            let result = try await registry.catalog(refresh: refresh)
            catalog = result.plugins
            stale = result.stale
            failed = false
        } catch { failed = true }
    }

    func perform(_ operation: @escaping (PluginWebRegistry) async throws -> Void) async {
        guard let registry, !busy else { return }
        busy = true
        defer { busy = false }
        do { try await operation(registry); await rescan() } catch { self.error = true }
    }

    func rows(_ host: PluginHost?) -> [Row] {
        var result: [String: Row] = [:]
        for entry in catalog {
            result[entry.id] = Row(id: entry.id, name: entry.name, version: entry.version,
                description: entry.description, author: entry.author, capabilities: entry.capabilities,
                source: "catalog", enabled: false, catalog: entry, native: false)
        }
        for entry in local {
            let listing = catalog.first { $0.id == entry.id }
            result[entry.id] = Row(id: entry.id, name: listing?.name ?? entry.name, version: entry.version,
                description: listing?.description ?? entry.description, author: listing?.author ?? "",
                capabilities: entry.capabilities, source: "local", enabled: false, catalog: listing, native: false)
        }
        for record in host?.records ?? [] {
            let listing = catalog.first { $0.id == record.id }
            result[record.id] = Row(id: record.id, name: record.manifest.name, version: record.manifest.version,
                description: listing?.description ?? "", author: listing?.author ?? "",
                capabilities: record.manifest.capabilities.map(\.rawValue).sorted(),
                source: "bundled", enabled: record.isEnabled, catalog: listing, native: true)
        }
        return Array(result.values)
    }
}
