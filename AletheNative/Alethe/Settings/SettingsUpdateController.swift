import AppKit
import Foundation
import Observation

/// Native releases use disk images; opening the downloaded installer keeps macOS installation
/// and code-signing checks in Finder instead of replacing a running signed bundle.
@MainActor @Observable
final class SettingsUpdateController {
    enum Phase { case idle, checking, current, available, downloading, ready, failed }
    private(set) var phase = Phase.idle
    private(set) var version = ""
    private(set) var notes = ""
    private(set) var error = ""
    private var asset: URL?
    private var installer: URL?

    private struct Release: Decodable, Sendable {
        let tag_name: String
        let body: String?
        let draft: Bool
        let prerelease: Bool
        let assets: [Asset]
    }
    private struct Asset: Decodable, Sendable {
        let name: String
        let browser_download_url: URL
    }
    private enum UpdateError: LocalizedError {
        case response
        var errorDescription: String? { String(localized: "settings.updates.failed") }
    }

    func check() async {
        guard phase != .checking, phase != .downloading else { return }
        phase = .checking
        error = ""
        do {
            let endpoint = URL(string: "https://api.github.com/repos/HayatoG/alethe-agents/releases?per_page=20")!
            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 20
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.response }
            let releases = try JSONDecoder().decode([Release].self, from: data)
            let installed = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
            guard let current = Self.parts(installed) else { throw UpdateError.response }
            let candidates = releases.filter {
                !$0.draft && !$0.prerelease && Self.parts($0.tag_name).map { current.lexicographicallyPrecedes($0) } == true
                    && $0.assets.contains { $0.name.hasSuffix(".dmg") }
            }
            guard let latest = candidates.max(by: { (Self.parts($0.tag_name) ?? []).lexicographicallyPrecedes(Self.parts($1.tag_name) ?? []) }),
                  let download = latest.assets.first(where: { $0.name.hasSuffix(".dmg") })?.browser_download_url,
                  Self.trusted(download) else {
                phase = .current
                return
            }
            asset = download
            version = latest.tag_name
            notes = latest.body ?? ""
            phase = .available
        } catch {
            self.error = error.localizedDescription
            phase = .failed
        }
    }

    func download() async {
        guard phase != .downloading, let asset else { return }
        phase = .downloading
        error = ""
        do {
            let (temporary, response) = try await URLSession.shared.download(from: asset)
            defer { try? FileManager.default.removeItem(at: temporary) }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.response }
            let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appending(path: "com.kc1t.alethe/Updates", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appending(path: "Alethe-\(UUID().uuidString).dmg")
            try FileManager.default.moveItem(at: temporary, to: destination)
            installer = destination
            phase = .ready
        } catch {
            self.error = error.localizedDescription
            phase = .failed
        }
    }

    func openInstaller() {
        guard let installer else { return }
        if !NSWorkspace.shared.open(installer) {
            error = String(localized: "settings.updates.failed")
            phase = .failed
        }
    }

    private static func trusted(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "github.com"
            && url.path.hasPrefix("/HayatoG/alethe-agents/releases/download/")
    }
    private static func parts(_ tag: String) -> [Int]? {
        let text = tag.hasPrefix("mac-native-v") ? String(tag.dropFirst(12)) : (tag.hasPrefix("v") ? String(tag.dropFirst()) : tag)
        let fields = text.split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 3, fields.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { return nil }
        let parts = fields.compactMap { Int($0) }
        return parts.count == 3 ? parts : nil
    }
}
