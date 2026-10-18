import AletheDesign
import AletheIntegrations
import SwiftUI

/// NowPlayingWidget.tsx and the homePlayerDock overrides in HomeView.module.css.
struct WebHomeNowPlaying: View {
    var homeDockInfoWidth: CGFloat = .infinity
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.theme) private var theme
    @State private var hovered = false
    @FocusState private var focused: Bool

    private var expanded: Bool { hovered || focused }

    var body: some View {
        if let model = environment.nowPlaying.model {
            Group {
                if let track = model.current { dock(track) }
                else { Color.clear.frame(width: 0, height: 0) }
            }
            .onAppear { model.viewAppeared() }
            .onDisappear { model.viewDisappeared() }
        }
    }

    private func dock(_ track: SpotifyNowPlaying) -> some View {
        Button {} label: {
            HStack(spacing: metrics.size(expanded ? 6 : 0)) {
                cover(track)
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(verbatim: track.track).font(metrics.font(size: 11, weight: .medium))
                        .foregroundStyle(theme[.fg]).frame(maxWidth: metrics.size(124), alignment: .leading)
                        .accessibilityIdentifier("home.nowPlaying.track")
                    HStack(spacing: metrics.size(6)) {
                        Text(verbatim: track.artist).font(metrics.font(size: 10)).foregroundStyle(theme[.textTertiary])
                            .frame(maxWidth: metrics.size(98), alignment: .leading)
                            .accessibilityIdentifier("home.nowPlaying.artist")
                        if track.playing { HomeMusicEqualizer(height: 10) }
                        else {
                            Text("home.nowPlaying.last").textCase(.uppercase).font(metrics.font(size: 9))
                                .tracking(metrics.size(0.4)).foregroundStyle(theme[.textQuaternary])
                        }
                    }.accessibilityIdentifier("home.nowPlaying.status")
                }
                .lineLimit(1)
                .frame(width: expanded ? min(metrics.size(126), homeDockInfoWidth) : 0, alignment: .leading)
                .opacity(expanded ? 1 : 0).offset(x: expanded ? 0 : -metrics.size(6)).clipped()
            }
            .padding(metrics.size(2)).padding(.trailing, expanded ? metrics.size(6) : 0)
            .frame(minWidth: metrics.size(36), minHeight: metrics.size(36))
            .background(theme[expanded ? .bgElevated : .bg].opacity(expanded ? 0.88 : 0.72), in: Capsule())
            .overlay(Capsule().strokeBorder(theme[expanded ? .accentBorder : .border], lineWidth: metrics.size(1)))
        }
        .shadow(color: metrics.style == .clean ? .clear : theme[.bg].opacity(expanded ? 0.72 : 0.62),
                radius: metrics.size(expanded ? 28 : 14), x: 0, y: metrics.size(expanded ? 10 : 4))
        .buttonStyle(.plain).focused($focused).onHover { hovered = $0 }
        .offset(y: expanded && !metrics.reducesMotion && metrics.style != .clean ? -metrics.size(1) : 0)
        .animation(metrics.reducesMotion ? nil : Motion.animation(Motion.quick, reduceMotion: false), value: expanded)
        .accessibilityLabel(Text(track.playing ? "nowPlaying.playing" : "nowPlaying.lastTrack"))
        .accessibilityIdentifier("home.nowPlaying")
    }

    private func cover(_ track: SpotifyNowPlaying) -> some View {
        ZStack {
            Circle().fill(theme[.bgSunken])
            if let url = track.coverURL, url.scheme == "https" {
                AsyncImage(url: url) { image in image.resizable().aspectRatio(contentMode: .fill) }
                    placeholder: { Color.clear }
            } else {
                Image(systemName: "music.note").webProfileSized(18).foregroundStyle(theme[.textQuaternary])
            }
        }
        .frame(width: metrics.size(30), height: metrics.size(30)).clipShape(Circle())
        .background {
            if track.playing, !metrics.reducesMotion {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: scenePhase != .active)) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
                    ZStack {
                        ring(phase)
                        ring((phase + 0.5).truncatingRemainder(dividingBy: 1))
                    }
                }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if track.playing {
                HomeMusicEqualizer(height: 7, compact: true)
                    .foregroundStyle(theme[.bg])
                    .frame(width: metrics.size(14), height: metrics.size(14))
                    .background(theme[.statusWorking], in: Circle())
                    .overlay(Circle().strokeBorder(theme[.bgElevated], lineWidth: metrics.size(2)))
                    .offset(x: metrics.size(5), y: metrics.size(4))
            }
        }
    }

    private func ring(_ phase: Double) -> some View {
        let progress = min(phase / 0.7, 1)
        return Circle().strokeBorder(theme[.statusWorking].opacity(0.62), lineWidth: metrics.size(1))
            .frame(width: metrics.size(36 * (0.92 + 0.36 * progress)), height: metrics.size(36 * (0.92 + 0.36 * progress)))
            .opacity(0.72 * (1 - progress))
    }
}

private struct HomeMusicEqualizer: View {
    let height: CGFloat
    var compact = false
    @Environment(\.metrics) private var metrics
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.theme) private var theme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: metrics.reducesMotion || scenePhase != .active)) { context in
            HStack(alignment: .bottom, spacing: metrics.size(compact ? 1 : 1.5)) {
                ForEach(0..<4) { index in
                    let phase = (context.date.timeIntervalSinceReferenceDate - Double(index) * 0.15) / 1.2
                    let amount = metrics.reducesMotion ? 1 : 0.75 + 0.25 * cos(2 * .pi * phase)
                    RoundedRectangle(cornerRadius: metrics.size(1))
                        .fill(theme[compact ? .bg : .statusWorking])
                        .frame(width: metrics.size(compact ? 1 : 2), height: metrics.size(height * [0.6, 1, 0.4, 0.8][index] * amount))
                }
            }.frame(height: metrics.size(height), alignment: .bottom)
        }.accessibilityHidden(true)
    }
}
