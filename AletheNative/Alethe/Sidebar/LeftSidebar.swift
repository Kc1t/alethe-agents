import AletheDesign
import AletheGitControl
import AletheModel
import AlethePluginKit
import SwiftUI

/// Window sidebar shell; project rows and their actions remain owned by SidebarView.
struct LeftSidebar: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @SceneStorage("main.leftSidebarTab") private var selectedTab = "projects"

    private var pluginTabs: [SidebarTabContribution] {
        guard let plugins = environment.plugins else { return [] }
        return plugins.viewPlacements.arranged(plugins.contributions.sidebarTabs).left
    }

    private var selectedProject: Project? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)
        }
    }

    private var effectiveTab: String {
        (metrics.isWebInterface && selectedTab == "git") || selectedTab == "files" || pluginTabs.contains(where: { $0.id == selectedTab }) ? selectedTab : "projects"
    }

    @ViewBuilder var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: metrics.space(.xxs)) {
                    Button { environment.toggleHome() } label: {
                        Label { Text("leftSidebar.home") } icon: { Image(systemName: "house").webProfileSized(14) }
                    }
                    .buttonStyle(.plain)
                    .font(metrics.font(.caption))
                    .padding(metrics.space(.s))
                    .aletheRowBackground(isSelected: environment.showingHome)
                    .help(Text("leftSidebar.home"))
                    .accessibilityIdentifier("leftSidebar.home")
                    tabButton("projects", title: "leftSidebar.projects", symbol: "square.grid.3x3")
                    tabButton("files", title: "rightSidebar.files", symbol: "folder")
                    ForEach(pluginTabs, id: \.id) { tab in
                        tabButton(tab.id, title: PluginViewRegistry.title(for: tab), symbol: tab.symbol)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .padding(metrics.space(.s))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("leftSidebar.navigation"))

            Button { environment.editorRequest = .findJump } label: {
                Label { Text("leftSidebar.search") } icon: { Image(systemName: "magnifyingglass").webProfileSized(14) }
                    .font(metrics.font(.body))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(metrics.space(.s))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme[.fgMuted])
            .disabled(environment.workspace == nil)
            .accessibilityIdentifier("leftSidebar.search")
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .font(metrics.font(.body))
        .foregroundStyle(theme[.fg])
    }

    private var webBody: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: metrics.size(4)) {
                    Button { selectedTab = "projects"; environment.showingHome = true } label: {
                        Label { Text("leftSidebar.home") } icon: { Image(systemName: "house").webProfileSized(14) }
                    }
                    .buttonStyle(AletheSidebarMotionTabStyle(isSelected: environment.showingHome))
                    .help(Text("leftSidebar.home"))
                    .accessibilityIdentifier("leftSidebar.home")
                    webTab("projects", title: "leftSidebar.projects", symbol: "square.grid.3x3")
                    webTab("files", title: "rightSidebar.files", symbol: "folder")
                    webTab("git", title: "menu.git.control", symbol: "arrow.triangle.branch")
                    ForEach(pluginTabs, id: \.id) { tab in
                        webTab(tab.id, title: PluginViewRegistry.title(for: tab), symbol: tab.symbol)
                    }
                }
                .padding(.horizontal, metrics.size(10))
            }
            .scrollIndicators(.hidden)
            .frame(height: metrics.size(34))
            .overlay(alignment: .bottom) { rule }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("leftSidebar.navigation"))
            Button { environment.editorRequest = .findJump } label: {
                HStack(spacing: metrics.size(10)) {
                    Image(systemName: "magnifyingglass").webProfileSized(15)
                        .font(metrics.font(size: 15))
                        .foregroundStyle(theme[.textTertiary])
                    Text("leftSidebar.search").font(metrics.font(size: 13, weight: .medium))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(AletheSidebarSearchStyle())
            .disabled(environment.workspace == nil)
            .accessibilityIdentifier("leftSidebar.search")
            .help(Text("leftSidebar.search"))
            .padding(.horizontal, metrics.size(8))
            .frame(height: metrics.size(40))
            .overlay(alignment: .bottom) { rule }
            if let id = environment.inspectedPaneID, let workspace = environment.workspace,
               let (project, pane) = workspace.document.pane(id) {
                ScrollView { TerminalInspector(workspace: workspace, pane: pane, project: project) }
                    .webScrollStyle()
                    .frame(maxHeight: metrics.size(420))
            }
            webContent
                .modifier(SidebarPanelMotion(identity: effectiveTab))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme[.bg])
            webFooter
                .contextMenu {
                    Button("layoutDesigner.web.workspaceTitle") { environment.editorRequest = .layoutDesigner(.workspace) }
                        .accessibilityIdentifier("layoutDesigner.workspace")
                }
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
        }
        .foregroundStyle(theme[.fg])
        .background(theme[.bg])
        .onChange(of: environment.showingHome) { _, showing in
            if showing { selectedTab = "projects" }
        }
        .onAppear { if environment.showingHome { selectedTab = "projects" } }
    }

    private var rule: some View {
        Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
    }

    private func webTab(_ id: String, title: LocalizedStringKey, symbol: String) -> some View {
        Button {
            selectedTab = id
            if metrics.style == .clean { environment.showingHome = false }
        } label: { Label { Text(title) } icon: { Image(systemName: symbol).webProfileSized(14) } }
        .buttonStyle(AletheSidebarMotionTabStyle(isSelected: effectiveTab == id && !environment.showingHome))
        .help(Text(title))
        .accessibilityIdentifier("leftSidebar.tab.\(id)")
        .accessibilityAddTraits(effectiveTab == id && !environment.showingHome ? .isSelected : [])
    }

    // Home and the sidebar tab are independent in NormalProjectSidebar.tsx.
    @ViewBuilder private var webContent: some View {
        if effectiveTab == "git", let workspace = environment.workspace {
            GitControlSheet(workspace: workspace, undoManager: nil, projectID: selectedProject?.id, embedded: true)
                .id(selectedProject?.id)
        } else if effectiveTab == "files" {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: metrics.size(8)) {
                    AletheSectionLabel(Text("leftSidebar.explorer"))
                    Spacer(minLength: 0)
                    Image(systemName: "ellipsis").webProfileSized(14)
                        .font(metrics.font(size: 14))
                        .foregroundStyle(theme[.fgMuted])
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, metrics.size(12))
                .frame(height: metrics.size(34))
                .background(theme[.bg])
                .overlay(alignment: .bottom) { rule }
                if selectedProject != nil {
                    FilesView()
                        .scrollContentBackground(.hidden)
                        .background(theme[.bg])
                } else {
                    ScrollView { SidebarWebEmptyState() }
                }
            }
            .background(theme[.bg])
        } else { content }
    }

    private var webFooter: some View {
        VStack(spacing: 0) {
            if let project = selectedProject, project.panes.count >= 2 {
                HStack(spacing: metrics.size(8)) {
                    ViewThatFits(in: .horizontal) {
                        Text("leftSidebar.organization")
                            .textCase(.uppercase)
                            .font(metrics.font(size: 10, weight: .semibold))
                            .tracking(metrics.size(0.6))
                            .foregroundStyle(theme[.fgFaint])
                            .fixedSize()
                        theme[.bg].opacity(0).frame(width: metrics.size(0), height: metrics.size(0))
                    }
                    Spacer(minLength: 0)
                    HStack(spacing: metrics.size(metrics.style == .clean ? 1 : 2)) {
                        ForEach(PaneLayoutMode.allCases, id: \.self) { mode in
                            Button { environment.workspace?.update { $0.setLayoutMode(mode, for: project.id) } } label: {
                                Label { Text(mode.title) } icon: { Image(systemName: mode.symbol).webProfileSized(14) }
                            }
                            .buttonStyle(AletheSidebarSizeLayoutStyle(isSelected: project.layout == mode))
                            .help(Text(mode.title))
                            .accessibilityIdentifier("leftSidebar.layout.\(mode.rawValue)")
                            .accessibilityAddTraits(project.layout == mode ? .isSelected : [])
                        }
                    }
                    .fixedSize()
                    .padding(metrics.size(metrics.style == .clean ? 0 : 2))
                    .background(theme[.bgElevated].opacity(metrics.style == .clean ? 0 : 1),
                                in: RoundedRectangle(cornerRadius: metrics.style == .clean ? 0 : metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.border].opacity(metrics.style == .clean ? 0 : 1), lineWidth: metrics.size(1)))
                }
                .padding(.horizontal, metrics.size(metrics.style == .clean ? 10 : 12))
                .padding(.top, metrics.size(metrics.style == .clean ? 4 : 8))
                .padding(.bottom, metrics.size(metrics.style == .clean ? 4 : 10))
                .frame(minHeight: metrics.style == .clean ? metrics.size(40) : nil)
                .overlay(alignment: .top) { rule }
            }
            SidebarNowPlaying()
            SidebarUpdateChip()
            SidebarWebProfile()
        }
    }

    private func tabButton(_ id: String, title: LocalizedStringKey, symbol: String) -> some View {
        Button {
            selectedTab = id
            environment.showingHome = false
        } label: {
            Label { Text(title) } icon: { Image(systemName: symbol).webProfileSized(14) }
        }
        .buttonStyle(.plain)
        .font(metrics.font(.caption))
        .padding(metrics.space(.s))
        .aletheRowBackground(isSelected: effectiveTab == id)
        .help(Text(title))
        .accessibilityIdentifier("leftSidebar.tab.\(id)")
        .accessibilityAddTraits(effectiveTab == id ? .isSelected : [])
    }

    @ViewBuilder private var content: some View {
        if effectiveTab == "projects" {
            SidebarView()
        } else if effectiveTab == "files" {
            VStack(alignment: .leading, spacing: 0) {
                AletheSectionLabel(Text("leftSidebar.explorer"))
                    .padding(metrics.space(.s))
                if selectedProject != nil {
                    FilesView()
                } else {
                    ContentUnavailableView {
                        Label { Text("leftSidebar.emptyTitle") } icon: { Image(systemName: "folder.badge.plus").webProfileSized(14) }
                    } description: {
                        Text("leftSidebar.emptyDescription")
                    } actions: {
                        Button("leftSidebar.emptyAction") { environment.editorRequest = .newProject(.ungrouped) }
                            .buttonStyle(AletheButtonStyle())
                            .disabled(environment.workspace == nil)
                    }
                }
            }
        } else if let tab = pluginTabs.first(where: { $0.id == effectiveTab }) {
            VStack(alignment: .leading, spacing: 0) {
                AletheSectionLabel(Text(PluginViewRegistry.title(for: tab)))
                    .padding(metrics.space(.s))
                PluginViewRegistry.view(for: tab.viewID)
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            if let project = selectedProject, project.panes.count >= 2 {
                HStack(spacing: metrics.space(.xs)) {
                    Text("leftSidebar.organization")
                        .font(metrics.font(.caption))
                    Spacer(minLength: 0)
                    ForEach(PaneLayoutMode.allCases, id: \.self) { mode in
                        Button {
                            environment.workspace?.update { $0.setLayoutMode(mode, for: project.id) }
                        } label: {
                            Label { Text(mode.title) } icon: { Image(systemName: mode.symbol).webProfileSized(14) }
                        }
                        .buttonStyle(AletheIconButtonStyle(side: 24, isOn: project.layout == mode))
                        .help(Text(mode.title))
                        .accessibilityIdentifier("leftSidebar.layout.\(mode.rawValue)")
                        .accessibilityAddTraits(project.layout == mode ? .isSelected : [])
                    }
                }
                .padding(metrics.space(.s))
            }
            SidebarNowPlaying()
            ProfileToolbarMenu(sidebar: true)
        }
    }
}
