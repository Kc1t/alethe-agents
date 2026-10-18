import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// The workspace area: open projects as containers of panes (`PaneHost`), or the empty state.
struct WorkspaceView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        ZStack {
            theme[.bg].ignoresSafeArea()
            #if DEBUG
            if UserDefaults.standard.string(forKey: "AletheUITestFixture") == "hit-targets" {
                HitTargetFixture()
            } else {
                content
            }
            #else
            content
            #endif
        }
        .onChange(of: environment.workspace?.document.currentSnapshot) { _, _ in
            environment.workspace?.update { $0.syncActiveTab() }
        }
        .onChange(of: allTabIDs) { _, tabs in environment.terminals.prune(keeping: tabs) }
        // Looking at a tab reads its completion (upstream clears `completionUnread` on focus).
        .onChange(of: frontTab) { _, tab in if let tab { environment.terminals.markRead(tab) } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if let frontTab { environment.terminals.markRead(frontTab) }
        }
        .onChange(of: environment.workspace?.document.disabledTabIDs ?? []) { _, tabs in
            for tab in tabs { environment.terminals.suspend(tab) }
        }
        .onChange(of: allPaneIDs) { _, panes in
            environment.contentPanes.prune(keeping: panes)
            if let focus = environment.focusModePaneID, !panes.contains(focus) { environment.focusModePaneID = nil }
        }
        // A terminal opened from Home (its sheets, the quick launch) shows the workspace.
        .onChange(of: environment.workspace?.document.workspace.focusedPaneID) { _, pane in
            if pane != nil { environment.showingHome = false }
        }
        .onChange(of: environment.theme) { _, _ in applyAppearance() }
        .onChange(of: environment.terminalFontSize) { _, _ in applyAppearance() }
    }

    private var content: some View {
        VStack(spacing: 0) {
            if environment.showingHome, let workspace = environment.workspace {
                HomeView(workspace: workspace)
            } else {
                workspaceContent
            }
        }
    }

    private var workspaceContent: some View {
        VStack(spacing: 0) {
            if !metrics.isWebInterface, let workspace = environment.workspace, !workspace.document.workspace.tabs.isEmpty {
                WorkspaceTabBar(workspace: workspace)
            }
            if let doc = environment.workspace?.document, !doc.workspace.openProjectIDs.isEmpty,
               !metrics.isWebInterface || doc.workspace.openProjectIDs.contains(where: {
                   !(doc.project($0)?.visiblePanes.isEmpty ?? true)
               }) || doc.activeWorkspaceTab?.webPaneID != nil {
                PaneHost(document: doc, terminalStates: environment.terminals.states,
                         terminalGenerations: environment.terminals.generations,
                         focusModePane: environment.focusModePaneID)
            } else if metrics.isWebInterface, emptyGroupID == nil, emptyProject == nil, let workspace = environment.workspace {
                // Upstream `NoWorkspace` without a project: the quick-start card.
                WorkspaceQuickStartCard(workspace: workspace)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if metrics.isWebInterface {
                webEmptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let workspace = environment.workspace {
                WorkspaceLauncher(workspace: workspace)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var emptyProject: Project? {
        guard let document = environment.workspace?.document else { return nil }
        return document.workspace.selectedProjectID.flatMap(document.project) ?? document.projects.first
    }

    /// The group whose (empty) composition tab is active.
    private var emptyGroupID: GroupID? { environment.workspace?.document.activeWorkspaceTab?.webGroupID }

    private var emptyGroup: ProjectGroup? {
        guard let id = emptyGroupID else { return nil }
        return environment.workspace?.document.groups.first { $0.id == id }
    }

    /// Upstream `NoWorkspace` group branch: open the group, new project in it, Find/Jump.
    private func groupActions(_ group: ProjectGroup) -> some View {
        let document = environment.workspace?.document
        let members = Set((document?.groups ?? []).filter { document?.isGroup($0.id, inside: group.id) == true }.flatMap(\.projectIDs))
        let hasPanes = document?.projects.contains { members.contains($0.id) && !$0.panes.isEmpty } ?? false
        return Group {
            if hasPanes {
                webEmptyAction("workspace.webEmpty.openGroup", shortcut: nil, id: "launcher.openGroup") {
                    environment.workspace?.update { $0.openWebGroup(group.id, adding: false) }
                }
            }
            webEmptyAction("workspace.webEmpty.newProject", shortcut: "⌘⇧P", id: "launcher.newProject") {
                environment.editorRequest = .newProject(.group(group.id))
            }
            webEmptyAction("workspace.webEmpty.findJump", shortcut: "⌘P", id: "launcher.findJump") {
                environment.editorRequest = .findJump
            }
        }
    }

    private var webEmptyState: some View {
        GeometryReader { geometry in
            let viewportWidth = (NSApp.keyWindow?.frame.width ?? geometry.size.width) / metrics.scale
            let markSide: CGFloat = viewportWidth <= 520 ? 104 : min(190, max(112, viewportWidth * 0.18))
            let contentWidth = max(0, min(metrics.size(360), geometry.size.width - metrics.size(68)))
            let availableMarkSide = min(metrics.size(markSide), contentWidth,
                                        max(0, geometry.size.height - metrics.size(140)))
            VStack(spacing: metrics.size(viewportWidth <= 520 ? 16 : 24)) {
                Image("WorkspaceKnight")
                    .renderingMode(.template)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(theme[.fg])
                    .opacity(0.045)
                    .frame(width: availableMarkSide, height: availableMarkSide)
                    .accessibilityHidden(true)
                VStack(spacing: metrics.size(2)) {
                    if let group = emptyGroup {
                        groupActions(group)
                    } else if let project = emptyProject, !project.panes.isEmpty {
                        webEmptyAction("workspace.webEmpty.openPanes", shortcut: nil, id: "launcher.open") {
                            environment.workspace?.update { $0.openInTab(project.id) }
                        }
                    }
                    webEmptyAction("workspace.webEmpty.newTerminal", shortcut: "⌘T", id: "launcher.newTerminal") {
                        environment.editorRequest = .newTerminal(emptyProject?.id)
                    }
                    webEmptyAction("workspace.webEmpty.addContent", shortcut: "⌘⇧A", id: "launcher.addContent") {
                        environment.editorRequest = .addContent(emptyProject?.id)
                    }
                }
                .frame(maxWidth: metrics.size(280))
            }
            .frame(width: contentWidth)
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace.empty")
    }

    private func webEmptyAction(_ title: LocalizedStringKey, shortcut: String?, id: String,
                                action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: metrics.size(18)) {
                Text(title).font(metrics.font(size: 12))
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                if let shortcut {
                    Text(verbatim: shortcut)
                        .font(metrics.monoFont(size: 10))
                        .padding(.horizontal, metrics.size(5))
                        .frame(minWidth: metrics.size(18), minHeight: metrics.size(18))
                        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(3)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(3))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .overlay(alignment: .bottom) { theme[.borderStrong].frame(height: metrics.size(1)) }
                        .fixedSize()
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, metrics.size(4))
            .padding(.vertical, metrics.size(2))
            .frame(minHeight: metrics.size(26))
        }
        .buttonStyle(AletheWorkspaceActionStyle())
        .accessibilityIdentifier(id)
    }

    private var frontTab: TabID? {
        guard let document = environment.workspace?.document, let pane = document.workspace.focusedPaneID else { return nil }
        return document.pane(pane)?.pane.activeTab?.id
    }

    private var allTabIDs: Set<TabID> {
        Set(environment.workspace?.document.projects.flatMap { $0.panes.flatMap { $0.tabs.map(\.id) } } ?? [])
    }

    private var allPaneIDs: Set<PaneID> {
        Set(environment.workspace?.document.projects.flatMap { $0.panes.map(\.id) } ?? [])
    }

    private func applyAppearance() {
        environment.terminals.applyAppearance(theme: environment.theme, fontSize: environment.terminalFontSize)
    }

    private var emptyState: some View {
        VStack(spacing: metrics.space(.m)) {
            Text("workspace.empty.title")
                .font(metrics.font(.title2))
                .foregroundStyle(theme[.textPrimary])
            Text("workspace.empty.message")
                .font(metrics.font(.body))
                .foregroundStyle(theme[.textSecondary])
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: metrics.size(420))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workspace.empty")
    }
}

/// Opens the new-terminal sheet for a project.
struct NewTerminalButton: View {
    let project: Project
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        Button("terminal.new") { environment.editorRequest = .newTerminal(project.id) }
            .accessibilityIdentifier("terminal.new")
    }
}
