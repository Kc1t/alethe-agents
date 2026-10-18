import AletheDesign
import AletheFoundation
import AletheGit
import AletheModel
import SwiftUI

/// Worktrees of a project (P4-9; upstream worktree panel): the agent environments under
/// `.alethe/worktrees/`, with lock/unlock, fetch branch, commit pending, remove and stale cleanup.
struct WorktreesSheet: View {
    let workspace: WorkspaceModel
    let projectID: ProjectID?
    @State private var model: WorktreesModel?
    @State private var selection: String?
    @State private var lockReason = ""
    @State private var commitMessage = ""
    @State private var askLock = false
    @State private var askCommit = false
    @State private var confirmRemove = false
    @State private var confirmCleanup = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var project: Project? { projectID.flatMap { workspace.document.project($0) } }

    @Environment(\.gitModalClose) private var closeOverlay

    var body: some View {
        Group {
            if metrics.isWebInterface {
                webContent
            } else {
                nativeContent
            }
        }
    }

    private var nativeContent: some View {
        sheetContent
        .frame(width: metrics.size(620), height: metrics.size(440))
        .navigationTitle(Text("worktrees.title"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("worktrees.close") { dismiss() }
                    .accessibilityIdentifier("worktrees.close")
            }
        }
    }

    private var webContent: some View {
        GitWebModal(close: { closeOverlay?() ?? dismiss() }, closeIdentifier: "worktrees.close") {
            Text("worktrees.title")
        } content: {
            sheetContent.frame(height: metrics.size(360))
                .buttonStyle(AletheButtonStyle(size: .small))
        } footer: { EmptyView() }
        .frame(width: closeOverlay == nil ? metrics.size(620) : nil)
    }

    private var sheetContent: some View {
        Group {
            if let model {
                content(model)
            } else {
                Text("worktrees.noProject")
                    .foregroundStyle(theme[.textSecondary])
                    .padding(metrics.space(.xl))
            }
        }
        .task {
            guard let project else { return }
            let model = WorktreesModel(folder: URL(filePath: project.folder, directoryHint: .isDirectory))
            self.model = model
            await model.refresh()
        }
        .accessibilityIdentifier("worktrees.sheet")
    }

    private func content(_ model: WorktreesModel) -> some View {
        let selected = model.rows.first { $0.id == selection }
        return VStack(alignment: .leading, spacing: 0) {
            if let error = model.error {
                Label { Text(verbatim: error).textSelection(.enabled) } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.statusStopped])
                .padding(metrics.space(.m))
                .accessibilityIdentifier("worktrees.error")
            }
            if let note = model.note {
                Text(verbatim: note)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .padding(.horizontal, metrics.space(.m))
                    .padding(.vertical, metrics.space(.xs))
                    .accessibilityIdentifier("worktrees.note")
            }
            if model.loading && model.rows.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.rows.isEmpty {
                Text("worktrees.empty")
                    .foregroundStyle(theme[.textSecondary])
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("worktrees.empty")
            } else {
                if metrics.isWebInterface {
                    ScrollView {
                        VStack(spacing: metrics.size(8)) {
                            ForEach(model.rows) { row in
                                Button { selection = row.id } label: {
                                    GitWorktreeWebRow(row: row, selected: selection == row.id)
                                }
                                .buttonStyle(.plain)
                                .contextMenu { rowActions(row, model) }
                            }
                        }
                    }
                    .accessibilityIdentifier("worktrees.list")
                } else {
                List(model.rows, selection: $selection) { row in
                    rowView(row)
                        .tag(row.id)
                        .contextMenu { rowActions(row, model) }
                }
                .accessibilityIdentifier("worktrees.list")
                }
            }
            Divider()
            HStack {
                if model.running {
                    ProgressView().controlSize(.small)
                }
                Button("worktrees.cleanup") { confirmCleanup = true }
                    .disabled(model.running || model.root == nil)
                    .accessibilityIdentifier("worktrees.cleanup")
                Button("worktrees.refresh") { Task { await model.refresh() } }
                    .disabled(model.running)
                    .accessibilityIdentifier("worktrees.refresh")
                Spacer()
                if let selected {
                    rowButtons(selected, model)
                }
            }
            .padding(metrics.space(.l))
        }
        .webPrompt(isPresented: $askLock, message: String(localized: "worktrees.lock.title"),
                   confirmTitle: String(localized: "worktrees.lock")) { reason in
            if let selected { model.lock(selected, reason: reason) }
        }
        .alert("worktrees.lock.title", isPresented: Binding(get: { !metrics.isWebInterface && askLock }, set: { askLock = $0 })) {
            TextField(text: $lockReason) { Text("worktrees.lock.reason") }
                .accessibilityIdentifier("worktrees.lock.reason")
            Button("worktrees.lock") { if let selected { model.lock(selected, reason: lockReason) } }
            Button("editor.cancel", role: .cancel) {}
        } message: { Text("worktrees.lock.message") }
        .alert("worktree.commit.title", isPresented: Binding(get: { !metrics.isWebInterface && askCommit }, set: { askCommit = $0 })) {
            TextField(text: $commitMessage, prompt: Text(verbatim: GitWorktrees.defaultCommitMessage)) {
                Text("worktree.commit.message")
            }
            .accessibilityIdentifier("worktrees.commit.message")
            Button("worktree.commit.confirm") { if let selected { model.commit(selected, message: commitMessage) } }
            Button("editor.cancel", role: .cancel) {}
        } message: { Text("worktree.commit.message") }
        .gitWebSheet(isPresented: Binding(get: { metrics.isWebInterface && askCommit }, set: { askCommit = $0 }), width: 520) {
            if let selected {
                ConfirmWorktreeCommitWebModal(folder: URL(filePath: selected.info.path), branch: selected.info.branch,
                                              message: $commitMessage) {
                    model.commit(selected, message: commitMessage)
                }
            }
        }
        .webConfirm(isPresented: $confirmRemove, message: String(localized: "worktree.remove.title") + "\n\n" + String(localized: "worktree.remove.detail"),
                    confirmTitle: String(localized: "worktree.remove"), destructive: true) {
            if let selected { model.remove(selected) { detachTabs(from: $0) } }
        }
        .webConfirm(isPresented: $confirmCleanup, message: String(localized: "worktrees.cleanup.confirm") + "\n\n" + String(localized: "worktrees.cleanup.detail"),
                    confirmTitle: String(localized: "worktrees.cleanup"), destructive: true) {
            model.cleanup()
        }
        .confirmationDialog("worktree.remove.title", isPresented: Binding(get: { !metrics.isWebInterface && confirmRemove }, set: { confirmRemove = $0 })) {
            Button("worktree.remove", role: .destructive) {
                if let selected { model.remove(selected) { detachTabs(from: $0) } }
            }
        } message: { Text("worktree.remove.detail") }
        .confirmationDialog("worktrees.cleanup.confirm", isPresented: Binding(get: { !metrics.isWebInterface && confirmCleanup }, set: { confirmCleanup = $0 })) {
            Button("worktrees.cleanup", role: .destructive) { model.cleanup() }
        } message: { Text("worktrees.cleanup.detail") }
    }

    private func rowView(_ row: WorktreesModel.Row) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            HStack(spacing: metrics.space(.s)) {
                Image(systemName: row.info.mode == .gitWorktree ? "arrow.triangle.branch" : "doc.on.doc")
                    .foregroundStyle(theme[.textSecondary])
                Text(verbatim: row.info.branch.isEmpty ? row.info.agentId : row.info.branch)
                    .font(metrics.font(.body).monospaced())
                Text(row.info.mode == .gitWorktree ? "newTerminal.worktree.mode.gitWorktree" : "newTerminal.worktree.mode.localCopy")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
                Spacer()
                if row.isLocked {
                    Label("worktrees.locked", systemImage: "lock.fill")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.statusStopped])
                        .accessibilityIdentifier("worktrees.row.\(row.id).locked")
                }
            }
            Text(verbatim: row.info.path)
                .font(metrics.font(.footnote).monospaced())
                .foregroundStyle(theme[.textSecondary])
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            if row.isLocked, let reason = row.lockReason, !reason.isEmpty {
                Text(verbatim: String(format: String(localized: "worktrees.lockReason"), reason))
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .accessibilityIdentifier("worktrees.row.\(row.id).reason")
            }
        }
        .padding(.vertical, metrics.space(.xs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("worktrees.row.\(row.id)")
    }

    @ViewBuilder
    private func rowButtons(_ row: WorktreesModel.Row, _ model: WorktreesModel) -> some View {
        if row.isLocked {
            Button("worktrees.unlock") { model.unlock(row) }
                .disabled(model.running)
                .accessibilityIdentifier("worktrees.unlock")
        } else {
            Button("worktrees.lockEllipsis") { lockReason = ""; askLock = true }
                .disabled(model.running || row.info.mode != .gitWorktree)
                .accessibilityIdentifier("worktrees.lock")
        }
        Button("worktrees.fetchBranch") { model.fetchBranch(row) }
            .disabled(model.running || row.info.mode != .localCopy)
            .help(Text("worktrees.fetchBranch.help"))
            .accessibilityIdentifier("worktrees.fetchBranch")
        Button("worktree.commitEllipsis") { commitMessage = ""; askCommit = true }
            .disabled(model.running)
            .accessibilityIdentifier("worktrees.commit")
        Button("worktree.remove", role: .destructive) { confirmRemove = true }
            .disabled(model.running || row.isLocked)
            .help(Text(row.isLocked ? "worktrees.remove.lockedHelp" : "worktree.remove.detail"))
            .accessibilityIdentifier("worktrees.remove")
    }

    @ViewBuilder
    private func rowActions(_ row: WorktreesModel.Row, _ model: WorktreesModel) -> some View {
        if row.isLocked {
            Button("worktrees.unlock") { model.unlock(row) }
        } else if row.info.mode == .gitWorktree {
            Button("worktrees.lockEllipsis") { selection = row.id; lockReason = ""; askLock = true }
        }
        if row.info.mode == .localCopy {
            Button("worktrees.fetchBranch") { model.fetchBranch(row) }
        }
        Button("worktree.commitEllipsis") { selection = row.id; commitMessage = ""; askCommit = true }
        Divider()
        Button("worktree.remove") { selection = row.id; confirmRemove = true }
            .disabled(row.isLocked)
    }

    /// Tabs that ran in a removed worktree fall back to the project folder.
    private func detachTabs(from agentID: String) {
        guard let project else { return }
        let tabs = project.panes.flatMap(\.tabs).filter { $0.worktreeAgentID == agentID }.map(\.id)
        guard !tabs.isEmpty else { return }
        workspace.update { doc in
            for tab in tabs {
                doc.updateTab(tab) {
                    $0.worktreeAgentID = nil
                    $0.worktreeBranch = nil
                    $0.workingDirectory = nil
                }
            }
        }
    }
}

/// Worktree list of one repository: agent environments joined with git's lock state. Git runs off
/// the main thread; every failure lands in `error`.
@MainActor @Observable
final class WorktreesModel {
    struct Row: Identifiable, Equatable {
        var info: WorktreeInfo
        var isLocked: Bool
        var lockReason: String?
        var id: String { info.agentId }
    }

    let folder: URL
    private let git = GitWorktrees()
    private(set) var root: URL?
    private(set) var rows: [Row] = []
    private(set) var loading = true
    private(set) var running = false
    private(set) var error: String? { didSet { if error != oldValue { AppLog.shown(error, .git) } } }
    /// Outcome of the last action.
    private(set) var note: String?

    init(folder: URL) { self.folder = folder }

    func refresh() async {
        defer { loading = false }
        do {
            let root = try await git.mainRepositoryRoot(folder)
            self.root = root
            let infos = try await git.list(repo: root)
            let entries = try await git.gitWorktrees(repo: root)
            rows = Self.join(infos, entries)
            error = nil
        } catch {
            rows = []
            self.error = Self.describe(error)
        }
    }

    /// Lock state comes from `git worktree list`; paths compare after resolving symlinks.
    static func join(_ infos: [WorktreeInfo], _ entries: [GitWorktreeEntry]) -> [Row] {
        func key(_ path: String) -> String { URL(filePath: path).resolvingSymlinksInPath().standardizedFileURL.path }
        let byPath = Dictionary(entries.map { (key($0.path), $0) }, uniquingKeysWith: { first, _ in first })
        return infos.map { info in
            let entry = byPath[key(info.path)]
            return Row(info: info, isLocked: entry?.isLocked ?? false, lockReason: entry?.lockReason)
        }
    }

    func lock(_ row: Row, reason: String) {
        perform { git, root in try await git.lock(repo: root, agentId: row.id, reason: reason); return nil }
    }

    func unlock(_ row: Row) {
        perform { git, root in try await git.unlock(repo: root, agentId: row.id); return nil }
    }

    func fetchBranch(_ row: Row) {
        perform { git, root in
            try await git.fetchBranch(repo: root, agentId: row.id)
            return String(format: String(localized: "worktrees.fetched"), row.info.branch)
        }
    }

    func commit(_ row: Row, message: String) {
        perform { git, root in
            let committed = try await git.commitPending(repo: root, agentId: row.id, message: message)
            return committed ? String(localized: "worktrees.committed") : String(localized: "worktree.nothingToCommit")
        }
    }

    /// Removes the environment (never a locked one) and reports the agent id on success.
    func remove(_ row: Row, onRemoved: @escaping (String) -> Void) {
        guard !row.isLocked else {
            error = String(format: String(localized: "worktrees.error.locked"), row.lockReason ?? "")
            return
        }
        perform { git, root in
            try await git.remove(repo: root, agentId: row.id, force: true)
            onRemoved(row.id)
            return String(format: String(localized: "worktrees.removed"), row.info.branch)
        }
    }

    func cleanup() {
        perform { git, root in
            let removed = try await git.cleanup(repo: root)
            return removed.isEmpty
                ? String(localized: "worktrees.cleanup.none")
                : String(format: String(localized: "worktrees.cleanup.done"), removed.joined(separator: ", "))
        }
    }

    private func perform(_ action: @escaping @MainActor (GitWorktrees, URL) async throws -> String?) {
        guard let root, !running else { return }
        running = true
        error = nil
        note = nil
        let git = git
        Task {
            do {
                note = try await action(git, root)
            } catch {
                self.error = Self.describe(error)
            }
            running = false
            await refresh()
        }
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case GitWorktreeError.adminLocked(let reason):
            String(format: String(localized: "worktrees.error.locked"), reason)
        case GitWorktreeError.notFound:
            String(localized: "worktrees.error.notFound")
        case GitError.notARepository:
            String(localized: "worktrees.error.notRepository")
        default:
            NewTerminalSheet.describe(error)
        }
    }
}
