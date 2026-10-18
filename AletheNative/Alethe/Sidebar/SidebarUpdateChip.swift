import AletheDesign
import Foundation
import SwiftUI

/// Native releases are published on the fork; Windows releases must never trigger this chip.
struct SidebarUpdateChip: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @Environment(AppEnvironment.self) private var environment
    @State private var release: SidebarNativeRelease?
    @State private var hovering = false

    var body: some View {
        Group {
            if let release {
                Button {
                    // The web opens its update modal; the native interface goes to the release page.
                    if metrics.isWebInterface { environment.editorRequest = .updateAvailable(release) }
                    else { openURL(release.page) }
                } label: {
                    HStack(spacing: metrics.size(7)) {
                        Image(systemName: "arrow.up.circle").webProfileSized(13)
                            .font(metrics.font(size: 13))
                            .foregroundStyle(theme[.statusWorking])
                        Text("sidebar.web.updateAvailable")
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(verbatim: release.version)
                            .monospacedDigit()
                            .foregroundStyle(theme[.fgMuted].opacity(0.85))
                    }
                    .font(metrics.font(size: 11.5))
                    .foregroundStyle(theme[hovering ? .fg : .fgMuted])
                    .padding(.vertical, metrics.size(6))
                    .padding(.horizontal, metrics.size(9))
                    .background(theme[hovering ? .panelHover : .panel],
                                in: RoundedRectangle(cornerRadius: metrics.size(8)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(8))
                        .strokeBorder(theme[hovering ? .accentBorder : .border], lineWidth: metrics.size(1)))
                }
                .buttonStyle(.plain)
                .animation(Motion.SidebarEffect.quickNavigation.animation(
                    reduceMotion: metrics.reducesMotion, clean: metrics.style == .clean), value: hovering)
                .onHover { hovering = $0 }
                .padding(.horizontal, metrics.size(8))
                .padding(.bottom, metrics.size(6))
                .help(Text(verbatim: String(format: String(localized: "sidebar.web.updateTitle"), release.version)))
                .accessibilityIdentifier("sidebar.updateAvailable")
            }
        }
        .task {
            release = await SidebarNativeRelease.check()
        }
    }
}

struct SidebarNativeRelease: Hashable, Sendable {
    let version: String
    let page: URL
    /// The release body (GitHub markdown), shown in What's New and the update modal.
    var notes = ""
    var published: Date?

    /// The tag without its prefix, as shown to people ("1.4.0").
    var displayVersion: String {
        var text = version
        if text.hasPrefix("mac-native-v") { text.removeFirst("mac-native-v".count) }
        else if text.hasPrefix("v") { text.removeFirst() }
        return text
    }

    private struct Release: Decodable, Sendable {
        let tag_name: String
        let html_url: URL
        let draft: Bool
        let prerelease: Bool
        let assets: [Asset]
        let body: String?
        let published_at: String?
    }
    private struct Asset: Decodable, Sendable { let name: String }

    static var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    /// Only comparable, stable native versions qualify. Preview tags have no installed-version
    /// equivalent and are deliberately ignored rather than displaying a false update notification.
    static func check() async -> Self? {
        guard let current = versionParts(installedVersion) else { return nil }
        let candidates = await stableReleases().filter { current.lexicographicallyPrecedes($0.1) }
        return candidates.max(by: { $0.1.lexicographicallyPrecedes($1.1) })?.0
    }

    /// The newest stable native releases, newest first (What's New).
    static func recent(limit: Int = 6) async -> [Self] {
        let all = await stableReleases().sorted { $1.1.lexicographicallyPrecedes($0.1) }
        return Array(all.prefix(limit).map(\.0))
    }

    private static func stableReleases() async -> [(Self, [Int])] {
        guard let endpoint = URL(string: "https://api.github.com/repos/HayatoG/alethe-agents/releases?per_page=20") else { return [] }
        do {
            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 15
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return [] }
            let releases = try JSONDecoder().decode([Release].self, from: data)
            return releases.compactMap { entry -> (Self, [Int])? in
                guard !entry.draft, !entry.prerelease,
                      entry.assets.contains(where: { $0.name.hasSuffix(".dmg") }),
                      entry.html_url.scheme == "https", entry.html_url.host == "github.com",
                      entry.html_url.path.hasPrefix("/HayatoG/alethe-agents/releases/"),
                      let version = versionParts(entry.tag_name) else { return nil }
                let date = entry.published_at.flatMap { try? Date($0, strategy: .iso8601) }
                return (Self(version: entry.tag_name, page: entry.html_url, notes: entry.body ?? "", published: date), version)
            }
        } catch { return [] }
    }

    private static func versionParts(_ tag: String) -> [Int]? {
        var text = tag
        if text.hasPrefix("mac-native-v") { text.removeFirst("mac-native-v".count) }
        else if text.hasPrefix("v") { text.removeFirst() }
        let fields = text.split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 3, fields.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { return nil }
        let parts = fields.compactMap { Int($0) }
        return parts.count == 3 ? parts : nil
    }
}
