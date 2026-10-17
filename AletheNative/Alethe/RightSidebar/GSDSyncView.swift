import AletheDesign
import AletheIntegrations
import AletheModel
import AlethePluginKit
import SwiftUI

/// Right sidebar GSD Sync tab (P5-24; upstream `GsdSyncSidebarContent`): the selected project's child
/// sessions from the app-wide poll, each opening its activity.
struct GSDSyncView: View {
    @Environment(AppEnvironment.self) private var environment

    @Environment(\.metrics) private var metrics

    static let tabID = "gsdSync"
    static let tab = SidebarTabContribution(id: tabID, title: "GSD Sync", symbol: "arrow.triangle.2.circlepath",
                                            side: .right, viewID: tabID)

    private var project: Project? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)
        }
    }

    var body: some View {
        let sessions = project.map { environment.gsdSync.sessions(of: $0.id) } ?? []
        Group {
            if metrics.isWebInterface {
                if sessions.isEmpty {
                    WebSidebarEmpty(title: "gsdSync.empty", detail: "rightSidebar.gsd.emptyDetail", symbol: "sparkles", iconSize: 20, minimumHeight: 220, gap: 7, centeredInPanel: false)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .accessibilityIdentifier("gsdSync.empty")
                } else {
                    ScrollView {
                        LazyVStack(spacing: metrics.size(2)) {
                            ForEach(sessions) { session in GSDSyncRow(session: session) }
                        }
                        .padding(.horizontal, metrics.size(6))
                        .padding(.top, metrics.size(8)).padding(.bottom, metrics.size(18))
                    }.accessibilityIdentifier("gsdSync.list")
                }
            } else if sessions.isEmpty {
                ContentUnavailableView {
                    Label("gsdSync.empty", systemImage: "arrow.triangle.2.circlepath")
                } description: {
                    Text("gsdSync.empty.detail")
                }
                .accessibilityIdentifier("gsdSync.empty")
            } else {
                List(sessions) { session in
                    GSDSyncRow(session: session)
                }
                .listStyle(.sidebar)
                .accessibilityIdentifier("gsdSync.list")
            }
        }
    }
}

/// A child session: its state glyph, checkout, state and roadmap progress.
struct GSDSyncRow: View {
    let session: GSDSyncSession
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        Button {
            environment.editorRequest = .gsdSyncActivity(GSDSyncActivityTarget(session))
        } label: {
            HStack(spacing: metrics.space(.m)) {
                GSDSyncStateGlyph(session: session)
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Text(verbatim: session.name).lineLimit(1).truncationMode(.middle)
                    HStack(spacing: metrics.space(.xs)) {
                        Text(GSDSyncStateGlyph.label(for: session))
                        if let progress = GSDPlanningText.progress(session) {
                            Text(verbatim: "·")
                            Text(verbatim: progress)
                        }
                    }
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text(verbatim: session.root.path))
        .accessibilityIdentifier("gsdSync.row.\(session.name)")
    }

    private var webBody: some View {
        Button {
            environment.editorRequest = .gsdSyncActivity(GSDSyncActivityTarget(session))
        } label: {
            HStack(spacing: metrics.size(8)) {
                GSDSyncStateGlyph(session: session).frame(width: metrics.size(14))
                VStack(alignment: .leading, spacing: metrics.size(1)) {
                    Text(verbatim: session.name).font(
                        metrics.font(size: 12, weight: .medium)
                    ).lineLimit(1).truncationMode(.tail)
                    Group {
                        if let progress = GSDPlanningText.progress(session) {
                            Text(verbatim: progress)
                        } else {
                            Text(GSDSyncStateGlyph.label(for: session))
                        }
                    }
                    .lineLimit(1)
                    .font(metrics.font(size: 10))
                    .foregroundStyle(theme[.fgFaint])
                    .textCase(.uppercase).tracking(metrics.size(0.3))
                }
                Spacer(minLength: 0)

            }
            .padding(.horizontal, metrics.size(6))
            .padding(.vertical, metrics.size(5))
            .frame(minHeight: metrics.size(34))
            .modifier(WebGSDRowBackground())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text(verbatim: session.root.path))
        .accessibilityIdentifier("gsdSync.row.\(session.name)")
    }
}

/// Busy, error or idle, as upstream's row dot.
struct GSDSyncStateGlyph: View {
    let session: GSDSyncSession
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var pulse = false

    static func label(for session: GSDSyncSession) -> LocalizedStringKey {
        session.error != nil ? "gsdSync.state.error" : session.busy ? "gsdSync.state.busy" : "gsdSync.state.idle"
    }

    var body: some View {
        if metrics.isWebInterface && session.busy && session.error == nil {
            AletheSidebarBusyMatrix()
                .help(Text(Self.label(for: session)))
                .accessibilityLabel(Text(Self.label(for: session)))
                .accessibilityIdentifier("gsdSync.state")
        } else if metrics.isWebInterface {
            Circle().fill(theme[session.error != nil ? .statusOffline : .statusIdle])
                .frame(width: metrics.size(7), height: metrics.size(7))
                .help(Text(Self.label(for: session)))
                .accessibilityLabel(Text(Self.label(for: session)))
                .accessibilityIdentifier("gsdSync.state")
        } else { nativeDot }
    }

    private var nativeDot: some View {
        Circle()
            .fill(theme[session.error != nil ? .statusStopped : session.busy ? .statusWorking : .statusIdle])
            .frame(width: metrics.size(7), height: metrics.size(7))
            .opacity(session.busy && session.error == nil && pulse ? 0.35 : 1)
            .animation(session.busy && !metrics.reducesMotion ? .easeInOut(duration: 0.8).repeatForever() : nil, value: pulse)
            .onAppear { pulse = true }
            .help(Text(Self.label(for: session)))
            .accessibilityLabel(Text(Self.label(for: session)))
            .accessibilityIdentifier("gsdSync.state")
    }
}

/// Planning status in words (upstream `todo.gsdProgress`, `Progress:`, complete).
enum GSDPlanningText {
    static func progress(_ session: GSDSyncSession) -> String? {
        if session.planning.reportedComplete { return String(localized: "gsdSync.planning.complete") }
        if let roadmap = session.roadmapProgress { return format("gsdSync.planning.tasks", roadmap.done, roadmap.total) }
        if let percent = session.planning.progress { return format("gsdSync.planning.percent", percent) }
        return nil
    }
}

private struct WebGSDRowBackground: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .background(
                theme[.panelHover].opacity(metrics.isWebInterface && hovering ? 1 : 0),
                in: RoundedRectangle(cornerRadius: metrics.radius(.sm))
            )
            .overlay {
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.border].opacity(metrics.isWebInterface && hovering ? 1 : 0), lineWidth: metrics.size(1))
            }
            .animation(metrics.isWebInterface ? Motion.sidebarColor(reduceMotion: metrics.reducesMotion) : nil, value: hovering)
            .onHover { hovering = $0 }
    }
}
