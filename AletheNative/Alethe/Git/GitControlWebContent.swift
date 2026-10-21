import AletheDesign
import AletheGit
import AletheGitControl
import AletheModel
import AppKit
import SwiftUI

extension GitControlSheet {
    var webContent: some View {
        Group {
            if embedded {
                ScrollView { webPanelBody }
            } else {
                GitWebModal(close: closeWeb, closeIdentifier: "git.close") { Text("git.title") } content: {
                    webPanelBody
                } footer: { EmptyView() }
                .frame(width: closeOverlay == nil ? metrics.size(520) : nil)
            }
        }
        .task { await loadModel() }
        .onDisappear { model?.stop() }
        .gitWebSheet(isPresented: $creatingBranch, width: 440) {
            if let model { NewBranchSheet(model: model) }
        }
        .webConfirm(isPresented: discardPresented,
                    message: pendingDiscard.map { format("git.discard.message", $0.path) } ?? "",
                    title: String(localized: "git.discard.title"),
                    confirmTitle: String(localized: "git.discard.confirm"), destructive: true) {
            if let entry = pendingDiscard { model?.discard(entry) }
        }
        .webConfirm(isPresented: Binding(get: { pendingDiscardPaths != nil }, set: { if !$0 { pendingDiscardPaths = nil } }),
                    message: pendingDiscardPaths.map { String(format: String(localized: "git.web.confirm.discard"), $0.paths.count) } ?? "",
                    title: String(localized: "git.discard.title"),
                    confirmTitle: String(localized: "git.discard.confirm"), destructive: true) {
            if let pending = pendingDiscardPaths { model?.discard(paths: pending.paths, untracked: pending.untracked) }
        }
        .webConfirm(isPresented: $confirmingStageAll, message: String(localized: "git.web.confirm.stageAllCommit"),
                    confirmTitle: String(localized: "git.commit")) {
            model?.commitWeb(stagingAll: true)
        }
        .confirmationDialog(Text("git.discard.title"), isPresented: nativeDiscardPresented, presenting: pendingDiscard) { entry in
            Button("git.discard.confirm", role: .destructive) { model?.discard(entry) }
                .accessibilityIdentifier("git.discard.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { entry in Text(verbatim: format("git.discard.message", entry.path)) }
        .accessibilityIdentifier("git.control")
    }

    private var webPanelBody: some View {
        VStack(spacing: 0) {
            if let model {
                if let error = model.error { errorBanner(error, model) }
                switch model.phase {
                case .loading: ProgressView().padding(metrics.size(24))
                case .notARepository: notARepository(model).frame(minHeight: metrics.size(180))
                case .ready: webRepository(model)
                }
            } else { Text("git.noProject").foregroundStyle(theme[.fgMuted]) }
        }
    }

    func closeWeb() { if let closeOverlay { closeOverlay() } else { dismiss() } }

    /// GitControl.module.css: repoHeader 48, branchRow 30, commitBox 9×10 and compact groups.
    func webRepository(_ model: GitControlModel) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(8)) {
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(verbatim: project?.name ?? model.folder.lastPathComponent)
                        .font(metrics.font(size: 11, weight: 650))
                    Text(verbatim: model.root?.path ?? model.folder.path)
                        .font(metrics.font(size: 9)).foregroundStyle(theme[.fgFaint])
                }.lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Button { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: model.root?.path ?? model.folder.path) } label: {
                    Image(systemName: "folder.badge.magnifyingglass").font(metrics.font(size: 13))
                }
                .buttonStyle(AletheIconButtonStyle(side: 24)).accessibilityLabel(Text("gitModals.revealFolder"))
                Button { Task { await model.refresh() } } label: {
                    Image(systemName: "arrow.clockwise").font(metrics.font(size: 13))
                }
                .buttonStyle(AletheIconButtonStyle(side: 24)).disabled(model.busy)
                .accessibilityLabel(Text("git.refresh")).accessibilityIdentifier("git.refresh")
            }
            .padding(.leading, metrics.size(12)).padding(.trailing, metrics.size(10))
            .padding(.vertical, metrics.size(7)).frame(minHeight: metrics.size(48))
            webDivider
            HStack(spacing: metrics.size(6)) {
                Image(systemName: "arrow.triangle.branch").font(metrics.font(size: 13))
                WebMenu {
                    ForEach(model.branches) { item in
                        Button { model.switchBranch(item.name) } label: { Text(verbatim: item.name) }.disabled(item.isCurrent)
                    }
                    Button("git.newBranch.menu") { creatingBranch = true }.accessibilityIdentifier("git.newBranch")
                    Divider()
                    Button("git.fetch") { model.remote(.fetch) }.accessibilityIdentifier("git.fetch")
                    Button("git.pull") { model.remote(.pull) }.accessibilityIdentifier("git.pull")
                    Button("git.push") { model.remote(.push) }.accessibilityIdentifier("git.push")
                } label: {
                    Text(verbatim: model.status?.branch.head ?? String(localized: "git.detached"))
                }
                .menuStyle(.borderlessButton).fixedSize().accessibilityIdentifier("git.branch")
                .disabled(model.busy || model.status?.branch.oid == nil)
                Spacer(minLength: 0)
                if model.status?.branch.upstream != nil || model.status?.branch.head != nil {
                    webSyncButton(model)
                }
            }
            .font(metrics.monoFont(size: 10, weight: .regular)).foregroundStyle(theme[.fgMuted])
            .padding(.leading, metrics.size(12)).padding(.trailing, metrics.size(8)).frame(minHeight: metrics.size(30))
            webDivider
            VStack(spacing: metrics.size(6)) {
                TextEditor(text: Bindable(model).message)
                    .font(metrics.font(size: 11)).scrollContentBackground(.hidden)
                    .frame(height: metrics.size(48)).modifier(GitWebEditor())
                    .overlay(alignment: .topLeading) {
                        if model.message.isEmpty {
                            Text("git.web.commit.placeholder").font(metrics.font(size: 11))
                                .foregroundStyle(theme[.fgFaint]).allowsHitTesting(false)
                                .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(7))
                        }
                    }
                    .accessibilityLabel(Text("git.commitMessage")).accessibilityIdentifier("git.message")
                HStack(spacing: metrics.size(6)) {
                    Button { requestCommit(model) } label: {
                        HStack(spacing: metrics.size(6)) {
                            Image(systemName: "checkmark").font(metrics.font(size: 14))
                            Text(model.busy ? "git.web.commit.busy" : "git.commit")
                                .font(metrics.font(size: 11, weight: .semibold))
                        }
                        .foregroundStyle(theme[.accentOn])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(30))
                        .background(theme[.accent], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                        .opacity(model.canCommitWeb ? 1 : 0.42)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.return, modifiers: .command).disabled(!model.canCommitWeb)
                    .accessibilityIdentifier("git.commit")
                    webSyncWide(model)
                }
                Toggle("git.amend", isOn: Bindable(model).amend)
                    .toggleStyle(.checkbox).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("git.amend")
            }.padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(9))
            webDivider
            HStack(spacing: metrics.size(6)) {
                Button("git.tab.changes") { tab = .changes }
                Button("git.tab.history") { tab = .history; if history == nil { history = makeHistory(model) } }
            }
            .buttonStyle(AletheButtonStyle(size: .small)).padding(.vertical, metrics.size(8))
            .accessibilityIdentifier("git.tab")
            if tab == .history, let history {
                GitGraphView(history: history).frame(height: metrics.size(380))
            } else {
                let groups = GitChangeGroups(model.status)
                let changes = groups.unstaged.filter { !$0.isUntracked }
                let untracked = groups.unstaged.filter(\.isUntracked)
                VStack(spacing: 0) {
                    webGroup(.staged, "git.web.group.staged", groups.staged, model)
                    webGroup(.conflicts, "git.web.group.conflicts", groups.conflicts, model)
                    webGroup(.changes, "git.web.group.changes", changes, model)
                    webGroup(.untracked, "git.web.group.untracked", untracked, model)
                    if model.status?.isClean == true {
                        VStack(spacing: metrics.size(6)) {
                            Image(systemName: "checkmark").font(metrics.font(size: 18)).foregroundStyle(theme[.statusWorking])
                            Text("git.web.clean.title").font(metrics.font(size: 12, weight: .semibold)).foregroundStyle(theme[.fg])
                            Text("git.web.clean.description").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                                .lineSpacing(metrics.size(3)).multilineTextAlignment(.center).frame(maxWidth: metrics.size(240))
                        }
                        .padding(.horizontal, metrics.size(16)).padding(.vertical, metrics.size(24))
                        .frame(maxWidth: .infinity, minHeight: metrics.size(150)).accessibilityIdentifier("git.clean")
                    }
                }.padding(.bottom, metrics.size(8)).accessibilityIdentifier("git.changesList")
            }
            if let io = model.incomingOutgoing {
                webCommits("git.incoming", commits: io.incoming, identifier: "git.incoming")
                webCommits("git.outgoing", commits: io.outgoing, identifier: "git.outgoing")
            }
            if let progress = model.progress {
                Text(verbatim: progress).font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                    .lineLimit(1).accessibilityIdentifier("git.progress")
            }
        }
    }

    @ViewBuilder
    func webCommits(_ title: LocalizedStringKey, commits: [GitCommit], identifier: String) -> some View {
        if !commits.isEmpty {
            VStack(alignment: .leading, spacing: metrics.size(6)) {
                Text(title).font(metrics.font(size: 10, weight: .bold)).textCase(.uppercase)
                ForEach(commits) { commit in
                    HStack(spacing: metrics.size(6)) {
                        Text(verbatim: String(commit.hash.prefix(7))).font(metrics.monoFont(size: 10, weight: .regular))
                            .foregroundStyle(theme[.fgFaint])
                        Text(verbatim: commit.subject).font(metrics.font(size: 11)).lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(metrics.size(8))
            .accessibilityIdentifier(identifier)
        }
    }

    var webDivider: some View { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }

    @ViewBuilder
    func webGroup(_ kind: GitWebChangeGroup.Kind, _ title: LocalizedStringKey, _ entries: [GitStatusEntry],
                  _ model: GitControlModel) -> some View {
        let staged = kind == .staged
        let discardable = kind == .changes || kind == .untracked
        GitWebChangeGroup(
            kind: kind, title: title, entries: entries, busy: model.busy,
            primary: { paths in if staged { model.unstage(paths) } else { model.stage(paths) } },
            discard: discardable ? { paths in pendingDiscardPaths = PendingDiscard(paths: paths, untracked: kind == .untracked) } : nil,
            open: { entry in
                if kind == .untracked, addToGridAvailable(entry.path, model) { _ = addToGrid(entry.path, model) }
                else { openDiff(entry, staged: staged) }
            },
            reveal: { path in revealPath(path, model) },
            addToGrid: { addToGrid($0, model) },
            addToGridAvailable: { addToGridAvailable($0, model) })
    }

    private func absolute(_ path: String, _ model: GitControlModel) -> String {
        (model.root ?? model.folder).appending(path: path).path
    }

    func revealPath(_ path: String, _ model: GitControlModel) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: absolute(path, model))])
    }

    func addToGridAvailable(_ path: String, _ model: GitControlModel) -> Bool {
        projectID != nil && PaneContent.forFile(absolute(path, model)) != nil
    }

    func addToGrid(_ path: String, _ model: GitControlModel) -> Bool {
        guard let projectID, let content = PaneContent.forFile(absolute(path, model)) else { return false }
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.addContent")) {
            _ = $0.addPane(to: projectID, content: content)
        }
        if !embedded { closeWeb() }
        return true
    }

    /// Web `commit`: with nothing staged it asks before staging everything.
    func requestCommit(_ model: GitControlModel) {
        guard model.canCommitWeb else { return }
        if model.commitNeedsStageAll, model.status?.entries.contains(where: \.isConflict) != true {
            confirmingStageAll = true
        } else {
            model.commitWeb(stagingAll: false)
        }
    }

    private func webSyncTitle(_ model: GitControlModel) -> String {
        String(format: String(localized: "git.web.sync.title"), model.status?.branch.behind ?? 0, model.status?.branch.ahead ?? 0)
    }

    /// `.syncButton`: the small refresh icon with the behind / ahead counts.
    func webSyncButton(_ model: GitControlModel) -> some View {
        let detached = model.status?.branch.head == nil
        let working = model.remoteAction == .sync
        return Button { model.remote(.sync) } label: {
            HStack(spacing: metrics.size(6)) {
                Image(systemName: "arrow.triangle.2.circlepath").font(metrics.font(size: 12))
                HStack(spacing: metrics.size(6)) {
                    HStack(spacing: metrics.size(1)) {
                        Image(systemName: "arrow.down").font(metrics.font(size: 11))
                        Text(verbatim: "\(model.status?.branch.behind ?? 0)")
                    }
                    HStack(spacing: metrics.size(1)) {
                        Image(systemName: "arrow.up").font(metrics.font(size: 11))
                        Text(verbatim: "\(model.status?.branch.ahead ?? 0)")
                    }
                }
            }
            .foregroundStyle(theme[working ? .fg : .fgMuted])
            .padding(.horizontal, metrics.size(7)).frame(height: metrics.size(22))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(model.busy || model.remoteAction != nil || detached ? 0.4 : 1)
        .disabled(model.busy || model.remoteAction != nil || detached)
        .help(Text(verbatim: webSyncTitle(model)))
        .accessibilityLabel(Text(verbatim: webSyncTitle(model)))
        .accessibilityIdentifier("git.sync")
    }

    /// `.syncWide`: the labelled Sync button next to Commit.
    func webSyncWide(_ model: GitControlModel) -> some View {
        let detached = model.status?.branch.head == nil
        return Button { model.remote(.sync) } label: {
            HStack(spacing: metrics.size(6)) {
                Image(systemName: "arrow.triangle.2.circlepath").font(metrics.font(size: 13))
                Text("git.web.sync.action").font(metrics.font(size: 11, weight: .semibold))
            }
            .foregroundStyle(theme[.fg])
            .padding(.horizontal, metrics.size(12)).frame(minHeight: metrics.size(30))
            .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(4)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(4)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .opacity(model.busy || model.remoteAction != nil || detached ? 0.42 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.busy || model.remoteAction != nil || detached)
        .help(Text(verbatim: webSyncTitle(model)))
        .accessibilityIdentifier("git.syncWide")
    }
}

struct PendingDiscard: Equatable {
    var paths: [String]
    var untracked: Bool
}
