import AletheDesign
import SwiftUI
import AletheModel
import AletheTerminal
import AppKit

/// Opens a ⌘-clicked terminal link (upstream `XTermView` link actions): Markdown, images and videos in
/// a pane of the project (focusing one that already shows the file), other files in their default
/// app, folders in Finder, pages in the default browser, or in a web pane with ⌥ held (browser
/// feature on). ⇧⌘-click shows every action in a menu (upstream's link actions menu), including a
/// quick preview.
extension AppEnvironment {
    func openTerminalLink(_ raw: String, from terminal: TerminalPaneView, tab: PaneTab, project: Project) {
        let cwd = terminal.reportedDirectory ?? tab.workingDirectory ?? project.folder
        if metrics.isWebInterface {
            showWebTerminalLink(raw, cwd: cwd, terminal: terminal, project: project)
            return
        }
        let link = metrics.isWebInterface ? TerminalLink.resolveWeb(raw, cwd: cwd) : TerminalLink.resolve(raw, cwd: cwd)
        if NSEvent.modifierFlags.contains(.shift) {
            LinkActionsMenu(environment: self, link: link, raw: raw, project: project.id).show(in: terminal)
            return
        }
        let inPane = NSEvent.modifierFlags.contains(.option)
        switch link {
        case .web(let url):
            if inPane && features.isOn(.browser) {
                open(.web(url: url.absoluteString, options: WebPaneOptions()), in: project.id)
            } else {
                NSWorkspace.shared.open(url)
            }
        case .file(let path, _):
            if let content = PaneContent.forFile(path) {
                open(content, in: project.id)
            } else {
                NSWorkspace.shared.open(URL(filePath: path))
            }
        case .directory(let path):
            NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: path, directoryHint: .isDirectory)])
        case .other(let url):
            NSWorkspace.shared.open(url)
        case .none:
            NSSound.beep()
        }
    }

    /// Shows `content` in the project: focuses a pane already showing it, or adds one (undoable).
    func open(_ content: PaneContent, in project: ProjectID, actionName: String = String(localized: "undo.openLink")) {
        guard let workspace else { return }
        if let existing = workspace.document.project(project)?.panes.first(where: { $0.content == content }) {
            workspace.update {
                $0.open(project)
                $0.workspace.focusedPaneID = existing.id
            }
            return
        }
        workspace.update(undoManager: NSApp.keyWindow?.undoManager, actionName: actionName) {
            $0.addPane(to: project, content: content)
        }
    }
}

/// ⇧⌘-click on a terminal link: every way to open it, at the mouse.
@MainActor
private final class LinkActionsMenu: NSObject {
    private let environment: AppEnvironment
    private let link: TerminalLink
    private let raw: String
    private let project: ProjectID
    private var actions: [() -> Void] = []

    init(environment: AppEnvironment, link: TerminalLink, raw: String, project: ProjectID) {
        self.environment = environment
        self.link = link
        self.raw = raw
        self.project = project
    }

    func show(in view: NSView) {
        let menu = NSMenu()
        switch link {
        case .web(let url):
            add(menu, "linkMenu.openInBrowser") { NSWorkspace.shared.open(url) }
            if environment.features.isOn(.browser) {
                add(menu, "linkMenu.openInPane") { [environment, project] in
                    environment.open(.web(url: url.absoluteString, options: WebPaneOptions()), in: project)
                }
            }
            add(menu, "linkMenu.preview") { [environment] in environment.editorRequest = .previewLink(.web(url)) }
        case .file(let path, _):
            if let content = PaneContent.forFile(path) {
                add(menu, "linkMenu.openInPane") { [environment, project] in environment.open(content, in: project) }
            }
            add(menu, "linkMenu.preview") { [environment] in environment.editorRequest = .previewLink(.file(path)) }
            add(menu, "linkMenu.openWithDefaultApp") { NSWorkspace.shared.open(URL(filePath: path)) }
            add(menu, "linkMenu.showInFinder") { NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: path)]) }
        case .directory(let path):
            add(menu, "linkMenu.showInFinder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: path, directoryHint: .isDirectory)])
            }
        case .other(let url):
            add(menu, "linkMenu.openWithDefaultApp") { NSWorkspace.shared.open(url) }
        case .none:
            let item = NSMenuItem(title: String(localized: "linkMenu.notFound"), action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        menu.addItem(.separator())
        add(menu, "linkMenu.copy") { [raw] in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(raw, forType: .string)
        }
        let point = view.window.map { view.convert($0.mouseLocationOutsideOfEventStream, from: nil) } ?? .zero
        // Menu items hold their target weakly: keep this object until the chosen action has run.
        Self.open = self
        menu.popUp(positioning: nil, at: point, in: view)
        DispatchQueue.main.async { if Self.open === self { Self.open = nil } }
    }

    private static var open: LinkActionsMenu?

    private func add(_ menu: NSMenu, _ key: String.LocalizationValue, _ action: @escaping () -> Void) {
        let item = NSMenuItem(title: String(localized: key), action: #selector(run(_:)), keyEquivalent: "")
        item.target = self
        item.tag = actions.count
        actions.append(action)
        menu.addItem(item)
    }

    @objc private func run(_ item: NSMenuItem) {
        actions[item.tag]()
    }
}
