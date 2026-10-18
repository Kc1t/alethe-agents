import AletheAgents
import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// The web "no project open" card of an empty workspace (upstream `NoWorkspace`,
/// `WorkspaceView/index.tsx` + `.emptyProjectCard` in `WorkspaceView.module.css`): pick the agent
/// and a folder, open the folder as a project and start a terminal in it.
struct WorkspaceQuickStartCard: View {
    let workspace: WorkspaceModel
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.undoManager) private var undoManager
    @State private var agent: AgentKind = .claude
    @State private var folder = ""
    @State private var graphify = false

    private var agents: [AgentKind] { AgentRegistry.builtin.enabledKinds(environment.preferences?.document.enabledAgents) }

    var body: some View {
        GeometryReader { geometry in
            let cardWidth = min(metrics.size(520), max(0, geometry.size.width - metrics.size(36)))
            let inner = max(0, cardWidth - metrics.size(44))
            let rowWidth = min(metrics.size(430), inner)
            ScrollView {
                card(rowWidth: rowWidth)
                    .padding(metrics.size(22))
                    .frame(width: cardWidth)
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .frame(maxWidth: .infinity, minHeight: max(0, geometry.size.height - metrics.size(36)))
                    .padding(metrics.size(18))
            }
            .scrollIndicators(.hidden)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace.empty")
        .onAppear {
            let last = AgentRegistry.builtin.parse(environment.preferences?.document.lastAgent)
            agent = last.flatMap { agents.contains($0) ? $0 : nil } ?? agents.first ?? .shell
        }
    }

    private func card(rowWidth: CGFloat) -> some View {
        VStack(spacing: metrics.size(12)) {
            VStack(spacing: metrics.size(6)) {
                Image(systemName: "folder.badge.plus")
                    .font(metrics.font(size: 22))
                    .foregroundStyle(theme[.accent])
                    .frame(width: metrics.size(50), height: metrics.size(50))
                    .background(theme[.accentBgSoft], in: RoundedRectangle(cornerRadius: metrics.size(15)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(15))
                        .strokeBorder(theme[.accentBorder], lineWidth: metrics.size(1)))
                    .padding(.bottom, metrics.size(4))
                Text("workspace.quickStart.title")
                    .font(metrics.font(size: 17, weight: .bold))
                    .foregroundStyle(theme[.fg])
                Text("workspace.quickStart.description")
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .lineSpacing(metrics.size(3))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: metrics.size(266))
            }
            .padding(.top, metrics.size(8))
            .padding(.horizontal, metrics.size(12))
            .padding(.bottom, metrics.size(12))
            label("workspace.quickStart.agentLabel", width: rowWidth)
            agentGrid(width: rowWidth)
            label("workspace.quickStart.folderLabel", width: rowWidth)
            folderRow(width: rowWidth)
            Button { graphify.toggle() } label: {
                HStack(spacing: metrics.size(8)) {
                    Image(systemName: graphify ? "checkmark.square.fill" : "square")
                        .font(metrics.font(size: 13))
                        .foregroundStyle(theme[graphify ? .accent : .fgMuted])
                    Text("editor.project.graphify")
                        .font(metrics.font(size: 11))
                        .foregroundStyle(theme[.fgMuted])
                    Spacer(minLength: 0)
                }
                .frame(width: rowWidth, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(graphify ? .isSelected : [])
            .accessibilityIdentifier("launcher.graphify")
            Button {
                environment.editorRequest = .newProject(.ungrouped, folder: trimmedFolder.isEmpty ? nil : trimmedFolder)
            } label: {
                Text("workspace.quickStart.useForm")
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .padding(.horizontal, metrics.size(12))
                    .frame(minHeight: metrics.size(34))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("launcher.useForm")
        }
    }

    private func label(_ key: LocalizedStringKey, width: CGFloat) -> some View {
        Text(key)
            .font(metrics.font(size: 11, weight: .semibold))
            .foregroundStyle(theme[.fgMuted])
            .frame(width: width, alignment: .leading)
    }

    private func agentGrid(width: CGFloat) -> some View {
        let gap = metrics.size(6)
        let columns = max(1, Int(((width + gap) / (metrics.size(108) + gap)).rounded(.down)))
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: gap), count: columns), spacing: gap) {
            ForEach(agents, id: \.self) { kind in
                QuickStartAgentButton(kind: kind, selected: kind == agent) { agent = kind }
            }
        }
        .frame(width: width)
    }

    private func folderRow(width: CGFloat) -> some View {
        HStack(spacing: metrics.size(8)) {
            Button(action: browse) {
                HStack(spacing: metrics.size(8)) {
                    Image(systemName: "folder")
                        .font(metrics.font(size: 14))
                        .foregroundStyle(theme[.fg])
                    Group {
                        if folder.isEmpty {
                            Text("workspace.quickStart.folderPlaceholder")
                        } else {
                            Text(verbatim: folder)
                        }
                    }
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .lineLimit(1)
                    .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, metrics.size(10))
                .frame(maxWidth: .infinity, minHeight: metrics.size(34), alignment: .leading)
                .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(Text(verbatim: folder))
            .accessibilityIdentifier("launcher.openFolder")
            let enabled = !trimmedFolder.isEmpty
            Button(action: openFolderAsProject) {
                Text("workspace.quickStart.openFolder")
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[enabled ? .accentOn : .fgMuted])
                    .padding(.horizontal, metrics.size(12))
                    .frame(minHeight: metrics.size(34))
                    .background(theme[enabled ? .accent : .panelHover], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[enabled ? .accent : .border], lineWidth: metrics.size(1)))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .accessibilityIdentifier("launcher.openFolderAction")
        }
        .frame(width: width)
    }

    private var trimmedFolder: String { folder.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func browse() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = String(localized: "sidebar.addProject.prompt")
        if !folder.isEmpty { panel.directoryURL = URL(fileURLWithPath: folder) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        folder = url.standardizedFileURL.path
    }

    /// Upstream `openFolderAsProject`: a project named after the folder, with a terminal of the
    /// chosen agent opened in its own workspace tab.
    private func openFolderAsProject() {
        let path = trimmedFolder
        guard !path.isEmpty else { return }
        let url = URL(filePath: path).standardizedFileURL
        let useGraphify = graphify
        let unrestricted = AgentRegistry.builtin.descriptor(for: agent)?.unrestrictedFlag != nil
            && (environment.preferences?.document.alwaysStartUnrestricted ?? false)
        let kind = agent
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addProject")) { doc in
            let id = doc.projects.first { URL(filePath: $0.folder).standardizedFileURL.path == url.path }?.id
                ?? doc.addProject(name: url.lastPathComponent, folder: url.path, color: .next(after: doc.projects.count))
            if useGraphify { doc.updateProject(id) { $0.graphifyEnabled = true } }
            if let pane = doc.addPane(to: id, tab: PaneTab(agent: kind.rawValue, unrestricted: unrestricted)) {
                doc.openWebPane(pane)
            } else {
                doc.openWebProject(id)
            }
        }
        environment.preferences?.update { $0.lastAgent = kind.rawValue }
    }
}

/// One agent choice of the quick-start grid (`.emptyAgentButton`).
private struct QuickStartAgentButton: View {
    let kind: AgentKind
    let selected: Bool
    let action: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    var body: some View {
        let hot = selected || hovering
        Button(action: action) {
            HStack(spacing: metrics.size(6)) {
                AgentLogo(agent: kind.rawValue, size: 15, templateColor: theme[hot ? .fg : .fgMuted])
                Text(verbatim: AgentLabels.name(for: kind.rawValue))
                    .font(metrics.font(size: 11))
                    .lineLimit(1)
            }
            .foregroundStyle(theme[hot ? .fg : .fgMuted])
            .frame(maxWidth: .infinity, minHeight: metrics.size(32))
            .background(theme[hot ? .accentBgSoft : .bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                .strokeBorder(theme[hot ? .accent : .border], lineWidth: metrics.size(1)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("launcher.agent.\(kind.rawValue)")
    }
}
