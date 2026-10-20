import AletheDesign
import AletheGit
import AletheModel
import AletheTerminal
import AppKit
import SwiftUI

extension AppEnvironment {
    func showWebTerminalLink(_ raw: String, cwd: String, terminal: TerminalPaneView, project: Project) {
        let printed = raw.hasPrefix("file://") ? (URL(string: raw)?.path ?? raw) : raw
        let detected = TerminalLinks.detect(printed).first
        let isURL = detected?.kind == .url
        let target = isURL ? (detected?.target ?? raw)
            : TerminalLinks.resolvePath(printed, cwd: cwd, home: NSHomeDirectory())
        let kind = isURL ? nil : TerminalLinks.classify(printed)
        let host = WebMenuHost.shared
        guard let view = host.layerView, let window = terminal.window, view.window === window else { return }
        let mouse = view.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        let y = view.isFlipped ? mouse.y : view.bounds.height - mouse.y
        let offset = metrics.size(6)
        let below = y + offset
        let top = below + metrics.size(276) <= view.bounds.height - metrics.size(10)
            ? below : max(metrics.size(10), y - metrics.size(276) - offset)
        let content = TerminalLinkActions(environment: self, project: project.id, text: raw,
                                          target: target, isURL: isURL, fileKind: kind, availableSize: view.bounds.size)
        host.present(at: CGPoint(x: mouse.x + offset, y: top), content: AnyView(content), usesDefaultChrome: false)
        guard !isURL, let relative = TerminalLinks.relativePath(printed),
              !FileManager.default.fileExists(atPath: target), let request = host.presentation?.id else { return }
        Task {
            let worktrees = GitWorktrees()
            let repo = URL(filePath: cwd)
            let linked = (try? await worktrees.gitWorktrees(repo: repo)) ?? []
            let managed = (try? await worktrees.list(repo: repo)) ?? []
            guard host.presentation?.id == request else { return }
            let known = [project.folder] + project.panes.flatMap(\.tabs).compactMap(\.workingDirectory)
            if let candidate = TerminalLinks.findRelativePath(relative, cwd: cwd,
                worktrees: linked.map(\.path) + managed.map(\.path) + known) {
                host.presentation?.content = AnyView(TerminalLinkActions(environment: self, project: project.id,
                    text: raw, target: candidate, isURL: false, fileKind: kind, availableSize: view.bounds.size))
            }
        }
    }
}

/// XTermView.module.css: 272px menu, 39px header, 34px action rows and theme-owned hover colors.
private struct TerminalLinkActions: View {
    let environment: AppEnvironment
    let project: ProjectID
    let text: String
    let target: String
    let isURL: Bool
    let fileKind: DetectedTerminalLink.FileKind?
    let availableSize: CGSize
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var closeHovered = false

    private var itemsHeight: CGFloat {
        let count = 2 + (isURL ? 0 : 1) + (isURL || fileKind != nil ? 1 : 0)
            + (isURL || fileKind == .video ? 1 : 0) + (fileKind == .markdown ? 2 : 0)
        let desired = metrics.size(CGFloat(count) * (metrics.style == .clean ? 30 : 34)
            + CGFloat(count - 1) * 2 + 10)
        return min(desired, max(0, availableSize.height - metrics.size(60)))
    }

    private var url: URL? { isURL ? URL(string: target) : URL(filePath: target) }

    var body: some View {
        let shadow = theme.shadow(.lg)
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(8)) {
                Text(verbatim: text)
                    .font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                    .help(text)
                Button { WebMenuHost.shared.dismiss() } label: {
                    Image(systemName: "xmark").font(metrics.font(size: 14))
                        .frame(width: metrics.size(27), height: metrics.size(27))
                }
                .buttonStyle(.plain).foregroundStyle(theme[.fgMuted])
                .background(closeHovered ? theme[.accentSoft] : .clear,
                            in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(closeHovered ? theme[.border] : .clear, lineWidth: metrics.size(1)))
                .onHover { closeHovered = $0 }
                .accessibilityLabel(Text("terminal.link.close"))
            }
            .padding(.leading, metrics.size(10)).padding([.vertical, .trailing], metrics.size(6))
            .frame(minHeight: metrics.size(39))
            .background(theme[.bgSunken])
            theme[.borderSubtle].frame(height: metrics.size(1))
            ScrollView {
                VStack(spacing: metrics.size(2)) {
                    if isURL || fileKind != nil {
                        row("terminal.link.openInGrid", "square.grid.2x2") {
                            if isURL, environment.features.isOn(.browser) {
                                environment.open(.web(url: target, options: WebPaneOptions()), in: project)
                            } else if let content = PaneContent.forFile(target) {
                                environment.open(content, in: project)
                            }
                        }
                        .disabled(isURL && !environment.features.isOn(.browser))
                    }
                    if isURL || fileKind == .video {
                        row(fileKind == .video ? "terminal.link.playInApp" : "terminal.link.openInApp", "macwindow") {
                            preview()
                        }
                    }
                    if fileKind == .markdown {
                        row("terminal.link.markdownFullscreen", "arrow.up.left.and.arrow.down.right") { preview() }
                        row("terminal.link.markdownSidebar", "sidebar.right") {
                            NotificationCenter.default.post(name: .sidebarOpenMarkdown, object: URL(filePath: target))
                            environment.rightSidebarTab = DocsView.tabID
                            environment.rightSidebarVisible = true
                        }
                    }
                    row(isURL ? "terminal.link.browser" : "terminal.link.defaultApp", "arrow.up.right.square") {
                        if let url { NSWorkspace.shared.open(url) }
                    }
                    if !isURL {
                        row("terminal.link.folder", "folder") {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: target)])
                        }
                    }
                    row("terminal.link.copy", "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(target, forType: .string)
                    }
                }
                .padding(metrics.size(5))
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: itemsHeight)
        }
        .frame(width: min(metrics.size(272), max(0, availableSize.width - metrics.size(20))))
        .background(theme[.surfaceModal], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
            .strokeBorder(theme[metrics.style == .clean ? .border : .borderAccent], lineWidth: metrics.size(1)))
        .shadow(color: shadow.color.color, radius: metrics.size(shadow.blur / 2),
                x: metrics.size(shadow.x), y: metrics.size(shadow.y))
        .accessibilityIdentifier("terminal.linkActions")
    }

    private func preview() {
        if isURL, let url { environment.editorRequest = .previewLink(.web(url)) }
        else { environment.editorRequest = .previewLink(.file(target)) }
    }

    private func row(_ key: LocalizedStringKey, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button {
            WebMenuHost.shared.activate(action)
        } label: {
            Label { Text(key) } icon: { Image(systemName: symbol).font(metrics.font(size: 15)) }
        }
        .buttonStyle(TerminalLinkActionStyle())
    }
}

private struct TerminalLinkActionStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        TerminalLinkActionRow(configuration: configuration)
    }
}

private struct TerminalLinkActionRow: View {
    let configuration: PrimitiveButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @Environment(\.webMenuSession) private var session
    @State private var id = UUID()
    private var hovered: Bool { enabled && session?.highlighted == id }

    var body: some View {
        configuration.label
            .labelStyle(TerminalLinkLabelStyle())
            .font(metrics.font(size: 12))
            .foregroundStyle(theme[hovered ? .fg : .fgMuted])
            .padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(6))
            .frame(maxWidth: .infinity, minHeight: metrics.size(metrics.style == .clean ? 30 : 34), alignment: .leading)
            .background(hovered ? theme[metrics.style == .clean ? .panelHover : .accentSoft] : .clear,
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                .strokeBorder(hovered && metrics.style != .clean ? theme[.accentBorder] : .clear,
                              lineWidth: metrics.size(1)))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.5)
            .onHover { inside in
                if inside && enabled { session?.highlighted = id }
                else if session?.highlighted == id { session?.highlighted = nil }
            }
            .onTapGesture { if enabled { configuration.trigger() } }
            .onAppear {
                session?.register(.init(id: id, enabled: enabled, opensSubmenu: false,
                                        trigger: configuration.trigger))
            }
            .onChange(of: enabled) {
                session?.register(.init(id: id, enabled: enabled, opensSubmenu: false,
                                        trigger: configuration.trigger))
            }
            .onDisappear { session?.unregister(id) }
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if enabled { configuration.trigger() } }
    }
}

private struct TerminalLinkLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(9)) {
            configuration.icon.frame(width: metrics.size(15), height: metrics.size(15))
            configuration.title
        }
    }
}
