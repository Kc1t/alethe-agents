import AletheDesign
import AletheGit
import AletheGitControl
import AletheModel
import SwiftUI

/// Git Control (P4-5; upstream `plugins/git-control`) for a project's folder: changes grouped
/// staged / unstaged / conflicts, stage and discard, commit with amend, branch switcher, and
/// fetch / pull / push. Clicking a file opens its diff in a diff pane of the project. Rendered for
/// the `GitControlPlugin` sheet contribution.
struct GitControlSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let projectID: ProjectID?
    var embedded = false
    @State var model: GitControlModel?
    @State var pendingDiscard: GitStatusEntry?
    @State var pendingDiscardPaths: PendingDiscard?
    @State var confirmingStageAll = false
    @State var tab = Tab.changes
    @State var history: GitHistoryModel?
    @State var creatingBranch = false

    enum Tab: Hashable { case changes, history }
    @Environment(\.dismiss) var dismiss
    @Environment(\.theme) var theme
    @Environment(\.metrics) var metrics

    var project: Project? { projectID.flatMap { workspace.document.project($0) } }

    @Environment(\.gitModalClose) var closeOverlay

    var body: some View {
        Group {
            if metrics.isWebInterface {
                webContent
            } else {
                nativeContent
            }
        }
    }

    var nativeContent: some View {
        sheetContent
        .frame(width: metrics.size(520), height: metrics.size(600))
        .navigationTitle(Text("git.title"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("git.close") { dismiss() }
                    .accessibilityIdentifier("git.close")
            }
        }
    }

    var sheetContent: some View {
        Group {
            if let model {
                content(model)
            } else {
                Text("git.noProject")
                    .foregroundStyle(theme[.textSecondary])
                    .padding(metrics.space(.xl))
            }
        }
        .task { await loadModel() }
        .onDisappear { model?.stop() }
        .accessibilityIdentifier("git.control")
    }

    func loadModel() async {
        guard let project else { return }
        let model = GitControlModel(folder: URL(filePath: project.folder, directoryHint: .isDirectory))
        self.model = model
        await model.start()
    }

    @ViewBuilder
    func content(_ model: GitControlModel) -> some View {
        VStack(spacing: 0) {
            if let error = model.error {
                errorBanner(error, model)
            }
            switch model.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .notARepository:
                notARepository(model)
            case .ready:
                repositoryView(model)
            }
        }
    }

    func errorBanner(_ error: String, _ model: GitControlModel) -> some View {
        HStack(alignment: .top) {
            Label {
                Text(verbatim: error).textSelection(.enabled)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.callout)
            .foregroundStyle(theme[.statusStopped])
            Spacer()
            Button { model.dismissError() } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("git.dismissError"))
        }
        .padding(metrics.space(.m))
        .accessibilityIdentifier("git.error")
    }

    func notARepository(_ model: GitControlModel) -> some View {
        VStack(spacing: metrics.space(.l)) {
            Text("git.notARepository")
                .foregroundStyle(theme[.textSecondary])
            Button("git.initialize") { model.initialize() }
                .disabled(model.busy)
                .accessibilityIdentifier("git.initialize")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Repository

    func repositoryView(_ model: GitControlModel) -> some View {
        VStack(spacing: 0) {
            header(model)
            Picker("git.tab", selection: $tab) {
                Text("git.tab.changes").tag(Tab.changes)
                Text("git.tab.history").tag(Tab.history)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, metrics.space(.l))
            .padding(.bottom, metrics.space(.m))
            .accessibilityIdentifier("git.tab")
            Divider()
            switch tab {
            case .changes:
                changes(model)
                Divider()
                commitBox(model)
            case .history:
                if let history {
                    GitGraphView(history: history)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task { history = makeHistory(model) }
                }
            }
        }
    }

    /// The History tab's model, created on first use for the discovered repository.
    func makeHistory(_ model: GitControlModel) -> GitHistoryModel? {
        guard let repository = model.repository else { return nil }
        return GitHistoryModel(repository: repository) { [weak model] in await model?.refresh() }
    }

    func header(_ model: GitControlModel) -> some View {
        let branch = model.status?.branch
        return VStack(alignment: .leading, spacing: metrics.space(.s)) {
            HStack(spacing: metrics.space(.m)) {
                Menu {
                    ForEach(model.branches) { item in
                        Button(item.name) { model.switchBranch(item.name) }
                            .disabled(item.isCurrent)
                    }
                    if !model.branches.isEmpty { Divider() }
                    Button("git.newBranch.menu") { creatingBranch = true }
                        .accessibilityIdentifier("git.newBranch")
                } label: {
                    Label {
                        if let head = branch?.head {
                            Text(verbatim: head)
                        } else {
                            Text("git.detached")
                        }
                    } icon: {
                        Image(systemName: "arrow.triangle.branch")
                    }
                }
                .fixedSize()
                .disabled(model.busy || model.status?.branch.oid == nil)
                .accessibilityIdentifier("git.branch")
                .sheet(isPresented: $creatingBranch) {
                    NewBranchSheet(model: model)
                }
                if let branch, branch.ahead > 0 || branch.behind > 0 {
                    Text(verbatim: "↑\(branch.ahead) ↓\(branch.behind)")
                        .font(metrics.font(.caption).monospacedDigit())
                        .foregroundStyle(theme[.textSecondary])
                        .accessibilityIdentifier("git.aheadBehind")
                }
                Spacer()
                remoteButton(model, .fetch, symbol: "arrow.triangle.2.circlepath", label: "git.fetch")
                remoteButton(model, .pull, symbol: "arrow.down", label: "git.pull")
                remoteButton(model, .push, symbol: "arrow.up", label: "git.push")
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help(Text("git.refresh"))
                    .accessibilityLabel(Text("git.refresh"))
                    .accessibilityIdentifier("git.refresh")
            }
            if model.remoteAction != nil {
                HStack(spacing: metrics.space(.s)) {
                    ProgressView().controlSize(.small)
                    Text(verbatim: model.progress ?? String(localized: "git.working"))
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textSecondary])
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .accessibilityIdentifier("git.progress")
            }
        }
        .padding(metrics.space(.l))
    }

    func remoteButton(_ model: GitControlModel, _ action: GitControlModel.RemoteAction,
                              symbol: String, label: LocalizedStringKey) -> some View {
        Button { model.remote(action) } label: { Image(systemName: symbol) }
            .buttonStyle(.borderless)
            .disabled(model.remoteAction != nil)
            .help(Text(label))
            .accessibilityLabel(Text(label))
            .accessibilityIdentifier("git.\(action)")
    }

    func changes(_ model: GitControlModel) -> some View {
        let status = model.status
        let groups = GitChangeGroups(status)
        let conflicts = groups.conflicts
        let staged = groups.staged
        let unstaged = groups.unstaged
        return List {
            if status?.isClean ?? true {
                Text("git.clean")
                    .foregroundStyle(theme[.textSecondary])
                    .accessibilityIdentifier("git.clean")
            }
            if !conflicts.isEmpty {
                Section("git.conflicts") {
                    ForEach(conflicts, id: \.path) { entry in
                        row(entry, model, staged: false) {
                            rowButton("plus", "git.markResolved") { model.stage([entry.path]) }
                        }
                    }
                }
            }
            if !staged.isEmpty {
                Section {
                    ForEach(staged, id: \.path) { entry in
                        row(entry, model, staged: true) {
                            rowButton("minus", "git.unstage") { model.unstage([entry.path]) }
                        }
                    }
                } header: {
                    sectionHeader("git.staged", count: staged.count, action: "git.unstageAll") { model.unstageAll() }
                }
            }
            if !unstaged.isEmpty {
                Section {
                    ForEach(unstaged, id: \.path) { entry in
                        row(entry, model, staged: false) {
                            rowButton("arrow.uturn.backward", "git.discard") { pendingDiscard = entry }
                            rowButton("plus", "git.stage") { model.stage([entry.path]) }
                        }
                    }
                } header: {
                    sectionHeader("git.changes", count: unstaged.count, action: "git.stageAll") { model.stageAll() }
                }
            }
            if let io = model.incomingOutgoing {
                commitSection("git.incoming", commits: io.incoming, id: "git.incoming")
                commitSection("git.outgoing", commits: io.outgoing, id: "git.outgoing")
            }
        }
        .listStyle(.inset)
        .disabled(model.busy)
        .accessibilityIdentifier("git.changesList")
        .confirmationDialog(Text("git.discard.title"), isPresented: discardPresented, presenting: pendingDiscard) { entry in
            Button("git.discard.confirm", role: .destructive) { model.discard(entry) }
                .accessibilityIdentifier("git.discard.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { entry in
            Text(verbatim: format("git.discard.message", entry.path))
        }
    }

    /// Incoming or outgoing commits against the upstream (P4-7; upstream `IncomingOutgoing`).
    @ViewBuilder
    func commitSection(_ title: LocalizedStringKey, commits: [GitCommit], id: String) -> some View {
        if !commits.isEmpty {
            Section {
                ForEach(commits) { commit in
                    HStack(spacing: metrics.space(.m)) {
                        Text(verbatim: String(commit.hash.prefix(7)))
                            .font(metrics.font(.caption).monospaced())
                            .foregroundStyle(theme[.textSecondary])
                        Text(verbatim: commit.subject).lineLimit(1)
                        Spacer()
                        Text(commit.date, style: .relative)
                            .font(metrics.font(.caption))
                            .foregroundStyle(theme[.textSecondary])
                    }
                    .help(Text(verbatim: commit.authorName))
                }
            } header: {
                HStack {
                    Text(title)
                    Text(verbatim: "\(commits.count)").foregroundStyle(theme[.textSecondary])
                }
            }
            .accessibilityIdentifier(id)
        }
    }

    var nativeDiscardPresented: Binding<Bool> {
        Binding { !metrics.isWebInterface && pendingDiscard != nil } set: { if !$0 { pendingDiscard = nil } }
    }

    var discardPresented: Binding<Bool> {
        Binding { pendingDiscard != nil } set: { if !$0 { pendingDiscard = nil } }
    }

    func sectionHeader(_ title: LocalizedStringKey, count: Int, action: LocalizedStringKey,
                               perform: @escaping () -> Void) -> some View {
        HStack {
            Text(title)
            Text(verbatim: "\(count)").foregroundStyle(theme[.textSecondary])
            Spacer()
            Button(action, action: perform)
                .buttonStyle(.borderless)
                .font(metrics.font(.caption))
        }
    }

    func row<Actions: View>(_ entry: GitStatusEntry, _ model: GitControlModel, staged: Bool,
                                    @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: metrics.space(.m)) {
            Text(verbatim: badge(entry, staged: staged))
                .font(metrics.font(.caption).monospaced().weight(.semibold))
                .foregroundStyle(badgeColor(entry, staged: staged))
                .frame(width: metrics.size(14))
            Button { openDiff(entry, staged: staged) } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: (entry.path as NSString).lastPathComponent)
                        .lineLimit(1)
                    let directory = (entry.path as NSString).deletingLastPathComponent
                    if !directory.isEmpty {
                        Text(verbatim: directory)
                            .font(metrics.font(.caption))
                            .foregroundStyle(theme[.textSecondary])
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(Text("git.openDiff"))
            actions()
        }
        .accessibilityIdentifier("git.file.\(entry.path)")
    }

    func rowButton(_ symbol: String, _ label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.borderless)
            .help(Text(label))
            .accessibilityLabel(Text(label))
    }

    func badge(_ entry: GitStatusEntry, staged: Bool) -> String {
        if entry.isConflict { return "!" }
        if entry.isUntracked { return "U" }
        let change = staged ? entry.index : entry.worktree
        return switch change {
        case .added?: "A"
        case .deleted?: "D"
        case .renamed?: "R"
        default: "M"
        }
    }

    func badgeColor(_ entry: GitStatusEntry, staged: Bool) -> Color {
        if entry.isConflict { return theme[.statusStopped] }
        return entry.isUntracked || (staged ? entry.index : entry.worktree) == .added
            ? theme[.statusActive] : theme[.textSecondary]
    }

    func commitBox(_ model: GitControlModel) -> some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: metrics.space(.m)) {
            TextField("git.commitMessage", text: $model.message, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("git.message")
            HStack {
                Toggle("git.amend", isOn: $model.amend)
                    .accessibilityIdentifier("git.amend")
                Spacer()
                Button("git.commit") { model.commit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canCommit)
                    .accessibilityIdentifier("git.commit")
            }
        }
        .padding(metrics.space(.l))
    }

    /// Opens the file's diff in a new diff pane of the project, then closes the sheet.
    func openDiff(_ entry: GitStatusEntry, staged: Bool) {
        guard let projectID else { return }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
            _ = $0.addPane(to: projectID, content: .diff(path: model?.folderRelativePath(entry.path) ?? entry.path, staged: staged))
        }
        if metrics.isWebInterface, let closeOverlay { closeOverlay() } else { dismiss() }
    }
}

/// A new branch from the current HEAD, with its name validated as it is typed and an optional switch.
struct NewBranchSheet: View {
    let model: GitControlModel
    @State var name = ""
    @State var switchTo = true
    @Environment(\.dismiss) var dismiss
    @Environment(\.theme) var theme
    @Environment(\.metrics) var metrics

    var issue: GitBranchName.Issue? { model.branchNameIssue(name) }

    @Environment(\.gitModalClose) var closeOverlay
    @FocusState var webFocused: Bool

    var body: some View {
        if metrics.isWebInterface { webContent } else { nativeContent }
    }

    var webContent: some View {
        GitWebModal(close: { closeOverlay?() }) { Text("git.newBranch.title") } content: {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                if let head = model.status?.branch.head {
                    Text(verbatim: format("git.newBranch.from", head))
                        .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                }
                ProjectGroupWebField(title: "git.newBranch.name") {
                    TextField("git.newBranch.name", text: $name)
                        .modifier(ProjectGroupWebInput(focus: $webFocused))
                        .onSubmit(create).accessibilityIdentifier("git.newBranch.name")
                }
                if let message = issueMessage {
                    Text(message).font(metrics.font(size: 12)).foregroundStyle(theme[.statusOffline])
                        .accessibilityIdentifier("git.newBranch.issue")
                }
                Toggle("git.newBranch.switch", isOn: $switchTo)
                    .toggleStyle(.checkbox).accessibilityIdentifier("git.newBranch.switch")
            }
        } footer: {
            Spacer(minLength: 0)
            Button("editor.cancel") { closeOverlay?() }
            Button("git.newBranch.create", action: create)
                .buttonStyle(AletheButtonStyle(.primary)).keyboardShortcut(.defaultAction)
                .disabled(issue != nil).accessibilityIdentifier("git.newBranch.create")
        }
        .onAppear { webFocused = true }
        .accessibilityIdentifier("git.newBranch.sheet")
    }

    var nativeContent: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            Text("git.newBranch.title").font(metrics.font(.headline))
            if let head = model.status?.branch.head {
                Text(verbatim: format("git.newBranch.from", head))
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textSecondary])
            }
            TextField("git.newBranch.name", text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit(create)
                .accessibilityIdentifier("git.newBranch.name")
            if let message = issueMessage {
                Text(message)
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.statusStopped])
                    .accessibilityIdentifier("git.newBranch.issue")
            }
            Toggle("git.newBranch.switch", isOn: $switchTo)
                .accessibilityIdentifier("git.newBranch.switch")
            HStack {
                Spacer()
                Button("editor.cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("git.newBranch.create", action: create)
                    .keyboardShortcut(.defaultAction)
                    .disabled(issue != nil)
                    .accessibilityIdentifier("git.newBranch.create")
            }
        }
        .padding(metrics.space(.l))
        .frame(width: metrics.size(340))
        .accessibilityIdentifier("git.newBranch.sheet")
    }

    /// Nothing while the field is empty; the rule broken otherwise.
    var issueMessage: LocalizedStringKey? {
        switch issue {
        case .invalid: "git.newBranch.invalid"
        case .exists: "git.newBranch.exists"
        case .empty, nil: nil
        }
    }

    func create() {
        guard issue == nil else { return }
        model.createBranch(name, switchTo: switchTo)
        if metrics.isWebInterface, let closeOverlay { closeOverlay() } else { dismiss() }
    }
}
