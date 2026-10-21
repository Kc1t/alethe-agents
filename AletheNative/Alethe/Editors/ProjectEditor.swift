import AletheAgents
import AletheDesign
import AletheGit
import AletheModel
import AppKit
import SwiftUI

/// New Project / Edit Project sheet (upstream `NewProjectModal`, `EditProjectModal`).
struct ProjectEditor: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let editing: ProjectID?
    let initialLocation: ProjectLocation
    /// Folder filled in for a new project (an `alethe` open request for an unknown folder).
    var initialFolder: String? = nil
    var closeOverlay: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @FocusState private var webPathFocused: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(AppEnvironment.self) private var environment

    /// Where a new project's folder comes from (P5-5).
    enum Source: Hashable { case folder, clone }

    @State private var source: Source = .folder
    @State private var cloneURL = ""
    @State private var iconUrl = ""
    @State private var name = ""
    @State private var folder = ""
    @State private var color: ProjectColor? = .blue
    @State private var location: ProjectLocation = .ungrouped
    @State private var nameEdited = false
    /// Agent worktree defaults of the New Terminal sheet (P4-9).
    @State private var autoWorktree = false
    @State private var worktreeMode: ProjectWorktreeMode = .gitWorktree
    /// A saved `.alethe/project.json` the user chose to restore; its agents come back on create.
    @State private var restored: ProjectMarker?
    @State private var model = ProjectEditorModel()

    private var isCloning: Bool { editing == nil && source == .clone }
    /// Graphify MCP server for the project's agents (P5-17).
    @State private var advanced = ProjectAdvancedDraft()
    @State private var graphifyEnabled = false

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
    }

    private var nativeBody: some View {
        Form {
            if editing == nil {
                Picker(selection: $source) {
                    Text("editor.project.source.folder").tag(Source.folder)
                    Text("editor.project.source.clone").tag(Source.clone)
                } label: { Text("editor.project.source") }
                    .pickerStyle(.segmented)
                    .disabled(model.cloning)
                    .accessibilityIdentifier("editor.project.source")
            }
            if isCloning {
                TextField(text: $cloneURL, prompt: Text(verbatim: "https://github.com/owner/repository")) {
                    Text("editor.project.cloneURL")
                }
                .accessibilityIdentifier("editor.project.cloneURL")
                .disabled(model.cloning)
                .onChange(of: cloneURL) { _, value in
                    if !nameEdited { name = GitCloneURL.folderName(for: GitCloneURL.normalize(value)) }
                }
            }
            TextField(text: $folder, prompt: Text(verbatim: isCloning ? "~/Alethe" : "~/Projects/app")) {
                Text(isCloning ? "editor.project.cloneInto" : "editor.project.folder")
            }
                .accessibilityIdentifier("editor.project.folder")
                .focused($focused)
                .disabled(model.cloning)
                .onChange(of: folder) { _, value in
                    if !nameEdited, editing == nil, !isCloning { name = URL(filePath: expanded(value)).lastPathComponent }
                }
            HStack {
                Spacer()
                Button("editor.project.chooseFolder") { chooseFolder() }
                    .disabled(model.cloning)
            }
            if !isCloning { folderDetails }
            TextField(text: Binding { name } set: { name = $0; nameEdited = true }) { Text("editor.project.name") }
                .accessibilityIdentifier("editor.project.name")
            ImageInputField(value: $iconUrl, name: name, color: color)
            LabeledContent("editor.color") { ColorSwatchPicker(selection: $color) }
            Picker(selection: $location) {
                Text("sidebar.ungrouped").tag(ProjectLocation.ungrouped)
                ForEach(workspace.document.groups) { group in
                    Text(verbatim: group.name).tag(ProjectLocation.group(group.id))
                }
            } label: { Text("editor.project.group") }
            Section {
                Toggle(isOn: $autoWorktree) {
                    Text("editor.project.autoWorktree")
                    Text("editor.project.autoWorktree.detail").font(metrics.font(.footnote))
                }
                .accessibilityIdentifier("editor.project.autoWorktree")
                Picker(selection: $worktreeMode) {
                    Text("newTerminal.worktree.mode.gitWorktree").tag(ProjectWorktreeMode.gitWorktree)
                    Text("newTerminal.worktree.mode.localCopy").tag(ProjectWorktreeMode.localCopy)
                } label: { Text("newTerminal.worktree.mode") }
                    .accessibilityIdentifier("editor.project.worktreeMode")
            } header: { Text("editor.project.worktrees") }
            if isCloning { cloneStatus }
            if environment.features.isOn(.graphify) {
                Toggle(isOn: $graphifyEnabled) {
                    Text("editor.project.graphify")
                    Text("editor.project.graphify.detail").font(metrics.font(.footnote))
                }
                .accessibilityIdentifier("editor.project.graphify")
            }
            if let problem, !model.cloning {
                Text(problem)
                    .foregroundStyle(theme[.textSecondary])
                    .font(metrics.font(.footnote))
                    .accessibilityIdentifier("editor.problem")
            }
        }
        .formStyle(.grouped)
        .frame(width: metrics.size(460))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("editor.cancel") {
                    if model.cloning { model.cancelClone() } else { dismiss() }
                }
                .accessibilityIdentifier("editor.cancel")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(confirmTitle) { save() }
                    .disabled(problem != nil || model.cloning)
                    .accessibilityIdentifier("editor.confirm")
            }
        }
        .interactiveDismissDisabled(model.cloning)
        .navigationTitle(Text(editing == nil ? "editor.project.newTitle" : "editor.project.editTitle"))
        .task(id: isCloning ? "" : expanded(folder)) {
            await model.inspect(isCloning ? "" : expanded(folder))
        }
        .onAppear {
            focused = true
            loadInitial()
        }
    }

    private func close() {
        if metrics.isWebInterface, let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private var webBody: some View {
        ProjectGroupWebModal(title: editing == nil ? "editor.project.newTitle" : "editor.project.editTitle",
                             confirm: confirmTitle, disabled: problem != nil || model.cloning,
                             close: { if model.cloning { model.cancelClone() } else { close() } }, submit: submitWeb) {
            ProjectGroupWebField(title: "editor.web.name") {
                TextField(text: Binding { name } set: { name = $0; nameEdited = true },
                          prompt: Text("editor.project.web.namePlaceholder")) { Text("editor.project.name") }
                    .modifier(ProjectGroupWebInput(focus: $focused))
                    .accessibilityIdentifier("editor.project.name")
                    .onSubmit(submitWeb)
            }
            if editing == nil {
                ProjectGroupWebField(title: "editor.project.source") {
                    WebDropdown(selection: $source, options: [.folder, .clone]) { value in
                        Text(value == .folder ? "editor.project.source.folder" : "editor.project.source.clone")
                    }
                    .accessibilityIdentifier("editor.project.source").disabled(model.cloning)
                }
            }
            if isCloning {
                ProjectGroupWebField(title: "editor.project.cloneURL") {
                    TextField(text: $cloneURL, prompt: Text(verbatim: "https://github.com/owner/repository")) {
                        Text("editor.project.cloneURL")
                    }
                    .modifier(ProjectGroupWebInput()).accessibilityIdentifier("editor.project.cloneURL")
                    .disabled(model.cloning).onSubmit(submitWeb)
                    .onChange(of: cloneURL) { _, value in
                        if !nameEdited { name = GitCloneURL.folderName(for: GitCloneURL.normalize(value)) }
                    }
                }
            }
            if !workspace.document.groups.isEmpty {
                ProjectGroupWebField(title: "editor.project.group") {
                    WebDropdown(selection: $location,
                                 options: [.ungrouped] + workspace.document.groups.map { .group($0.id) }, appearance: .input) { value in
                        if case .group(let id) = value, let group = workspace.document.group(id) {
                            Text(verbatim: group.name)
                        } else { Text("sidebar.ungrouped") }
                    }
                }
            }
            ProjectGroupWebField(title: isCloning ? "editor.project.cloneInto" : "editor.project.web.folder") {
                HStack(spacing: metrics.size(6)) {
                    HStack(spacing: metrics.size(8)) {
                        Image(systemName: "folder").font(metrics.font(size: 15)).foregroundStyle(theme[.fgMuted])
                        TextField(text: $folder, prompt: Text(verbatim: "~/Projects/app")) { Text("editor.project.folder") }
                            .textFieldStyle(.plain).font(metrics.monoFont(size: 12))
                            .accessibilityIdentifier("editor.project.folder").focused($webPathFocused).onSubmit(submitWeb)
                            .onChange(of: folder) { _, value in
                                if !nameEdited, editing == nil, !isCloning { name = URL(filePath: expanded(value)).lastPathComponent }
                            }
                    }
                    .padding(.horizontal, metrics.size(10)).frame(height: metrics.size(32))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[webPathFocused ? .accent : .border], lineWidth: metrics.size(1)))
                    Button("editor.web.browse", action: chooseFolder).buttonStyle(AletheButtonStyle())
                }.disabled(model.cloning)
                if !isCloning { folderDetails }
            }
            ProjectGroupWebField(title: "editor.project.web.color") {
                ColorSwatchPicker(selection: $color, webSwatchSize: editing == nil ? 24 : 28)
            }
            ImageInputField(value: $iconUrl, name: name, color: color)
                .onSubmit(submitWeb)
            ProjectGroupWebField(title: "editor.project.worktrees") {
                WebDropdown(selection: $worktreeMode, options: [.gitWorktree, .localCopy]) { value in
                    Text(value == .gitWorktree ? "newTerminal.worktree.mode.gitWorktree" : "newTerminal.worktree.mode.localCopy")
                }.accessibilityIdentifier("editor.project.worktreeMode")
                Toggle("editor.project.autoWorktree", isOn: $autoWorktree)
                    .toggleStyle(.checkbox).font(metrics.font(size: 11))
                    .foregroundStyle(theme[.fgMuted]).accessibilityIdentifier("editor.project.autoWorktree")
            }
            if environment.features.isOn(.graphify) {
                Toggle("editor.project.graphify", isOn: $graphifyEnabled)
                    .toggleStyle(.checkbox).font(metrics.font(size: 11))
                    .foregroundStyle(theme[.fgMuted]).accessibilityIdentifier("editor.project.graphify")
            }
            if editing != nil { ProjectEditorAdvanced(draft: $advanced, project: editing, mode: worktreeMode) }
            if isCloning { cloneStatus }
            if let problem, !model.cloning {
                Text(problem).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    .accessibilityIdentifier("editor.problem")
            }
        }
        .task(id: isCloning ? "" : expanded(folder)) { await model.inspect(isCloning ? "" : expanded(folder)) }
        .onAppear { loadInitial(); focused = true }
    }

    private func submitWeb() {
        guard problem == nil, !model.cloning else { return }
        save()
    }

    private var confirmTitle: LocalizedStringKey {
        if editing != nil { return "editor.save" }
        return isCloning ? "editor.project.clone" : "editor.project.create"
    }

    /// The saved marker offer, the repository and the detected stack of the chosen folder.
    @ViewBuilder
    private var folderDetails: some View {
        if let inspection = model.inspection, model.inspectedFolder == expanded(folder) {
            if editing == nil, let marker = inspection.marker, restored != marker {
                HStack {
                    Text(verbatim: format("editor.project.markerFound", marker.name))
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textPrimary])
                    Spacer()
                    Button("editor.project.markerRestore") { restore(marker) }
                        .accessibilityIdentifier("editor.project.markerRestore")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("editor.project.marker")
            }
            if !inspection.isRepository {
                HStack {
                    Text("editor.project.noRepository")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textSecondary])
                    Spacer()
                    Button("editor.project.initGit") { model.initializeGit(expanded(folder)) }
                        .disabled(model.initializing)
                        .accessibilityIdentifier("editor.project.initGit")
                }
                if let error = model.initError {
                    Text(verbatim: error)
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.statusStopped])
                }
            }
            if let stack = inspection.stack {
                LabeledContent("editor.project.stack") {
                    Text(ProjectStackLabel.key(stack.stack))
                        .accessibilityIdentifier("editor.project.stack")
                }
            }
        }
    }

    /// Progress of a running clone, or why the last one failed.
    @ViewBuilder
    private var cloneStatus: some View {
        if model.cloning {
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                if let percent = model.cloneProgress?.percent {
                    ProgressView(value: Double(percent), total: 100)
                } else {
                    ProgressView().controlSize(.small)
                }
                Text(verbatim: model.cloneProgress?.phase ?? String(localized: "editor.clone.starting"))
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("editor.clone.progress")
        } else if let error = model.cloneError {
            Text(verbatim: error)
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.statusStopped])
                .textSelection(.enabled)
                .accessibilityIdentifier("editor.clone.error")
        }
    }

    /// Why the form cannot be saved yet, or nil.
    private var problem: LocalizedStringKey? {
        if isCloning { return cloneProblem }
        let path = expanded(folder)
        var isDirectory: ObjCBool = false
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "editor.problem.name" }
        if path.isEmpty || !FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) || !isDirectory.boolValue {
            return "editor.problem.folder"
        }
        return isAdded(path) ? "editor.problem.duplicate" : nil
    }

    private var cloneProblem: LocalizedStringKey? {
        let url = normalizedCloneURL
        if url.isEmpty || !GitCloneURL.isCloneable(url) { return "editor.problem.cloneURL" }
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "editor.problem.name" }
        let target = cloneTarget.path
        if let contents = try? FileManager.default.contentsOfDirectory(atPath: target), !contents.isEmpty {
            return "editor.problem.cloneTarget"
        }
        return isAdded(target) ? "editor.problem.duplicate" : nil
    }

    private func isAdded(_ path: String) -> Bool {
        let standardized = URL(filePath: path).standardizedFileURL.path
        return workspace.document.projects.contains {
            URL(filePath: $0.folder).standardizedFileURL.path == standardized && $0.id != editing
        }
    }

    private var normalizedCloneURL: String {
        let trimmed = cloneURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return GitCloneURL.normalize(trimmed.hasPrefix("~/") ? expanded(trimmed) : trimmed)
    }

    private var cloneTarget: URL {
        GitCloneURL.target(requested: expanded(folder), url: normalizedCloneURL)
    }

    private func expanded(_ path: String) -> String {
        (path.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
    }

    private func loadInitial() {
        location = initialLocation
        if editing == nil, let initialFolder { folder = initialFolder }
        guard let editing, let project = workspace.document.project(editing) else { return }
        iconUrl = project.iconUrl ?? ""
        name = project.name
        folder = project.folder
        color = project.color
        autoWorktree = project.usesAutoWorktree
        worktreeMode = project.effectiveWorktreeMode
        graphifyEnabled = project.usesGraphify
        advanced = ProjectAdvancedDraft(project)
        location = workspace.document.location(of: editing) ?? .ungrouped
        nameEdited = true
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url { folder = url.path }
    }

    /// Fills the form from a saved marker (upstream `restoreDetected`); its agents come back on create.
    private func restore(_ marker: ProjectMarker) {
        restored = marker
        if !marker.name.isEmpty {
            name = marker.name
            nameEdited = true
        }
        if let markerColor = marker.color { color = markerColor }
        autoWorktree = marker.autoWorktree ?? false
        worktreeMode = marker.worktreeMode ?? .gitWorktree
    }

    private func save() {
        if isCloning {
            let url = normalizedCloneURL
            model.clone(url, into: cloneTarget) { cloned in
                create(folder: cloned.standardizedFileURL.path, githubURL: url.hasPrefix("/") ? nil : url)
            }
            return
        }
        let path = URL(filePath: expanded(folder)).standardizedFileURL.path
        let graphify: Bool? = graphifyEnabled ? true : nil
        if let editing {
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            let color = color ?? .blue
            let (auto, mode) = worktreeSettings
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.editProject")) { doc in
                doc.updateProject(editing) {
                    $0.iconUrl = ProjectImageInput.normalized(iconUrl)
                    $0.name = trimmed
                    $0.folder = path
                    $0.color = color
                    $0.autoWorktree = auto
                    $0.worktreeMode = mode
                    $0.graphifyEnabled = graphify
                    if metrics.isWebInterface { advanced.apply(to: &$0) }
                }
                if doc.location(of: editing) != location { doc.moveProject(editing, to: location, at: Int.max) }
            }
            writeMarker(editing)
            if metrics.isWebInterface {
                let watch = advanced.gsdWatcher
                Task {
                    if watch { try? await environment.multiagent.follow(projectID: editing.rawValue, folder: URL(filePath: path), by: .projectPreference) }
                    else { await environment.multiagent.unfollow(projectID: editing.rawValue, folder: URL(filePath: path), by: .projectPreference) }
                }
            }
            close()
        } else {
            create(folder: path, githubURL: nil)
        }
    }

    /// Defaults stay absent in the file, as upstream leaves them undefined.
    private var worktreeSettings: (Bool?, ProjectWorktreeMode?) {
        (autoWorktree ? true : nil, worktreeMode == .gitWorktree ? nil : worktreeMode)
    }

    private func create(folder path: String, githubURL: String?) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let color = color ?? .blue
        let (auto, mode) = worktreeSettings
        let marker = restored
        let agents = Set(AgentRegistry.builtin.kinds.map(\.rawValue))
        var created: ProjectID?
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addProject")) { doc in
            let id = doc.addProject(name: trimmed, folder: path, color: color, in: location)
            doc.updateProject(id) {
                marker?.apply(to: &$0, agents: agents)
                $0.iconUrl = ProjectImageInput.normalized(iconUrl)
                $0.name = trimmed
                $0.color = color
                $0.autoWorktree = auto
                $0.worktreeMode = mode
                $0.graphifyEnabled = graphifyEnabled ? true : nil
                if let githubURL { $0.githubURL = githubURL }
            }
            doc.open(id)
            created = id
        }
        if let created { writeMarker(created) }
        close()
    }

    /// Mirrors the project into its folder's `.alethe/project.json` (upstream `write_project_marker`),
    /// off the main thread; a folder that cannot be written is left alone, as upstream does.
    private func writeMarker(_ id: ProjectID) {
        guard let project = workspace.document.project(id) else { return }
        Task.detached(priority: .utility) { try? ProjectMarker.write(project) }
    }
}

/// Catalog keys of the detected stacks.
enum ProjectStackLabel {
    static func key(_ stack: ProjectStack) -> LocalizedStringKey {
        switch stack {
        case .web: "stack.web"
        case .cli: "stack.cli"
        case .desktop: "stack.desktop"
        case .fullstack: "stack.fullstack"
        case .unknown: "stack.unknown"
        }
    }
}
