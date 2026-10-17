import AletheDesign
import AletheGit
import AletheGitControl
import AppKit
import SwiftUI

extension GitControlSheet {
    var webContent: some View {
        GitWebModal(close: closeWeb, closeIdentifier: "git.close") { Text("git.title") } content: {
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
        } footer: { EmptyView() }
        .frame(width: closeOverlay == nil ? metrics.size(520) : nil)
        .task { await loadModel() }
        .onDisappear { model?.stop() }
        .gitWebSheet(isPresented: $creatingBranch, width: 440) {
            if let model { NewBranchSheet(model: model) }
        }
        .confirmationDialog(Text("git.discard.title"), isPresented: discardPresented, presenting: pendingDiscard) { entry in
            Button("git.discard.confirm", role: .destructive) { model?.discard(entry) }
                .accessibilityIdentifier("git.discard.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { entry in Text(verbatim: format("git.discard.message", entry.path)) }
        .accessibilityIdentifier("git.control")
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
                Menu {
                    ForEach(model.branches) { item in
                        Button { model.switchBranch(item.name) } label: { Text(verbatim: item.name) }.disabled(item.isCurrent)
                    }
                    Button("git.newBranch.menu") { creatingBranch = true }.accessibilityIdentifier("git.newBranch")
                } label: {
                    Text(verbatim: model.status?.branch.head ?? String(localized: "git.detached"))
                }
                .menuStyle(.borderlessButton).fixedSize().accessibilityIdentifier("git.branch")
                .disabled(model.busy || model.status?.branch.oid == nil)
                Spacer(minLength: 0)
                if let branch = model.status?.branch {
                    Text(verbatim: "↓\(branch.behind) ↑\(branch.ahead)").accessibilityIdentifier("git.aheadBehind")
                }
                remoteButton(model, .fetch, symbol: "arrow.triangle.2.circlepath", label: "git.fetch")
                remoteButton(model, .pull, symbol: "arrow.down", label: "git.pull")
                remoteButton(model, .push, symbol: "arrow.up", label: "git.push")
            }
            .font(metrics.monoFont(size: 10, weight: .regular)).foregroundStyle(theme[.fgMuted])
            .padding(.leading, metrics.size(12)).padding(.trailing, metrics.size(8)).frame(minHeight: metrics.size(30))
            webDivider
            VStack(spacing: metrics.size(6)) {
                TextEditor(text: Bindable(model).message)
                    .font(metrics.font(size: 11)).scrollContentBackground(.hidden)
                    .frame(height: metrics.size(48)).modifier(GitWebEditor())
                    .accessibilityLabel(Text("git.commitMessage")).accessibilityIdentifier("git.message")
                HStack(spacing: metrics.size(6)) {
                    Button("git.commit") { model.commit() }
                        .buttonStyle(AletheButtonStyle(.primary, size: .small))
                        .keyboardShortcut(.return, modifiers: .command).disabled(!model.canCommit)
                        .accessibilityIdentifier("git.commit")
                    Toggle("git.amend", isOn: Bindable(model).amend)
                        .toggleStyle(.checkbox).accessibilityIdentifier("git.amend")
                    Spacer(minLength: 0)
                }
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
                VStack(spacing: 0) {
                    webGroup("git.staged", entries: groups.staged, model: model, staged: true)
                    webGroup("git.conflicts", entries: groups.conflicts, model: model, staged: false)
                    webGroup("git.changes", entries: groups.unstaged, model: model, staged: false)
                    if model.status?.isClean == true {
                        VStack(spacing: metrics.size(6)) {
                            Image(systemName: "checkmark").font(metrics.font(size: 18)).foregroundStyle(theme[.statusWorking])
                            Text("git.clean").font(metrics.font(size: 12, weight: .semibold))
                        }.frame(maxWidth: .infinity, minHeight: metrics.size(150)).accessibilityIdentifier("git.clean")
                    }
                }.accessibilityIdentifier("git.changesList")
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
    func webGroup(_ title: LocalizedStringKey, entries: [GitStatusEntry], model: GitControlModel, staged: Bool) -> some View {
        if !entries.isEmpty {
            GitChangeWebGroup(title: title, entries: entries, staged: staged, busy: model.busy,
                              stage: { paths in if staged { model.unstage(paths) } else { model.stage(paths) } },
                              discard: { pendingDiscard = $0 }, open: { openDiff($0, staged: staged) })
        }
    }
}

private struct GitChangeWebGroup: View {
    let title: LocalizedStringKey
    let entries: [GitStatusEntry]
    let staged: Bool
    let busy: Bool
    let stage: ([String]) -> Void
    let discard: (GitStatusEntry) -> Void
    let open: (GitStatusEntry) -> Void
    @State private var expanded = true
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(5)) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: metrics.size(5)) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(metrics.font(size: 13))
                        Text(title).textCase(.uppercase).font(metrics.font(size: 10, weight: .bold)).tracking(metrics.size(0.4))
                        Text(verbatim: "\(entries.count)").font(metrics.font(size: 9))
                            .frame(minWidth: metrics.size(18), minHeight: metrics.size(18))
                            .background(theme[.panel], in: Capsule())
                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Button { stage(entries.map(\.path)) } label: { Image(systemName: staged ? "minus" : "plus") }
                    .buttonStyle(AletheIconButtonStyle(side: 22)).disabled(busy)
                    .accessibilityLabel(Text(staged ? "git.unstageAll" : "git.stageAll"))
            }.frame(height: metrics.size(32)).padding(.leading, metrics.size(4)).padding(.trailing, metrics.size(6))
            if expanded {
                ForEach(entries, id: \.path) { entry in
                    HStack(spacing: metrics.size(4)) {
                        Button { open(entry) } label: {
                            Text(verbatim: entry.path).font(metrics.font(size: 11)).lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Text(verbatim: (staged ? entry.index : entry.worktree)?.rawValue ?? (entry.isUntracked ? "U" : "!"))
                            .font(metrics.monoFont(size: 11, weight: .bold)).foregroundStyle(theme[.fgMuted])
                            .frame(width: metrics.size(14))
                        if !staged && !entry.isConflict {
                            Button { discard(entry) } label: { Image(systemName: "arrow.uturn.backward") }
                                .buttonStyle(AletheIconButtonStyle(side: 20)).accessibilityLabel(Text("git.discard"))
                        }
                        Button { stage([entry.path]) } label: { Image(systemName: staged ? "minus" : "plus") }
                            .buttonStyle(AletheIconButtonStyle(side: 20))
                            .accessibilityLabel(Text(staged ? "git.unstage" : "git.stage"))
                    }
                    .padding(.horizontal, metrics.size(8)).frame(minHeight: metrics.size(26)).disabled(busy)
                    .accessibilityIdentifier("git.file.\(entry.path)")
                }
            }
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
        }
    }
}
