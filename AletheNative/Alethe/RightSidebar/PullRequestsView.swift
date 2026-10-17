import AletheDesign
import AletheGit
import AlethePluginKit
import AletheTodos
import AppKit
import SwiftUI

/// The user's open pull requests via `gh` (P4-14); details (checks, review, draft) load per row.
struct PullRequestsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var phase: Phase = .loading
    @State private var prs: [PullRequestSummary] = []
    @State private var detailed: Set<String> = []
    @State private var reload = 0
    @State private var reviewing: PullRequestSummary?
    @State private var merging: PullRequestSummary?
    private var reviews: PullRequestReviewState { environment.pullRequestReviewState }

    static let tabID = "pullRequests"
    static let tab = SidebarTabContribution(id: tabID, title: "Pull Requests", symbol: "arrow.triangle.pull", side: .right, viewID: tabID)

    private enum Phase: Equatable {
        case loading, ready, missing, signedOut
        case failed(String)
    }

    var body: some View {
        VStack(spacing: 0) {
            if metrics.isWebInterface {
                HStack(spacing: metrics.size(7)) {
                    Image(systemName: "arrow.triangle.pull").resizable().scaledToFit()
                        .frame(width: metrics.size(16), height: metrics.size(16))
                    Text("rightSidebar.pr.title").font(metrics.font(size: 14, weight: .medium)).lineLimit(1)
                    Text("rightSidebar.prScopeAll").lineLimit(1).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    Spacer(minLength: 0)
                    Button {
                        reload += 1
                    } label: {
                        Label { Text("pullRequests.refresh") } icon: {
                            Image(systemName: "arrow.clockwise").resizable().scaledToFit()
                                .frame(width: metrics.size(13), height: metrics.size(13))
                                .modifier(AletheSidebarSpinner(active: phase == .loading, kind: .pullRequests))
                        }
                    }
                    .buttonStyle(AletheSidebarUtilityStyle())
                    .help("pullRequests.refresh").disabled(phase == .loading)
                }
                .foregroundStyle(theme[.fg]).padding(.horizontal, metrics.size(10))
                .frame(height: metrics.size(44))
                .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
            } else {
            HStack {
                Text("pullRequests.title").font(metrics.font(.headline))
                Spacer()
                if phase == .loading { ProgressView().controlSize(.small) }
                Button { reload += 1 } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help("pullRequests.refresh")
                    .disabled(phase == .loading)
            }
            .padding(.horizontal, metrics.size(10))
            .padding(.vertical, metrics.size(6))
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: reload) { await load() }
        .sheet(item: Binding(get: { metrics.isWebInterface ? nil : reviewing }, set: { reviewing = $0 })) { PullRequestReviewSheet(pr: $0) }
        .sheet(item: Binding(get: { metrics.isWebInterface ? nil : merging }, set: { merging = $0 })) { pr in
            if let sha = reviews.reviewedHead(pr) {
                PullRequestMergeSheet(pr: pr, headSHA: sha) { reload += 1 }
            }
        }
        .gitWebSheet(isPresented: Binding(get: { metrics.isWebInterface && reviewing != nil },
                                         set: { if !$0 { reviewing = nil } }), width: 680) {
            if let reviewing { GitPullRequestReviewWebModal(pr: reviewing) }
        }
        .gitWebSheet(isPresented: Binding(get: { metrics.isWebInterface && merging != nil },
                                         set: { if !$0 { merging = nil } }), width: 680) {
            if let merging, let sha = reviews.reviewedHead(merging) {
                GitPullRequestMergeWebModal(pr: merging, headSHA: sha) { reload += 1 }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .missing:
            if metrics.isWebInterface {
                webError { hint("pullRequests.missing.hint", command: "brew install gh") }
            } else {
            ContentUnavailableView {
                Label("pullRequests.missing", systemImage: "terminal")
            } description: {
                hint("pullRequests.missing.hint", command: "brew install gh")
            }
            }
        case .signedOut:
            if metrics.isWebInterface {
                webError { hint("pullRequests.signedOut.hint", command: "gh auth login") }
            } else {
            ContentUnavailableView {
                Label("pullRequests.signedOut", systemImage: "person.crop.circle.badge.xmark")
            } description: {
                hint("pullRequests.signedOut.hint", command: "gh auth login")
            }
            }
        case .failed(let message):
            if metrics.isWebInterface {
                webError { Text(verbatim: message).textSelection(.enabled) }
            } else {
            ContentUnavailableView {
                Label("pullRequests.failed", systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: message).foregroundStyle(theme[.statusStopped])
            }
            }
        case .loading where prs.isEmpty || metrics.isWebInterface:
            if metrics.isWebInterface {
                HStack(spacing: metrics.size(8)) {
                    Image(systemName: "progress.indicator")
                        .resizable().scaledToFit()
                        .frame(width: metrics.size(16), height: metrics.size(16))
                        .modifier(AletheSidebarSpinner(active: true, kind: .pullRequests))
                        .accessibilityHidden(true)
                    Text("rightSidebar.pr.loading").font(metrics.font(size: 12)).lineLimit(1)
                }
                .foregroundStyle(theme[.fgMuted]).padding(metrics.size(16))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(metrics.size(10))
            } else { Color.clear }
        case .loading, .ready:
            if prs.isEmpty {
                if metrics.isWebInterface {
                    ScrollView {
                        WebSidebarEmpty(title: "rightSidebar.pr.empty", detail: "rightSidebar.prEmptyDetail", symbol: "arrow.triangle.pull", boxed: true, iconSize: 20, centeredInPanel: false)
                    }.padding(metrics.size(10))
                } else {
                    ContentUnavailableView("pullRequests.empty", systemImage: "arrow.triangle.pull")
                }
            } else {
                if metrics.isWebInterface {
                    ScrollView {
                        LazyVStack(spacing: metrics.size(8)) {
                            ForEach(prs) { pr in
                                webRow(pr).task(id: pr.id) { await loadDetails(pr) }
                            }
                        }.padding(metrics.size(10))
                    }
                } else {
                List(prs) { pr in
                    row(pr)
                        .task(id: pr.id) { await loadDetails(pr) }
                }
                .listStyle(.sidebar)
                }
            }
        }
    }

    private func webError<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            content().font(metrics.font(size: 12)).foregroundStyle(theme[.fg])
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(metrics.size(12))
                .background(theme[.statusOfflineSoft], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.statusOffline], lineWidth: metrics.size(1)))
                .padding(metrics.size(10))
        }
    }

    private func hint(_ key: LocalizedStringKey, command: String) -> some View {
        VStack(spacing: metrics.size(6)) {
            Text(key)
            Text(verbatim: command)
                .font(metrics.font(.body).monospaced())
                .textSelection(.enabled)
        }
    }

    private func webRow(_ pr: PullRequestSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: metrics.size(8)) {
                Text(verbatim: pr.repo).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Text(verbatim: "#\(pr.number)").fixedSize()
                if pr.isDraft {
                    Text("pullRequests.draft").textCase(.uppercase).tracking(metrics.size(0.3))
                        .foregroundStyle(theme[.statusWaiting])
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                        .background(theme[.statusWaitingSoft], in: Capsule())
                }
            }.font(metrics.monoFont(size: 10, weight: .regular)).foregroundStyle(theme[.fgFaint])
            Text(verbatim: pr.title).lineLimit(1).font(metrics.font(size: 13, weight: .medium)).help(pr.title)
                .foregroundStyle(theme[.fg]).padding(.vertical, metrics.size(6))
            HStack(spacing: metrics.size(4)) {
                Text(verbatim: pr.author)
                if let updated = pr.updatedAt {
                    Text(verbatim: "·")
                    Text(verbatim: format("rightSidebar.pr.updated", updated.formatted(date: .numeric, time: .omitted)))
                }
            }.font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint]).lineLimit(1)
            HStack(spacing: metrics.size(6)) {
                Button {
                    if let url = pr.browserURL { NSWorkspace.shared.open(url) }
                } label: {
                    Label("pullRequests.open", systemImage: "arrow.up.right.square").font(metrics.font(size: 13))
                }.buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 26, height: 26))
                    .help(Text("pullRequests.open")).disabled(pr.browserURL == nil)
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                Button {
                    guard let url = pr.browserURL else { return }
                    _ = TodosPlugin.activeStore?.addPullRequest(number: pr.number, title: pr.title, url: url)
                } label: {
                    Text((todoAdded(pr) ? "pullRequests.alreadyAdded" : "pullRequests.sendToTodo") as LocalizedStringKey)
                        .lineLimit(1).frame(maxWidth: .infinity)
                }
                .disabled(todoAdded(pr) || TodosPlugin.activeStore == nil || pr.browserURL == nil)
                .buttonStyle(AlethePanelActionStyle(accented: !todoAdded(pr)))
            }.padding(.top, metrics.size(10))
        }
        .padding(.vertical, metrics.size(10)).padding(.horizontal, metrics.size(12))
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .contextMenu {
            Button { reviewing = pr } label: { Label("pullRequests.reviewWithAgent", systemImage: "cpu") }
            Button { merging = pr } label: { Label("pullRequests.squashMergeMenu", systemImage: "arrow.triangle.merge") }.disabled(reviews.reviewedHead(pr) == nil)
        }
    }

    private func row(_ pr: PullRequestSummary) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Button {
                if let url = pr.browserURL { NSWorkspace.shared.open(url) }
            } label: {
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    HStack(spacing: metrics.size(4)) {
                        Text(verbatim: "\(pr.repo) #\(pr.number)")
                            .font(metrics.font(.caption))
                            .foregroundStyle(theme[.textSecondary])
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: metrics.size(4))
                        badges(pr)
                    }
                    Text(verbatim: pr.title).lineLimit(2)
                    HStack(spacing: metrics.size(4)) {
                        Text(verbatim: pr.author)
                        if let updated = pr.updatedAt {
                            Text(verbatim: "·")
                            Text(updated, format: .relative(presentation: .named))
                        }
                    }
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textSecondary])
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(pr.browserURL?.absoluteString ?? "")
            todoButton(pr)
        }
        .contextMenu {
            Button("pullRequests.open") { if let url = pr.browserURL { NSWorkspace.shared.open(url) } }
                .disabled(pr.browserURL == nil)
            Button("pullRequests.copyURL") {
                guard let url = pr.browserURL else { return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url.absoluteString, forType: .string)
            }
            .disabled(pr.browserURL == nil)
            todoButton(pr)
            Divider()
            Button("pullRequests.reviewWithAgent") { reviewing = pr }
            Button("pullRequests.squashMergeMenu") { merging = pr }
                .disabled(reviews.reviewedHead(pr) == nil)
        }
    }

    private func todoAdded(_ pr: PullRequestSummary) -> Bool {
        pr.browserURL.map { url in TodosPlugin.activeStore?.todos.contains { $0.prURL == url } == true } ?? false
    }

    private func todoButton(_ pr: PullRequestSummary) -> some View {
        let added = pr.browserURL.map { url in TodosPlugin.activeStore?.todos.contains { $0.prURL == url } == true } ?? false
        return Button(added ? LocalizedStringKey("pullRequests.alreadyAdded") : "pullRequests.sendToTodo") {
            guard let url = pr.browserURL else { return }
            _ = TodosPlugin.activeStore?.addPullRequest(number: pr.number, title: pr.title, url: url)
        }
        .disabled(added || TodosPlugin.activeStore == nil || pr.browserURL == nil)
    }

    @ViewBuilder
    private func badges(_ pr: PullRequestSummary) -> some View {
        if pr.isDraft {
            Text("pullRequests.draft")
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.statusDisabled])
        }
        switch pr.reviewDecision {
        case .approved:
            Image(systemName: "checkmark.seal").foregroundStyle(theme[.statusActive]).help("pullRequests.review.approved")
        case .changesRequested:
            Image(systemName: "exclamationmark.bubble").foregroundStyle(theme[.statusStopped]).help("pullRequests.review.changes")
        case .reviewRequired:
            Image(systemName: "eye").foregroundStyle(theme[.statusWaiting]).help("pullRequests.review.required")
        default:
            EmptyView()
        }
        switch pr.checks {
        case .success:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(theme[.statusActive]).help("pullRequests.checks.success")
        case .failure:
            Image(systemName: "xmark.circle.fill").foregroundStyle(theme[.statusStopped]).help("pullRequests.checks.failure")
        case .pending:
            Image(systemName: "clock").foregroundStyle(theme[.statusWaiting]).help("pullRequests.checks.pending")
        case .none:
            EmptyView()
        }
    }

    private func load() async {
        phase = .loading
        detailed = []
        let client = GitHubPullRequests()
        do {
            switch try await client.status() {
            case .missing: phase = .missing; prs = []; return
            case .signedOut: phase = .signedOut; prs = []; return
            case .ready: break
            }
            prs = try await client.listMine()
            phase = .ready
        } catch is CancellationError {
        } catch GitHubPullRequestError.ghMissing {
            phase = .missing
        } catch GitHubPullRequestError.signedOut {
            phase = .signedOut
        } catch GitHubPullRequestError.cancelled {
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    /// Fetches one row's details once per load; failures leave the row's summary as is.
    private func loadDetails(_ pr: PullRequestSummary) async {
        guard !detailed.contains(pr.id) else { return }
        detailed.insert(pr.id)
        guard let details = try? await GitHubPullRequests().details(for: pr) else { return }
        if let index = prs.firstIndex(where: { $0.id == pr.id }) {
            prs[index] = prs[index].merging(details)
        }
    }

    private static func message(for error: Error) -> String {
        switch error {
        case GitHubPullRequestError.commandFailed(_, let stderr) where !stderr.isEmpty: stderr
        case GitHubPullRequestError.parseFailed(let detail): detail
        default: error.localizedDescription
        }
    }
}
