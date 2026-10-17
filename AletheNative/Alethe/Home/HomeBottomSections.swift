import AletheAgents
import AletheDesign
import AletheModel
import SwiftUI

/// HomeView.module.css's overviewGrid, including its pane-relative breakpoints.
struct WebHomeOverview: View {
    let workspace: WorkspaceModel
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var width: CGFloat = 0

    private var recent: [Project] {
        workspace.document.recentProjectIDs(limit: 6).compactMap(workspace.document.project)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(20)) {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                HStack {
                    HomeSectionHeader(title: "home.recent", count: recent.isEmpty ? nil : recent.count)
                    Spacer(minLength: 0)
                    if !recent.isEmpty {
                        Button("home.recent.viewAll") { environment.showingHome = false }
                            .buttonStyle(HomeSectionActionStyle())
                            .accessibilityIdentifier("home.action.findJump")
                    }
                }
                if recent.isEmpty {
                    VStack(spacing: metrics.size(14)) {
                        Image(systemName: "folder.badge.plus").webProfileSized(22)
                            .foregroundStyle(theme[.accent])
                            .frame(width: metrics.size(56), height: metrics.size(56))
                            .background(theme[.accentSoft], in: RoundedRectangle(cornerRadius: metrics.size(18)))
                            .overlay(RoundedRectangle(cornerRadius: metrics.size(18))
                                .strokeBorder(theme[.accentBorder], lineWidth: metrics.size(1)))
                        VStack(spacing: metrics.size(6)) {
                            Text("home.bottom.projectsEmptyTitle").font(metrics.font(size: 18, weight: .semibold))
                                .tracking(metrics.size(-0.36))
                            Text("home.bottom.projectsEmptyDetail").font(metrics.font(size: 13))
                                .foregroundStyle(theme[.fgMuted]).multilineTextAlignment(.center)
                        }
                        Button("home.bottom.projectsEmptyAction") { environment.editorRequest = .newProject(.ungrouped) }
                            .buttonStyle(HomeEmptyProjectStyle())
                    }
                    .frame(maxWidth: .infinity).padding(.horizontal, metrics.size(22)).padding(.vertical, metrics.size(28))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                } else {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: metrics.size(8)),
                                             count: width <= metrics.size(620) ? 1 : 2), spacing: metrics.size(5)) {
                        ForEach(recent) { project in
                            WebHomeProjectCard(project: project, lastUsed: lastUsed(project.id)) {
                                workspace.update { $0.openInTab(project.id) }
                                environment.showingHome = false
                            }
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                HomeSectionHeader(title: "home.start")
                LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(150)), spacing: metrics.size(8))], spacing: metrics.size(8)) {
                    action("home.web.newTerminal", symbol: "terminal", shortcut: "⌘T", id: "home.action.newTerminal") {
                        environment.editorRequest = workspace.document.projects.isEmpty ? .newProject(.ungrouped) : .newTerminal(nil)
                    }
                    action("home.web.newProject", symbol: "folder.badge.plus", shortcut: "⇧⌘P", id: "home.action.newProject") {
                        environment.editorRequest = .newProject(.ungrouped)
                    }
                    action("home.web.newGroup", symbol: "square.3.layers.3d", shortcut: "⇧⌘G", id: "home.action.newGroup") {
                        environment.editorRequest = .newGroup(parent: nil)
                    }
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func lastUsed(_ id: ProjectID) -> Date? {
        let history = workspace.document.workspace.history.filter {
            $0.snapshot.selectedProjectID == id || $0.snapshot.openProjectIDs.contains(id)
        }.map(\.visitedAt)
        let tabs = workspace.document.workspace.tabs.filter {
            $0.projectID == id || $0.snapshot.openProjectIDs.contains(id)
        }.map(\.updatedAt)
        return (history + tabs).max()
    }

    private func action(_ title: LocalizedStringKey, symbol: String, shortcut: String, id: String,
                        perform: @escaping () -> Void) -> some View {
        WebHomeActionCard(title: title, symbol: symbol, shortcut: shortcut, action: perform)
            .accessibilityIdentifier(id)
    }

}

private struct WebHomeProjectCard: View {
    let project: Project
    let lastUsed: Date?
    let open: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovered = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: metrics.size(9)) {
                SidebarCoverImage(source: project.iconUrl ?? "", side: 34) {
                    Text(verbatim: project.name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "·")
                        .font(metrics.font(size: 15, weight: .semibold)).foregroundStyle(theme[.accentOn])
                        .frame(width: metrics.size(34), height: metrics.size(34))
                        .background(theme[project.color.token], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                }
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(verbatim: project.name).font(metrics.font(size: 11, weight: .semibold))
                        .lineLimit(1).help(Text(verbatim: project.name))
                    TimelineView(.everyMinute) { _ in
                        let count = project.panes.filter { $0.content.isTerminal }.count
                        HStack(spacing: metrics.size(2)) {
                            Text(String(format: String(localized: count == 1 ? "home.web.oneTerminal" : "home.recent.terminals"), count))
                            if let lastUsed {
                                Text(verbatim: "·")
                                Text(lastUsed, format: .relative(presentation: .named))
                            }
                        }
                        .font(metrics.monoFont(size: 9)).foregroundStyle(theme[.textQuaternary]).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "arrow.right").webProfileSized(12)
                    .foregroundStyle(theme[hovered ? .fgMuted : .textQuaternary])
                    .offset(x: hovered && !metrics.reducesMotion && metrics.style != .clean ? metrics.size(2) : 0)
            }
        }
        .buttonStyle(HomeBottomCardStyle(project: true))
        .onHover { hovered = $0 }
        .animation(metrics.reducesMotion ? nil : Motion.animation(Motion.quick, reduceMotion: false), value: hovered)
        .accessibilityIdentifier("home.recent.\(project.name)")
    }
}

/// Local controls keep the shared Components.swift untouched.
struct HomeBottomCardStyle: ButtonStyle {
    var project = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var enabled
    @State private var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(theme[.fg])
            .padding(.horizontal, metrics.size(project ? 10 : 14))
            .padding(.vertical, metrics.size(project ? 7 : 12))
            .frame(maxWidth: .infinity, minHeight: metrics.size(44), alignment: .leading)
            .background(theme[hovered || configuration.isPressed ? .bgElevated : .bgSunken]
                .opacity(hovered ? (project ? 0.92 : 1) : 0.86),
                in: RoundedRectangle(cornerRadius: metrics.radius(project ? .sm : .md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(project ? .sm : .md))
                .strokeBorder(theme[hovered || configuration.isPressed ? .borderStrong : .border]
                    .opacity(project && !hovered ? 0.82 : 1), lineWidth: metrics.size(1)))
            .contentShape(Rectangle()).opacity(enabled ? 1 : 0.5)
            .onHover { hovered = $0 }
            .animation(metrics.reducesMotion ? nil : Motion.animation(Motion.quick, reduceMotion: false), value: hovered)
    }
}

private struct HomeSectionActionStyle: ButtonStyle {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.textCase(.uppercase).font(metrics.font(size: 10))
            .tracking(metrics.size(0.6)).foregroundStyle(theme[hovered ? .fgMuted : .textQuaternary])
            .onHover { hovered = $0 }
    }
}

private struct WebHomeActionCard: View {
    let title: LocalizedStringKey
    let symbol: String
    let shortcut: String
    let action: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var width: CGFloat = 0

    var body: some View {
        Button(action: action) {
            HStack(spacing: metrics.size(12)) {
                Image(systemName: symbol).webProfileSized(14).foregroundStyle(theme[.fgFaint])
                Text(title).font(metrics.font(size: 12)).lineLimit(1)
                Spacer(minLength: 0)
                if width > metrics.size(214) {
                    Text(verbatim: shortcut).font(metrics.monoFont(size: 10))
                        .foregroundStyle(theme[.textTertiary])
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(4))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                }
            }
        }
        .buttonStyle(HomeBottomCardStyle())
        .onGeometryChange(for: CGFloat.self) { max(0, $0.size.width - metrics.size(28)) } action: { width = $0 }
    }
}

private struct HomeEmptyProjectStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(metrics.font(size: 13, weight: .semibold))
            .foregroundStyle(theme[.accentOn]).padding(.horizontal, metrics.size(14))
            .frame(minHeight: metrics.size(36))
            .background(theme[hovered ? .accentStrong : .accent],
                        in: RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.radius(.sm) : metrics.size(12)))
            .offset(y: hovered && !metrics.reducesMotion && metrics.style != .clean ? -metrics.size(1) : 0)
            .onHover { hovered = $0 }
            .animation(metrics.reducesMotion ? nil : Motion.animation(Motion.quick, reduceMotion: false), value: hovered)
    }
}
