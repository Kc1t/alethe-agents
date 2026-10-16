import AletheDesign
import AletheDocuments
import AppKit
import AletheModel
import AlethePluginKit
import SwiftUI

/// Project Markdown files and open documents, rendered inside the inspector.
struct DocsView: View {
    @Binding var droppedFiles: [URL]

    init(droppedFiles: Binding<[URL]> = .constant([])) {
        _droppedFiles = droppedFiles
    }
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.undoManager) private var undoManager
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var opened: [MarkdownFile] = []
    @State private var selectedPath: String?
    @State private var files: [String] = []

    static let tabID = "docs"
    static let tab = SidebarTabContribution(id: tabID, title: "Markdown", symbol: "doc.text", side: .right, viewID: tabID)

    private var project: Project? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)
        }
    }

    var body: some View {
        Group {
            if let file = opened.first(where: { $0.path == selectedPath }) {
                viewer(file)
            } else if let project {
                if files.isEmpty {
                    ContentUnavailableView("docs.empty", systemImage: "doc.text")
                } else {
                    List(files, id: \.self) { path in
                        Button {
                            openInSidebar(path)
                        } label: {
                            Label { Text(verbatim: relative(path, to: project.folder)) } icon: { Image(systemName: "doc.text") }
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .buttonStyle(.plain)
                        .help(path)
                    }
                    .listStyle(.sidebar)
                }
            } else {
                ContentUnavailableView("docs.noProject", systemImage: "folder")
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            let markdown = urls.filter { ["md", "markdown"].contains($0.pathExtension.lowercased()) && $0.isFileURL }
            for url in markdown { openInSidebar(url.path) }
            return !markdown.isEmpty
        }
        .onChange(of: droppedFiles) {
            for url in droppedFiles { openInSidebar(url.path) }
            droppedFiles = []
        }
        .onDisappear {
            for file in opened { file.close() }
            opened = []
            selectedPath = nil
        }
        .task(id: project?.folder) {
            guard let folder = project?.folder else { files = []; return }
            files = await Task.detached { Self.scan(folder) }.value
        }
    }

    private func openInSidebar(_ path: String) {
        if !opened.contains(where: { $0.path == path }) { opened.append(MarkdownFile(path: path)) }
        selectedPath = path
    }

    private func close(_ file: MarkdownFile) {
        file.close()
        opened.removeAll { $0.path == file.path }
        if selectedPath == file.path { selectedPath = opened.last?.path }
    }

    private func viewer(_ file: MarkdownFile) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.space(.xs)) {
                Text(verbatim: file.name).font(metrics.font(.headline)).lineLimit(1)
                Spacer(minLength: 0)
                ContentPaneButton(symbol: "arrow.clockwise", label: "markdown.refresh", id: "docs.refresh") { file.reload() }
                ContentPaneButton(symbol: "doc.on.doc", label: "markdown.copySource", id: "docs.copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(file.source, forType: .string)
                }.disabled(!file.isLoaded || file.loadError != nil)
                ContentPaneButton(symbol: "arrow.left", label: "docs.back", id: "docs.back") { selectedPath = nil }
                ContentPaneButton(symbol: "sidebar.right", label: "rightSidebar.close", id: "docs.close") {
                    environment.rightSidebarVisible = false
                }
            }.padding(metrics.space(.s))
            ScrollView(.horizontal) {
                HStack(spacing: metrics.space(.xs)) {
                    ForEach(opened, id: \.path) { tab in
                        HStack(spacing: metrics.space(.xxs)) {
                            Button { selectedPath = tab.path } label: { Text(verbatim: tab.name) }
                                .buttonStyle(.bordered).tint(theme[selectedPath == tab.path ? .accent : .textSecondary])
                            ContentPaneButton(symbol: "xmark", label: "docs.closeTab", id: "docs.tab.close") { close(tab) }
                        }
                    }
                }.padding(.horizontal, metrics.space(.s))
            }
            Text(verbatim: file.path).font(metrics.font(.caption)).lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled).padding(metrics.space(.s))
            if let project {
                Button("docs.openInPane") { open(file.path, in: project.id) }
                    .padding(.bottom, metrics.space(.s))
            }
            MarkdownFileContent(file: file)
        }
    }

    private func open(_ path: String, in project: ProjectID) {
        environment.workspace?.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
            $0.addPane(to: project, content: .markdown(path: path))
        }
    }

    private func relative(_ path: String, to folder: String) -> String {
        path.hasPrefix(folder + "/") ? String(path.dropFirst(folder.count + 1)) : path
    }

    /// `*.md` / `*.markdown` files up to three levels deep, skipping hidden and dependency folders.
    nonisolated static func scan(_ folder: String, maxDepth: Int = 3, limit: Int = 200) -> [String] {
        let root = URL(filePath: folder, directoryHint: .isDirectory)
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }
        let skipped: Set<String> = ["node_modules", "build", "target", "dist", "Pods", "DerivedData", "vendor", "Vendor"]
        var found: [String] = []
        for case let url as URL in enumerator {
            if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                if skipped.contains(url.lastPathComponent) || enumerator.level >= maxDepth { enumerator.skipDescendants() }
                continue
            }
            if ["md", "markdown"].contains(url.pathExtension.lowercased()) {
                found.append(url.path)
                if found.count >= limit { break }
            }
        }
        return found.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}
