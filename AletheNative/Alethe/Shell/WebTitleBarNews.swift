import AletheDesign
import SwiftUI

/// WhatsNewModal.tsx / WhatsNewModal.module.css. The web lists its bundled changelog; native releases
/// are read from the published release notes, with the static blurb as the offline fallback.
struct WebTitleBarNews: View {
    let close: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var releases: [SidebarNativeRelease]?
    @State private var update: SidebarNativeRelease?

    private var version: String { update?.displayVersion ?? SidebarNativeRelease.installedVersion }

    var body: some View {
        ModalsM2WebModal(title: Text(verbatim: String(format: String(localized: "whatsNew.web.title"), version)),
                         close: close, width: 480) {
            VStack(alignment: .leading, spacing: 0) {
                hero
                if let update, !update.notes.isEmpty {
                    ReleaseNotesBox(text: update.notes, maxHeight: 240).padding(.top, metrics.size(14))
                } else if let releases, !releases.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: metrics.size(18)) {
                            ForEach(releases, id: \.version) { release in
                                VStack(alignment: .leading, spacing: metrics.size(8)) {
                                    Text(verbatim: String(format: String(localized: "whatsNew.web.releaseHeading"),
                                                          release.displayVersion, dateText(release)))
                                        .font(metrics.font(size: 12, weight: .semibold)).tracking(metrics.size(0.24))
                                    ReleaseNotesList(text: release.notes)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: metrics.size(360))
                    .padding(.top, metrics.size(4))
                } else if releases == nil {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.top, metrics.size(14))
                } else {
                    Text("chrome.news.chrome").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                        .padding(.top, metrics.size(14))
                }
            }
        } footer: {
            Spacer()
            Button("whatsNew.web.close", action: close).accessibilityIdentifier("chrome.whatsNew.close")
            if let update {
                Button("whatsNew.web.update") {
                    environment.editorRequest = .updateAvailable(update)
                    close()
                }
                .buttonStyle(AletheButtonStyle(.primary))
                .accessibilityIdentifier("chrome.whatsNew.update")
            }
        }
        .task {
            async let recent = SidebarNativeRelease.recent()
            async let pending = SidebarNativeRelease.check()
            releases = await recent
            update = await pending
        }
        .accessibilityIdentifier("chrome.whatsNew.modal")
    }

    private var hero: some View {
        HStack(alignment: .top, spacing: metrics.size(12)) {
            Image(systemName: "newspaper").font(metrics.font(size: 18))
                .foregroundStyle(theme[.accent])
                .frame(width: metrics.size(32), height: metrics.size(32))
                .overlay(RoundedRectangle(cornerRadius: metrics.size(9)).strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                Text(update == nil ? "whatsNew.web.subtitle" : "whatsNew.web.pendingTitle")
                    .font(metrics.font(size: 13, weight: .bold))
                Group {
                    if let update {
                        Text(verbatim: String(format: String(localized: "whatsNew.web.pendingBody"), update.displayVersion))
                    } else { Text("whatsNew.web.body") }
                }
                .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted]).lineSpacing(metrics.size(2.4))
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(metrics.size(12))
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private func dateText(_ release: SidebarNativeRelease) -> String {
        release.published?.formatted(date: .abbreviated, time: .omitted) ?? "—"
    }
}

/// TitleBar.module.css `.whatsNewDot`: a 5pt status-working dot at top 4 / right 4 of the What's New
/// button while a newer native release is waiting (the web's `updateInfo`).
private struct WebTitleBarNewsBadge: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var pending = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if pending {
                    Circle().fill(theme[.statusWorking])
                        .frame(width: metrics.size(5), height: metrics.size(5))
                        .padding(.top, metrics.size(4)).padding(.trailing, metrics.size(4))
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("chrome.whatsNew.badge")
                }
            }
            .task { pending = await SidebarNativeRelease.check() != nil }
    }
}

extension View {
    func webTitleBarNewsBadge() -> some View { modifier(WebTitleBarNewsBadge()) }
}

/// UpdateModal.tsx. Native builds are not installed in place: the primary action opens the release.
struct UpdateAvailableWebModal: View {
    let release: SidebarNativeRelease
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.openURL) private var openURL
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    private func close() { closeOverlay?() }

    var body: some View {
        ModalsM2WebModal(title: Text(verbatim: String(format: String(localized: "update.web.availableTitle"), release.displayVersion)),
                         close: close, width: 480) {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                Text(verbatim: String(format: String(localized: "update.web.body"),
                                      SidebarNativeRelease.installedVersion, release.displayVersion))
                    .font(metrics.font(size: 13)).lineSpacing(metrics.size(3.5))
                    .fixedSize(horizontal: false, vertical: true)
                if !release.notes.isEmpty { ReleaseNotesBox(text: release.notes, maxHeight: 240) }
            }
        } footer: {
            Spacer()
            Button("update.web.later", action: close).accessibilityIdentifier("update.later")
            Button("update.web.download") { openURL(release.page); close() }
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("update.install")
        }
        .accessibilityIdentifier("update.modal")
    }
}

/// WhatsNewModal.module.css `.notes`: the release body, whitespace preserved, in a sunken box.
private struct ReleaseNotesBox: View {
    let text: String
    let maxHeight: CGFloat
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var contentHeight: CGFloat = 0
    var body: some View {
        ScrollView {
            Text(verbatim: text).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                .lineSpacing(metrics.size(4.6)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(12))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(contentHeight, metrics.size(maxHeight)))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

/// WhatsNewModal.module.css `.list`: bullets parsed from the release body's markdown lists.
private struct ReleaseNotesList: View {
    let text: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    private var items: [String] {
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        let bullets = lines.compactMap { line -> String? in
            for marker in ["- ", "* ", "• "] where line.hasPrefix(marker) { return String(line.dropFirst(marker.count)) }
            return nil
        }
        return bullets.isEmpty ? lines.filter { !$0.isEmpty && !$0.hasPrefix("#") } : bullets
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(7)) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: metrics.size(8)) {
                    Text(verbatim: "•")
                    Text(verbatim: item).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted]).lineSpacing(metrics.size(4.6))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, metrics.size(14)).padding(.trailing, metrics.size(14))
        .padding(.vertical, metrics.size(12))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}
