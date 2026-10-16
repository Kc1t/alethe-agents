import AletheDesign
import AletheIntegrations
import AppKit
import SwiftUI

/// Home's Now Playing card (upstream `HomeView/NowPlayingWidget`): art, track, artists, progress and
/// Open in Spotify in native mode; the web hero stays empty until a track is known.
struct NowPlayingCard: View {
    var homeDockInfoWidth: CGFloat = .infinity
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.openSettings) private var openSettings
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @State private var homeDockHovered = false

    var body: some View {
        if let model = environment.nowPlaying.model {
            // A stable container: switching between the track and the prompt is not a disappearance.
            VStack(spacing: 0) { content(model) }
                .nowPlayingVisibility(model)
        }
    }

    @ViewBuilder private func content(_ model: NowPlayingModel) -> some View {
        if let track = model.current {
            if metrics.isWebInterface {
                webDock(track)
            } else {
                playing(track, model: model)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .aletheCard()
                    .frame(width: metrics.size(320))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("home.nowPlaying")
            }
        } else if !metrics.isWebInterface, model.connected == false {
            connectPrompt(model)
                .frame(maxWidth: .infinity, alignment: .leading)
                .aletheCard()
                .frame(width: metrics.size(320))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("home.nowPlaying.prompt")
        } else {
            // Nothing to show yet; a zero-size view keeps the visibility hooks alive.
            Color.clear.frame(width: 0, height: 0)
        }
    }

    private func webDock(_ track: SpotifyNowPlaying) -> some View {
        Button {} label: {
            HStack(spacing: metrics.size(homeDockHovered ? 6 : 0)) {
                CoverArt(url: track.coverURL, size: metrics.size(30))
                    .clipShape(Circle())
                    .overlay(alignment: .bottomTrailing) {
                        if track.playing {
                            Image(systemName: "waveform")
                                .font(metrics.font(size: 7))
                                .foregroundStyle(theme[.bg])
                                .frame(width: metrics.size(14), height: metrics.size(14))
                                .background(theme[.statusWorking], in: Circle())
                                .overlay(Circle().strokeBorder(theme[.bgElevated], lineWidth: metrics.size(2)))
                                .offset(x: metrics.size(5), y: metrics.size(4))
                        }
                    }
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(verbatim: track.track)
                        .font(metrics.font(size: 11, weight: .medium))
                        .foregroundStyle(theme[.fg])
                        .accessibilityIdentifier("home.nowPlaying.track")
                    HStack(spacing: metrics.size(4)) {
                        Text(verbatim: track.artist)
                            .font(metrics.font(size: 10))
                            .foregroundStyle(theme[.fgMuted])
                            .accessibilityIdentifier("home.nowPlaying.artist")
                        if track.playing {
                            Equalizer(barCount: 4, height: metrics.size(9))
                                .accessibilityIdentifier("home.nowPlaying.status")
                        } else {
                            Text("home.nowPlaying.last")
                                .accessibilityIdentifier("home.nowPlaying.status")
                                .font(metrics.font(size: 10))
                                .foregroundStyle(theme[.fgFaint])
                        }
                    }
                }
                .lineLimit(1)
                .frame(width: homeDockHovered ? min(metrics.size(126), homeDockInfoWidth) : 0, alignment: .leading)
                .opacity(homeDockHovered ? 1 : 0)
                .clipped()
            }
            .padding(metrics.size(2))
            .padding(.trailing, homeDockHovered ? metrics.size(6) : 0)
            .frame(minWidth: metrics.size(36), minHeight: metrics.size(36))
            .background(theme[homeDockHovered ? .bgElevated : .bg].opacity(homeDockHovered ? 0.88 : 0.72), in: Capsule())
            .overlay(Capsule().strokeBorder(theme[homeDockHovered ? .accentBorder : .border], lineWidth: metrics.size(1)))
        }
        .buttonStyle(.plain)
        .onHover { homeDockHovered = $0 }
        .accessibilityLabel(Text(track.playing ? "nowPlaying.playing" : "nowPlaying.lastTrack"))
        .accessibilityIdentifier("home.nowPlaying")
    }

    private func playing(_ track: SpotifyNowPlaying, model: NowPlayingModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack(alignment: .top, spacing: metrics.space(.l)) {
                CoverArt(url: track.coverURL, size: metrics.size(56))
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    NowPlayingStatus(playing: track.playing)
                    Text(verbatim: track.track)
                        .font(metrics.font(.headline))
                        .foregroundStyle(theme[.textPrimary])
                        .lineLimit(1)
                        .accessibilityIdentifier("home.nowPlaying.track")
                    Text(verbatim: track.artist)
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textSecondary])
                        .lineLimit(1)
                        .accessibilityIdentifier("home.nowPlaying.artist")
                }
            }
            if track.durationMs > 0 {
                NowPlayingProgress(model: model, track: track)
            }
            if let url = track.trackURL {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label("nowPlaying.open", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(.link)
                .font(metrics.font(.footnote))
                .accessibilityIdentifier("home.nowPlaying.open")
            }
        }
    }

    private func connectPrompt(_ model: NowPlayingModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack(spacing: metrics.space(.m)) {
                Image(systemName: "music.note")
                    .foregroundStyle(theme[.accent])
                    .accessibilityHidden(true)
                Text(verbatim: "Spotify")
                    .font(metrics.font(.headline))
                    .foregroundStyle(theme[.textPrimary])
            }
            Text("nowPlaying.connect.message")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if let error = model.error, !model.connecting {
                Text(verbatim: NowPlayingController.message(error))
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.statusStopped])
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("home.nowPlaying.error")
            }
            HStack(spacing: metrics.space(.m)) {
                if model.connecting {
                    ProgressView().controlSize(.small)
                    Text("nowPlaying.connecting")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textSecondary])
                    Button("nowPlaying.cancel") { environment.nowPlaying.cancelConnect() }
                        .accessibilityIdentifier("home.nowPlaying.cancel")
                } else {
                    Button("nowPlaying.connect") { environment.nowPlaying.connect() }
                        .accessibilityIdentifier("home.nowPlaying.connect")
                    Button("nowPlaying.setUp") {
                        environment.settingsTab = .integrations
                        openSettings()
                    }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("home.nowPlaying.setUp")
                }
            }
            .font(metrics.font(.footnote))
        }
    }
}

/// The sidebar's Now Playing footer (upstream `SidebarNowPlaying`): a compact row above Add Project.
struct SidebarNowPlaying: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if let model = environment.nowPlaying.model {
            VStack(spacing: 0) {
                if let track = model.current {
                    row(track)
                } else {
                    Color.clear.frame(height: 0)
                }
            }
            .nowPlayingVisibility(model)
        }
    }

    private func row(_ track: SpotifyNowPlaying) -> some View {
        HStack(spacing: metrics.space(.m)) {
            CoverArt(url: track.coverURL, size: metrics.size(metrics.isWebInterface ? 24 : 28), sidebarWeb: metrics.isWebInterface)
                .fixedSize(horizontal: metrics.isWebInterface, vertical: metrics.isWebInterface)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: track.track)
                    .font(metrics.isWebInterface ? metrics.font(size: 11, weight: .medium) : metrics.font(.footnote).weight(.medium))
                    .foregroundStyle(theme[metrics.isWebInterface ? .fg : .textPrimary])
                    .lineLimit(1)
                Text(verbatim: track.artist)
                    .font(metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.caption))
                    .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .textSecondary])
                    .lineLimit(1)
            }
            .frame(maxWidth: metrics.isWebInterface ? .infinity : nil, alignment: .leading)
            Spacer(minLength: 0)
            if track.playing {
                Equalizer(barCount: 3, height: metrics.size(metrics.isWebInterface ? 12 : 10),
                          sidebarWeb: metrics.isWebInterface)
                    .fixedSize(horizontal: metrics.isWebInterface, vertical: metrics.isWebInterface)
            } else if metrics.isWebInterface {
                Text(verbatim: "‖")
                    .font(metrics.font(size: 14))
                    .tracking(metrics.size(-1))
                    .foregroundStyle(theme[.fgFaint])
                    .fixedSize()
                    .accessibilityHidden(true)
            } else {
                Image(systemName: "pause.fill")
                    .font(metrics.isWebInterface ? metrics.font(size: 14) : metrics.font(.caption))
                    .foregroundStyle(theme[metrics.isWebInterface ? .fgFaint : .textTertiary])
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, metrics.isWebInterface ? metrics.size(10) : metrics.space(.l))
        .padding(.vertical, metrics.isWebInterface ? 0 : metrics.space(.s))
        .frame(height: metrics.isWebInterface ? metrics.size(40) : nil)
        .overlay(alignment: .top) {
            Rectangle().fill(theme[metrics.isWebInterface ? .border : .borderSubtle]).frame(height: metrics.isWebInterface ? metrics.size(1) : 1)
        }
        .help(Text(verbatim: NowPlayingText.summary(track)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: NowPlayingText.summary(track)))
        .accessibilityIdentifier("sidebar.nowPlaying")
    }
}

// MARK: - Pieces

private enum NowPlayingText {
    /// "Track — Artist", with "(paused)" when not playing (upstream's tooltip).
    static func summary(_ track: SpotifyNowPlaying) -> String {
        let base = "\(track.track) — \(track.artist)"
        return track.playing ? base : "\(base) (\(String(localized: "nowPlaying.paused")))"
    }

    static func time(_ milliseconds: Int) -> String {
        Duration.milliseconds(milliseconds).formatted(.time(pattern: .minuteSecond))
    }
}

/// "Now playing" with the equalizer, or "Last track" when paused.
private struct NowPlayingStatus: View {
    let playing: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.space(.xs)) {
            if playing {
                Equalizer(barCount: 4, height: metrics.size(9))
                Text("nowPlaying.playing")
            } else {
                Text("nowPlaying.lastTrack")
            }
        }
        .font(metrics.font(.caption).weight(.medium))
        .foregroundStyle(theme[playing ? .accent : .textTertiary])
        .textCase(.uppercase)
        .accessibilityIdentifier("home.nowPlaying.status")
    }
}

/// Elapsed and total time; the elapsed side advances each second while playing.
private struct NowPlayingProgress: View {
    let model: NowPlayingModel
    let track: SpotifyNowPlaying
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let progress = track.playing ? model.progressMs(at: context.date) : track.progressMs
            VStack(spacing: metrics.space(.xxs)) {
                ProgressView(value: Double(min(progress, track.durationMs)), total: Double(track.durationMs))
                    .tint(theme[.accent])
                HStack {
                    Text(verbatim: NowPlayingText.time(progress))
                    Spacer()
                    Text(verbatim: NowPlayingText.time(track.durationMs))
                }
                .font(metrics.font(.caption).monospacedDigit())
                .foregroundStyle(theme[.textTertiary])
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.nowPlaying.progress")
    }
}

/// Bars that move while music plays; still under Reduce Motion.
private struct Equalizer: View {
    let barCount: Int
    let height: CGFloat
    var sidebarWeb = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private static let rest: [CGFloat] = [0.6, 1, 0.4, 0.8]

    private func barLevel(at time: TimeInterval, index: Int) -> CGFloat {
        if metrics.reducesMotion { return Self.rest[index % Self.rest.count] }
        if sidebarWeb {
            let phase = (time - Double(index) * 0.18) / 0.9
            return CGFloat(0.675 - 0.325 * cos(2 * .pi * phase))
        }
        let phase = time * (3.1 + Double(index) * 0.9) + Double(index)
        return CGFloat(0.35 + 0.65 * abs(sin(phase)))
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12, paused: metrics.reducesMotion)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: metrics.size(sidebarWeb ? 2 : 1.5)) {
                ForEach(0..<barCount, id: \.self) { index in
                    let level: CGFloat = barLevel(at: time, index: index)
                    RoundedRectangle(cornerRadius: metrics.size(1))
                        .fill(theme[sidebarWeb ? .statusActive : .accent])
                        .frame(width: metrics.size(2), height: height * level)
                }
            }
            .frame(height: height, alignment: .bottom)
        }
        .accessibilityHidden(true)
    }
}

/// Album art, loaded off the main thread and cached; a music note until it arrives or when missing.
private struct CoverArt: View {
    let url: URL?
    let size: CGFloat
    var sidebarWeb = false
    @State private var image: NSImage?
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: sidebarWeb ? metrics.size(3) : metrics.radius(.sm)).fill(theme[sidebarWeb ? .bgElevated : .bgSunken])
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if !sidebarWeb {
                Image(systemName: "music.note")
                    .font(.system(size: size * 0.4))
                    .foregroundStyle(theme[.textTertiary])
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: sidebarWeb ? metrics.size(3) : metrics.radius(.sm)))
        .accessibilityHidden(true)
        .task(id: url) {
            image = nil
            guard let url else { return }
            image = await CoverArtCache.shared.image(for: url)?.image
        }
    }
}

/// A decoded cover; never mutated after decoding, so it can cross threads.
private struct DecodedCover: @unchecked Sendable {
    let image: NSImage
}

/// Recent covers by URL. Only `https` is fetched; decoding happens off the main thread.
private actor CoverArtCache {
    static let shared = CoverArtCache()
    private static let limit = 24
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 20
        return URLSession(configuration: configuration)
    }()

    private var images: [URL: DecodedCover] = [:]
    private var order: [URL] = []
    private var pending: [URL: Task<DecodedCover?, Never>] = [:]

    func image(for url: URL) async -> DecodedCover? {
        if let cached = images[url] { return cached }
        guard url.scheme == "https" else { return nil }
        let task = pending[url] ?? Task.detached(priority: .utility) { () -> DecodedCover? in
            guard let (data, response) = try? await Self.session.data(from: url),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true,
                  data.count < 2_000_000 else { return nil }
            return NSImage(data: data).map(DecodedCover.init)
        }
        pending[url] = task
        let image = await task.value
        pending[url] = nil
        if let image { store(image, for: url) }
        return image
    }

    private func store(_ image: DecodedCover, for url: URL) {
        images[url] = image
        order.removeAll { $0 == url }
        order.append(url)
        while order.count > Self.limit { images[order.removeFirst()] = nil }
    }
}

private extension View {
    /// Registers a visible Now Playing view, which lets the model poll.
    func nowPlayingVisibility(_ model: NowPlayingModel) -> some View {
        onAppear { model.viewAppeared() }
            .onDisappear { model.viewDisappeared() }
    }
}
