import AletheDesign
import AletheFiles
import AletheFoundation
import AletheGit
import AletheModel
import AlethePluginKit
import AppKit
import AVKit
import PDFKit
import Quartz
import SwiftUI

/// File explorer for the selected project's folder (P4-8): lazy tree, git badges, live refresh.
struct FilesView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    static let tabID = "files"
    static let tab = SidebarTabContribution(id: tabID, title: "Files", symbol: "folder", side: .right, viewID: tabID)

    private var project: Project? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)
        }
    }

    var body: some View {
        if let project {
            FileTreeList(project: project).id(project.folder)
        } else if metrics.isWebInterface {
            WebSidebarEmpty(title: "docs.noProject", symbol: "folder")
        } else {
            ContentUnavailableView("docs.noProject", systemImage: "folder")
        }
    }
}

private struct FileTreeList: View {
    let project: Project
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var rootExpanded = true
    @State private var hoveredFile: URL?
    @State private var tree: FileTree
    @State private var renaming: URL?
    @State private var draftName = ""
    @State private var pendingDelete: URL?
    @State private var errorMessage: String? { didSet { if errorMessage != oldValue { AppLog.shown(errorMessage, .app) } } }
    @State private var previewURL: URL?
    @State private var selection: URL?
    @FocusState private var renameFocused: Bool

    init(project: Project) {
        self.project = project
        _tree = State(initialValue: FileTree(root: URL(filePath: project.folder, directoryHint: .isDirectory)))
    }

    var body: some View {
        Group {
            if metrics.isWebInterface { webTree } else {
        List(selection: $selection) {
            ForEach(tree.visibleRows()) { row in
                rowView(row)
                    .tag(row.node.url)
                    .contextMenu { menu(for: row.node) }
            }
        }
        .listStyle(.sidebar)
        .contextMenu { createMenu(in: tree.root) }
        .onKeyPress(.space) {
            guard renaming == nil, let selection else { return .ignored }
            preview(selection)
            return .handled
        }
        .overlay {
            if tree.rootNodes.isEmpty { ContentUnavailableView("files.empty", systemImage: "folder") }
        }
            }
        }
        .gitWebSheet(isPresented: Binding(get: { previewURL != nil }, set: { if !$0 { previewURL = nil } }), width: 760) {
            if let url = previewURL {
                SidebarFilePreview(url: url, close: { previewURL = nil }, add: {
                    if let node = tree.visibleRows().first(where: { $0.node.url == url })?.node { open(node) }
                    previewURL = nil
                }, markdown: { openMarkdown(url); previewURL = nil })
            }
        }
        .task { await follow() }
        .confirmationDialog("files.deletePermanently.title", isPresented: deleteBinding, presenting: pendingDelete) { url in
            Button("files.deletePermanently", role: .destructive) { deletePermanently(url) }
        } message: { url in
            Text(verbatim: String(format: String(localized: "files.deletePermanently.message"), url.lastPathComponent))
        }
        .alert("files.error", isPresented: errorBinding) {
            Button("files.ok") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var webTree: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                HStack(spacing: metrics.size(5)) {
                    Text(verbatim: project.name).font(metrics.font(size: 11, weight: 650)).lineLimit(1)
                    Text(verbatim: project.folder).font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Button { NSWorkspace.shared.activateFileViewerSelecting([tree.root]) } label: {
                        Label("files.revealInFinder", systemImage: "folder.badge.magnifyingglass").font(metrics.font(size: 13))
                    }.help(Text("files.revealInFinder"))
                    Button { attempt { try tree.reload() } } label: {
                        Label("rightSidebar.files.refresh", systemImage: "arrow.clockwise").font(metrics.font(size: 13))
                    }.help(Text("rightSidebar.files.refresh"))
                }
                .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 24, height: 24))
                .padding(.leading, metrics.size(12)).padding(.trailing, metrics.size(8)).frame(height: metrics.size(38))
                .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
                .help(project.folder)
                Button { rootExpanded.toggle() } label: {
                    HStack(spacing: metrics.size(6)) {
                        Image(systemName: rootExpanded ? "chevron.down" : "chevron.right").resizable().scaledToFit()
                            .frame(width: metrics.size(13), height: metrics.size(13)).foregroundStyle(theme[.fgFaint])
                        Image(systemName: "folder").resizable().scaledToFit()
                            .frame(width: metrics.size(14), height: metrics.size(14)).foregroundStyle(theme[.fgMuted])
                        Text(verbatim: tree.root.lastPathComponent.uppercased()).font(metrics.font(size: 11, weight: .bold)).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, metrics.size(8)).padding(.trailing, metrics.size(8)).frame(height: metrics.size(28))
                    .contentShape(Rectangle())
                }.buttonStyle(.plain).modifier(WebFileHover())
                if rootExpanded {
                    ForEach(tree.visibleRows()) { row in
                        webRow(row).contextMenu { webMenu(for: row.node) }
                    }
                    if tree.rootNodes.isEmpty {
                        Text("files.empty").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                            .padding(.leading, metrics.size(36)).padding(.trailing, metrics.size(12)).padding(.vertical, metrics.size(8))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .foregroundStyle(theme[.fg]).background(theme[.bg])
        .focusable()
        .onKeyPress(.upArrow) {
            guard renaming == nil else { return .ignored }
            moveSelection(-1); return .handled
        }
        .onKeyPress(.downArrow) {
            guard renaming == nil else { return .ignored }
            moveSelection(1); return .handled
        }
        .onKeyPress(.rightArrow) { setExpanded(true) }
        .onKeyPress(.leftArrow) { setExpanded(false) }
        .onKeyPress(.return) {
            guard renaming == nil, let node = tree.visibleRows().first(where: { $0.node.url == selection })?.node else { return .ignored }
            activate(node); return .handled
        }
        .onKeyPress(.space) {
            guard renaming == nil, let selection else { return .ignored }
            preview(selection); return .handled
        }
    }

    private func setExpanded(_ expanded: Bool) -> KeyPress.Result {
        guard renaming == nil, let row = tree.visibleRows().first(where: { $0.node.url == selection }),
              row.node.isDirectory else { return .ignored }
        if row.isExpanded != expanded { attempt { try tree.toggle(row.node.url) } }
        return .handled
    }

    private func moveSelection(_ offset: Int) {
        guard renaming == nil else { return }
        let rows = tree.visibleRows()
        guard !rows.isEmpty else { return }
        let index = rows.firstIndex { $0.node.url == selection } ?? (offset > 0 ? -1 : rows.count)
        selection = rows[min(max(0, index + offset), rows.count - 1)].node.url
    }

    private func webRow(_ row: FileTreeRow) -> some View {
        let node = row.node
        return HStack(spacing: metrics.size(6)) {
            if node.isDirectory {
                Image(systemName: row.isExpanded ? "chevron.down" : "chevron.right").resizable().scaledToFit()
                    .frame(width: metrics.size(13), height: metrics.size(13)).foregroundStyle(theme[.fgFaint])
            }
            Image(systemName: node.iconName).resizable().scaledToFit()
                .frame(width: metrics.size(node.isDirectory ? 14 : 13), height: metrics.size(node.isDirectory ? 14 : 13))
                .foregroundStyle(theme[.fgMuted])
            if renaming == node.url {
                TextField("files.name", text: $draftName).textFieldStyle(.plain).focused($renameFocused)
                    .onSubmit { commitRename(node.url) }.onExitCommand { renaming = nil }.onAppear { renameFocused = true }
            } else {
                Text(verbatim: node.name).lineLimit(1).truncationMode(.tail)
                    .foregroundStyle(webBadgeColor(tree.badge(for: node)) ?? theme[.fgMuted])
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !node.isDirectory && hoveredFile == node.url {
                HStack(spacing: metrics.size(2)) {
                    Button { open(node) } label: {
                        Label("rightSidebar.files.addToGrid", systemImage: "square.grid.2x2").font(metrics.font(size: 12))
                    }.help(Text("rightSidebar.files.addToGrid"))
                    Button { preview(node.url) } label: {
                        Label("rightSidebar.files.preview", systemImage: "eye").font(metrics.font(size: 12))
                    }.help(Text("rightSidebar.files.preview"))
                    if ["md", "markdown"].contains(node.url.pathExtension.lowercased()) {
                        Button { openMarkdown(node.url) } label: {
                            Label("rightSidebar.files.openMarkdown", systemImage: "sidebar.right").font(metrics.font(size: 12))
                        }.help(Text("rightSidebar.files.openMarkdown"))
                    }
                }.buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 20, height: 20))
            }
            if let badge = tree.badge(for: node) {
                if node.isDirectory {
                    Circle().fill(webBadgeColor(badge) ?? theme[.fgMuted]).frame(width: metrics.size(6), height: metrics.size(6))
                        .padding(.trailing, metrics.size(4))
                } else {
                    Text(verbatim: badge.letter).font(metrics.monoFont(size: 11, weight: .bold))
                        .foregroundStyle(webBadgeColor(badge) ?? theme[.fgMuted]).frame(width: metrics.size(16))
                }
            }
        }
        .font(metrics.font(size: 12))
        .padding(.leading, metrics.size(22 + CGFloat(row.depth) * 14))
        .padding(.trailing, metrics.size(8)).frame(height: metrics.size(24))
        .contentShape(Rectangle()).modifier(WebFileHover())
        .overlay { Rectangle().strokeBorder(theme[.accent].opacity(selection == node.url ? 1 : 0), lineWidth: metrics.size(1)) }
        .onTapGesture(count: 2) { if !node.isDirectory { open(node) } }
        .onTapGesture {
            selection = node.url
            if node.isDirectory { attempt { try tree.toggle(node.url) } }
            else { preview(node.url) }
        }
        .modifier(WebFileDrag(url: node.url, enabled: !node.isDirectory))
        .onHover { hoveredFile = $0 ? node.url : hoveredFile == node.url ? nil : hoveredFile }
        .help(node.url.path)
    }

    private func preview(_ url: URL) {
        if metrics.isWebInterface { previewURL = url }
        else { QuickLook.shared.show(url) }
    }

    private func openMarkdown(_ url: URL) {
        NotificationCenter.default.post(name: .sidebarOpenMarkdown, object: url)
        environment.rightSidebarTab = DocsView.tabID
        environment.rightSidebarVisible = true
    }

    private func webBadgeColor(_ badge: GitBadge?) -> Color? {
        switch badge {
        case .conflict?, .deleted?: theme[.statusOffline]
        case .modified?, .stagedModified?: theme[.statusWaiting]
        case .renamed?: theme[.agentCodex]
        case .added?, .untracked?: theme[.statusWorking]
        case nil: nil
        }
    }

    @ViewBuilder private func webMenu(for node: FileNode) -> some View {
        if !node.isDirectory {
            Button { open(node) } label: { Label("rightSidebar.files.addToGrid", systemImage: "square.grid.2x2") }
            Button { preview(node.url) } label: { Label("rightSidebar.files.preview", systemImage: "eye") }
            if ["md", "markdown"].contains(node.url.pathExtension.lowercased()) {
                Button {
                    openMarkdown(node.url)
                } label: { Label("rightSidebar.files.openMarkdown", systemImage: "sidebar.right") }
            }
        }
        Button { NSWorkspace.shared.activateFileViewerSelecting([node.url]) } label: {
            Label("files.revealInFinder", systemImage: "folder.badge.magnifyingglass")
        }
        Button { draftName = node.name; renaming = node.url } label: { Label("files.rename", systemImage: "pencil") }
        Button(role: .destructive) { trash(node.url) } label: { Label("files.moveToTrash", systemImage: "trash") }
    }

    // MARK: Rows

    @ViewBuilder
    private func rowView(_ row: FileTreeRow) -> some View {
        let node = row.node
        HStack(spacing: 4) {
            Image(systemName: row.isExpanded ? "chevron.down" : "chevron.right")
                .font(.caption2)
                .foregroundStyle(theme[.textTertiary])
                .opacity(node.isDirectory ? 1 : 0)
                .frame(width: 10)
            Image(systemName: node.isDirectory && row.isExpanded ? FileIcons.openFolderSymbol : node.iconName)
                .foregroundStyle(node.isDirectory ? theme[.accent] : theme[.textSecondary])
                .frame(width: 16)
            if renaming == node.url {
                TextField("files.name", text: $draftName)
                    .textFieldStyle(.plain)
                    .focused($renameFocused)
                    .onSubmit { commitRename(node.url) }
                    .onExitCommand { renaming = nil }
                    .onAppear { renameFocused = true }
            } else {
                Text(node.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(badgeColor(tree.badge(for: node)) ?? theme[.textPrimary])
            }
            Spacer(minLength: 4)
            if let badge = tree.badge(for: node) {
                Text(badge.letter)
                    .font(.caption.monospaced().weight(.semibold))
                    .foregroundStyle(badgeColor(badge) ?? theme[.textSecondary])
            }
        }
        .padding(.leading, CGFloat(row.depth) * 12)
        .contentShape(Rectangle())
        .onTapGesture {
            selection = node.url
            activate(node)
        }
        .help(node.url.path)
    }

    private func badgeColor(_ badge: GitBadge?) -> Color? {
        switch badge {
        case .conflict?, .deleted?: theme[.statusStopped]
        case .modified?, .stagedModified?, .renamed?: theme[.statusWaiting]
        case .added?, .untracked?: theme[.statusActive]
        case nil: nil
        }
    }

    // MARK: Menus

    @ViewBuilder
    private func menu(for node: FileNode) -> some View {
        if !node.isDirectory {
            Button("files.open") { open(node) }
            Button("files.openWithDefaultApp") { NSWorkspace.shared.open(node.url) }
        }
        Button("files.quickLook") { preview(node.url) }
        Button("files.revealInFinder") { NSWorkspace.shared.activateFileViewerSelecting([node.url]) }
        Divider()
        Button("files.rename") {
            draftName = node.name
            renaming = node.url
        }
        createMenu(in: node.isDirectory ? node.url : node.url.deletingLastPathComponent())
        Divider()
        Button("files.moveToTrash", role: .destructive) { trash(node.url) }
    }

    @ViewBuilder
    private func createMenu(in directory: URL) -> some View {
        Button("files.newFile") { create(in: directory, folder: false) }
        Button("files.newFolder") { create(in: directory, folder: true) }
    }

    // MARK: Actions

    private func activate(_ node: FileNode) {
        if node.isDirectory {
            attempt { try tree.toggle(node.url) }
        } else {
            open(node)
        }
    }

    /// Opens a file in the pane its kind maps to; plain text goes to the default app.
    private func open(_ node: FileNode) {
        let path = node.url.path
        let content: PaneContent? = switch node.paneKind {
        case .markdown?: .markdown(path: path)
        case .image?: .image(path: path)
        case .video?: .video(path: path)
        case .web?: environment.features.isOn(.browser) ? .web(url: node.url.absoluteString, options: WebPaneOptions()) : nil
        case .text?, nil: nil
        }
        if let content {
            environment.open(content, in: project.id)
        } else {
            NSWorkspace.shared.open(node.url)
        }
    }

    private func commitRename(_ url: URL) {
        renaming = nil
        attempt {
            try FileOperations.rename(url, to: draftName)
            try tree.reload()
        }
    }

    /// Creates `untitled` (numbered when taken), then starts renaming it inline.
    private func create(in directory: URL, folder: Bool) {
        let base = String(localized: folder ? "files.untitledFolder" : "files.untitledFile")
        var name = base
        var index = 2
        while FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path) {
            name = "\(base) \(index)"
            index += 1
        }
        attempt {
            let created = folder
                ? try FileOperations.createFolder(named: name, in: directory)
                : try FileOperations.createFile(named: name, in: directory)
            if directory.standardizedFileURL != tree.root { try tree.expand(directory) }
            try tree.reload()
            draftName = name
            renaming = created.standardizedFileURL
        }
    }

    private func trash(_ url: URL) {
        attempt {
            if try FileOperations.moveToTrash(url) == .trashUnavailable {
                pendingDelete = url
            }
            try tree.reload()
        }
    }

    private func deletePermanently(_ url: URL) {
        pendingDelete = nil
        attempt {
            try FileOperations.deletePermanently(url)
            try tree.reload()
        }
    }

    private func attempt(_ work: () throws -> Void) {
        do {
            try work()
        } catch let error as FileOperationError {
            errorMessage = switch error {
            case .invalidName: String(localized: "files.error.invalidName")
            case .alreadyExists: String(localized: "files.error.alreadyExists")
            case .notFound: String(localized: "files.error.notFound")
            case .rootNotModifiable: String(localized: "files.error.root")
            case .failed(let message): message
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: Live refresh

    /// Loads the tree and git badges, then refreshes both on every watcher signal until cancelled.
    private func follow() async {
        try? tree.reload()
        let repository: GitRepository? = if let root = try? await GitRepository.discover(tree.root) {
            GitRepositories.shared.repository(at: root)
        } else {
            nil
        }
        await refreshBadges(repository)
        // With the folder below the repository root, `.git` lies outside the tree watcher: watch it
        // too, so commits, stages and checkouts refresh the badges.
        let gitWatcher = repository.flatMap { Self.gitDirectoryWatcher(repoRoot: $0.root, tree: tree.root) }
        gitWatcher?.start()
        let gitRefresh = gitWatcher.map { watcher in
            Task { @MainActor in
                for await _ in watcher.events { await refreshBadges(repository) }
            }
        }
        let watcher = FileTreeWatcher(root: tree.root)
        watcher.start()
        defer {
            watcher.stop()
            gitWatcher?.stop()
            gitRefresh?.cancel()
        }
        for await _ in watcher.events {
            try? tree.reload()
            await refreshBadges(repository)
        }
    }

    /// A watcher on the repository's `.git` when it is not inside the watched folder.
    private static func gitDirectoryWatcher(repoRoot: URL, tree: URL) -> GitWatcher? {
        let root = repoRoot.standardizedFileURL.resolvingSymlinksInPath()
        let folder = tree.standardizedFileURL.resolvingSymlinksInPath()
        guard root.path != folder.path else { return nil }
        var gitDirectory = root.appending(path: ".git", directoryHint: .isDirectory)
        // A worktree or submodule has a `.git` file pointing at its git directory.
        if let text = try? String(contentsOf: root.appending(path: ".git"), encoding: .utf8), text.hasPrefix("gitdir:") {
            let path = text.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespacesAndNewlines)
            gitDirectory = URL(filePath: path, directoryHint: .isDirectory, relativeTo: root).standardizedFileURL
        }
        return GitWatcher(root: gitDirectory)
    }

    private func refreshBadges(_ repository: GitRepository?) async {
        guard let repository, let status = try? await repository.status() else {
            tree.gitBadges = nil
            return
        }
        tree.gitBadges = GitBadgeIndex(status: status, repoRoot: repository.root)
    }

    private var deleteBinding: Binding<Bool> {
        Binding { pendingDelete != nil } set: { if !$0 { pendingDelete = nil } }
    }

    private var errorBinding: Binding<Bool> {
        Binding { errorMessage != nil } set: { if !$0 { errorMessage = nil } }
    }
}

/// Shows one file in the shared Quick Look panel (Space in the explorer).
@MainActor
private final class QuickLook: NSObject, QLPreviewPanelDataSource {
    static let shared = QuickLook()
    /// Only touched on the main thread (Quick Look queries its data source there).
    nonisolated(unsafe) private var url: URL?

    func show(_ url: URL) {
        self.url = url
        guard let panel = QLPreviewPanel.shared() else { return }
        panel.dataSource = self
        panel.reloadData()
        if panel.isVisible { panel.orderOut(nil) } else { panel.makeKeyAndOrderFront(nil) }
    }

    nonisolated func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        url == nil ? 0 : 1
    }

    nonisolated func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        url.map { $0 as NSURL }
    }
}

private struct WebFileHover: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false
    func body(content: Content) -> some View {
        content.background(theme[.panelHover].opacity(hovering ? 1 : 0))
            .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
            .onHover { hovering = $0 }
    }
}

private struct WebFileDrag: ViewModifier {
    let url: URL
    let enabled: Bool
    func body(content: Content) -> some View {
        if enabled { content.draggable(url) } else { content }
    }
}

/// FileExplorer.module.css preview: original media, source text and the same 2 MiB text gate.
private struct SidebarFilePreview: View {
    let url: URL
    let close: () -> Void
    let add: () -> Void
    let markdown: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @State private var image: NSImage?
    @State private var player: AVPlayer?
    @State private var text: String?
    @State private var failure: String?
    private var ext: String { url.pathExtension.lowercased() }
    private var isImage: Bool { ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].contains(ext) }
    private var isVideo: Bool { ["mp4", "webm", "mov", "m4v", "mkv", "avi"].contains(ext) }

    var body: some View {
        GitWebModal(close: close) {
            Text(verbatim: url.lastPathComponent).lineLimit(1)
        } content: {
            VStack(spacing: metrics.size(10)) {
                Text(verbatim: url.path).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint])
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                previewContent.frame(height: max(metrics.size(120), min(metrics.size(440), maximumHeight - metrics.size(150))))
            }
        } footer: {
            Button(action: add) { Label("rightSidebar.files.addToGrid", systemImage: "square.grid.2x2") }
                .buttonStyle(AletheButtonStyle(.primary))
            if ["md", "markdown"].contains(ext) {
                Button(action: markdown) { Label("rightSidebar.files.openMarkdown", systemImage: "sidebar.right") }
                    .buttonStyle(AletheButtonStyle(.primary))
            }
        }
        .task(id: url) { await load() }
        .onDisappear { player?.pause() }
        .accessibilityIdentifier("files.preview")
    }

    @ViewBuilder private var previewContent: some View {
        if let failure { Text(verbatim: failure).foregroundStyle(theme[.fgMuted]).frame(maxWidth: .infinity) }
        else if isImage, let image {
            GeometryReader { proxy in
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                    .frame(width: proxy.size.width, height: proxy.size.height)
            }.background(theme[.bgSunken])
        } else if isVideo, let player { VideoPlayer(player: player).background(theme[.bgSunken]) }
        else if ext == "pdf" { SidebarPDFPreview(url: url) }
        else if let text {
            ScrollView([.horizontal, .vertical]) {
                Text(verbatim: text).font(metrics.monoFont(size: 11)).textSelection(.enabled)
                    .padding(metrics.size(12)).frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        } else { Text("files.loadingPreview").foregroundStyle(theme[.fgMuted]) }
    }

    private func load() async {
        if isVideo { player = AVPlayer(url: url); return }
        if ext == "pdf" { return }
        let source = url
        let media = isImage
        let result = await Task.detached(priority: .userInitiated) { () -> Result<Data, any Error> in
            Result {
                let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                if !media && size > 2 * 1024 * 1024 { throw PreviewError.tooLarge }
                return try Data(contentsOf: source)
            }
        }.value
        guard !Task.isCancelled else { return }
        switch result {
        case .success(let data):
            if media {
                image = NSImage(data: data)
                if image == nil { failure = String(localized: "linkPreview.unavailable") }
            } else if let content = String(data: data, encoding: .utf8) { text = content }
            else { failure = String(localized: "linkPreview.unavailable") }
        case .failure(PreviewError.tooLarge): failure = String(localized: "files.previewTooLarge")
        case .failure(let error): failure = error.localizedDescription
        }
    }

    private enum PreviewError: Error { case tooLarge }
}

private struct SidebarPDFPreview: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(url: url)
        return view
    }
    func updateNSView(_ view: PDFView, context: Context) {}
}
