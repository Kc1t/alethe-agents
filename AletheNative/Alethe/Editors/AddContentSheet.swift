import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Add Content (⇧⌘A; upstream `AddContentModal`): puts a file or page pane beside a project's
/// terminals. Only kinds the app can already show are offered; each pane task adds its option.
struct AddContentSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let project: ProjectID?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    /// One way to add content: what it shows, and how its target is chosen.
    struct Option: Identifiable {
        let kind: PaneContent.Kind
        let title: LocalizedStringKey
        let detail: LocalizedStringKey
        let symbol: String
        /// Asks for the file or page (a panel, a field…); nil when cancelled.
        let choose: @MainActor (_ project: Project) -> PaneContent?
        var id: PaneContent.Kind { kind }
    }

    /// One entry per pane kind the app can show (a kind's task adds it).
    static let options: [Option] = [
        Option(kind: .markdown, title: "addContent.markdown", detail: "addContent.markdown.detail",
               symbol: "doc.richtext") { project in
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.message = String(localized: "addContent.markdown.picker")
            panel.allowedContentTypes = ["md", "markdown", "mdx"].compactMap { UTType(filenameExtension: $0) }
            panel.directoryURL = URL(filePath: project.folder, directoryHint: .isDirectory)
            guard panel.runModal() == .OK, let url = panel.url else { return nil }
            return .markdown(path: url.path)
        },
        Option(kind: .image, title: "addContent.media", detail: "addContent.media.detail",
               symbol: "photo.on.rectangle") { project in
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.message = String(localized: "addContent.media.picker")
            panel.allowedContentTypes = [.image, .movie]
            panel.directoryURL = URL(filePath: project.folder, directoryHint: .isDirectory)
            guard panel.runModal() == .OK, let url = panel.url else { return nil }
            return PaneContent.forFile(url.path) ?? .image(path: url.path)
        },
        Option(kind: .web, title: "addContent.web", detail: "addContent.web.detail", symbol: "globe") { _ in
            nil
        },
        Option(kind: .diff, title: "addContent.diff", detail: "addContent.diff.detail", symbol: "plusminus") { _ in
            .diff(path: nil, staged: false)
        },
        Option(kind: .graphify, title: "addContent.graphify", detail: "addContent.graphify.detail",
               symbol: "point.3.connected.trianglepath.dotted") { _ in
            .graphify
        },
        Option(kind: .orchestrator, title: "addContent.orchestrator", detail: "addContent.orchestrator.detail",
               symbol: "flowchart") { _ in
            .orchestrator
        },
    ]

    /// The options whose feature is on: web pages need the browser feature (P5-3), the code graph
    /// the graphify one, the orchestrator board the orchestrator one.
    static func options(for features: Features) -> [Option] {
        options.filter { option in
            switch option.kind {
            case .web: features.isOn(.browser)
            case .graphify: features.isOn(.graphify)
            case .orchestrator: features.isOn(.orchestrator)
            default: true
            }
        }
    }

    private var target: Project? {
        project.flatMap { workspace.document.project($0) } ?? workspace.document.projects.first
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: close) {
            Text("addContent.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                Text("addContent.description").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                ForEach(Self.options(for: environment.features)) { option in
                    Button { add(option) } label: {
                        HStack(alignment: .top, spacing: metrics.size(12)) {
                            Image(systemName: option.symbol).webProfileSized(20).foregroundStyle(theme[.accent])
                            VStack(alignment: .leading, spacing: metrics.size(4)) {
                                Text(option.title).font(metrics.font(size: 13, weight: .semibold))
                                Text(option.detail).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(WebContentOptionStyle())
                    .disabled(target == nil)
                    .accessibilityIdentifier("addContent.\(option.kind.rawValue)")
                }
            }
        } footer: {
            Spacer()
            Button("editor.cancel", action: close)
        }
    }

    private func close() {
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private var nativeBody: some View {
        Form {
            Section {
                ForEach(Self.options(for: environment.features)) { option in
                    Button { add(option) } label: {
                        HStack(spacing: metrics.space(.m)) {
                            Image(systemName: option.symbol)
                                .font(metrics.font(.title3))
                                .foregroundStyle(theme[.accent])
                                .frame(width: metrics.size(28))
                            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                                Text(option.title).font(metrics.font(.body).weight(.medium))
                                Text(option.detail).font(metrics.font(.footnote)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(target == nil)
                    .accessibilityIdentifier("addContent.\(option.kind.rawValue)")
                }
            } header: {
                Text("addContent.description")
            }
        }
        .formStyle(.grouped)
        .frame(width: metrics.size(420))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("editor.cancel") { dismiss() }
            }
        }
        .navigationTitle(Text("addContent.title"))
    }

    private func add(_ option: Option) {
        guard let target else { return }
        if option.kind == .web {
            environment.editorRequest = .addBrowser(target.id)
            return
        }
        guard let content = option.choose(target) else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
            if metrics.isWebInterface, $0.activeWorkspaceTab?.webPaneID != nil { $0.openWebProject(target.id) }
            $0.addPane(to: target.id, content: content)
        }
        environment.showingHome = false
        close()
    }
}

private struct WebContentOptionStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(theme[.fg])
            .padding(metrics.size(12))
            .background(theme[configuration.isPressed ? .panelHover : .bgSunken],
                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

/// Browser setup uses the same private WKWebView and persisted resource policy as existing panes.
struct AddBrowserSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let project: ProjectID?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var address = ""
    @State private var name = ""
    @State private var javascript = true
    @State private var zoom: Double = 1
    @State private var resourceMode = WebResourceMode.appFirst
    @FocusState private var addressFocused: Bool

    private var target: Project? { project.flatMap(workspace.document.project) }
    private var url: URL? { WebAddress.normalize(address) }
    var body: some View {
        GitWebModal(close: close) {
            Text("browser.addTitle")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                HStack(alignment: .top, spacing: metrics.size(10)) {
                    Image(systemName: "checkmark.shield").webProfileSized(18).foregroundStyle(theme[.statusActive])
                    VStack(alignment: .leading, spacing: metrics.size(3)) {
                        Text("browser.privateTitle").font(metrics.font(size: 12, weight: .semibold))
                        Text("browser.privateDescription").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    }
                }
                .padding(metrics.size(12))
                .background(theme[.statusActive].opacity(0.08), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[.statusActive].opacity(0.32), lineWidth: metrics.size(1)))
                field("browser.url") {
                    TextField("browser.urlPlaceholder", text: $address)
                        .modifier(ProjectGroupWebInput(focus: $addressFocused))
                        .accessibilityIdentifier("browser.add.url")
                        .onSubmit(addBrowser)
                    if !address.isEmpty && url == nil {
                        Text("browser.invalidUrl").font(metrics.font(size: 11)).foregroundStyle(theme[.statusOffline])
                    } else {
                        Text("browser.urlHint").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    }
                }
                field("browser.name") {
                    TextField("browser.namePlaceholder", text: $name)
                        .modifier(ProjectGroupWebInput())
                        .accessibilityIdentifier("browser.add.name")
                }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: metrics.size(12)) {
                        zoomPicker.frame(minWidth: metrics.size(130))
                        javascriptToggle.frame(minWidth: metrics.size(220))
                    }
                    VStack(alignment: .leading, spacing: metrics.size(12)) {
                        zoomPicker
                        javascriptToggle
                    }
                }
                field("browser.resourceMode") {
                    WebDropdown(selection: $resourceMode, options: WebResourceMode.allCases, accessibilityID: "newTerminal.rowSelect", appearance: .input) { Text(verbatim: resourceLabel($0)) }
                        .accessibilityLabel(Text("browser.resourceMode"))
                        .accessibilityIdentifier("browser.add.resourceMode")
                    resourceDescription.font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
                if let target {
                    Text(verbatim: String(format: String(localized: "browser.destination"), target.name))
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                }
            }
        } footer: {
            Spacer()
            Button("editor.cancel", action: close)
            Button("browser.addToGrid", action: addBrowser)
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction)
                .disabled(target == nil || url == nil)
                .accessibilityIdentifier("browser.add.confirm")
        }
        .frame(width: closeOverlay == nil ? metrics.size(520) : nil)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.add")
        .task { addressFocused = true }
    }

    private var zoomPicker: some View {
        field("browser.zoom") {
            WebDropdown(selection: $zoom, options: [0.75, 1, 1.25, 1.5], accessibilityID: "newTerminal.rowSelect", appearance: .input) { Text(verbatim: "\(Int($0 * 100))%") }
                .accessibilityLabel(Text("browser.zoom"))
                .accessibilityIdentifier("browser.add.zoom")
        }
    }

    private var javascriptToggle: some View {
        Toggle(isOn: $javascript) {
            VStack(alignment: .leading, spacing: metrics.size(3)) {
                Text("browser.javascript").font(metrics.font(size: 12, weight: .semibold))
                Text("browser.javascriptDescription").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            }
        }
        .toggleStyle(.checkbox)
        .tint(theme[.accent])
        .padding(metrics.size(12))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityIdentifier("browser.add.javascript")
    }

    private var resourceDescription: Text {
        switch resourceMode {
        case .appFirst: Text("browser.resourceModeDescription.appFirst")
        case .balanced: Text("browser.resourceModeDescription.balanced")
        case .keepAlive: Text("browser.resourceModeDescription.keepAlive")
        }
    }

    private func resourceLabel(_ mode: WebResourceMode) -> String {
        switch mode {
        case .appFirst: String(localized: "browser.resourceModeAppFirst")
        case .balanced: String(localized: "browser.resourceModeBalanced")
        case .keepAlive: String(localized: "browser.resourceModeKeepAlive")
        }
    }

    private func field<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(6)) {
            Text(title).font(metrics.font(size: 12, weight: .medium)).foregroundStyle(theme[.fgMuted])
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func close() {
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private func addBrowser() {
        guard let target, let url else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
            if metrics.isWebInterface, $0.activeWorkspaceTab?.webPaneID != nil { $0.openWebProject(target.id) }
            $0.addPane(to: target.id, content: .web(url: url.absoluteString,
                options: WebPaneOptions(resourceMode: resourceMode, javascriptEnabled: javascript, zoom: zoom, name: name)))
        }
        environment.showingHome = false
        close()
    }
}
