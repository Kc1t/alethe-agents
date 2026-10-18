import AletheAgents
import AletheDesign
import AletheFoundation
import AletheGit
import AletheModel
import AppKit
import SwiftUI

/// PullRequestReviewModal.module.css card dimensions, backed by the existing native PR summary.
struct GitPullRequestWebCard: View {
    let pr: PullRequestSummary
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(8)) {
            HStack {
                Text(verbatim: "#\(pr.number)")
                Spacer(minLength: 0)
                if pr.isDraft { Text("pullRequests.draft").foregroundStyle(theme[.statusWaiting]) }
            }.font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
            Text(verbatim: pr.title).font(metrics.font(size: 16, weight: .semibold))
            Text(verbatim: "\(pr.author) · \(pr.repo)")
                .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
            Button {
                if let url = pr.browserURL { NSWorkspace.shared.open(url) }
            } label: { Label("pullRequests.open", systemImage: "arrow.up.right.square") }
                .buttonStyle(AletheButtonStyle(size: .small)).disabled(pr.browserURL == nil)
                .padding(.top, metrics.size(8)).accessibilityIdentifier("pullRequests.open.\(pr.number)")
        }
        .padding(metrics.size(16)).frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.size(9)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(9)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

struct GitPullRequestReviewWebModal: View {
    let pr: PullRequestSummary
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.gitModalClose) private var closeOverlay
    @State private var agent: AgentKind = .claude
    @State private var model = ""
    @State private var headSHA: String?
    @State private var error: String? { didSet { if error != oldValue { AppLog.shown(error, .git) } } }

    private var agents: [AgentKind] {
        AgentRegistry.builtin.enabledKinds(environment.preferences?.document.enabledAgents).filter { $0 != .shell }
    }

    private var project: Project? {
        guard let document = environment.workspace?.document else { return nil }
        return document.workspace.selectedProjectID.flatMap(document.project)
            ?? document.recentProjectIDs(limit: 1).first.flatMap(document.project)
    }

    var body: some View {
        GitWebModal(close: { closeOverlay?() }) {
            Image(systemName: "arrow.triangle.pull").font(metrics.font(size: 18))
            Text("pullRequests.reviewTitle")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                GitPullRequestWebCard(pr: pr)
                ProjectGroupWebField(title: "pullRequests.reviewAgent") {
                    NewTerminalRowSelect(selection: $agent, options: agents,
                                         title: { AgentLabels.name(for: $0.rawValue) }) { kind in
                        AgentLogo(agent: kind.rawValue, size: 16)
                    }
                }
                ProjectGroupWebField(title: "pullRequests.reviewModel") {
                    TextField("pullRequests.reviewModel.placeholder", text: $model)
                        .modifier(ProjectGroupWebInput())
                        .accessibilityIdentifier("pullRequests.review.model")
                }
                HStack(spacing: metrics.size(6)) {
                    Text("pullRequests.headSHA").foregroundStyle(theme[.fgMuted])
                    if let headSHA {
                        Text(verbatim: String(headSHA.prefix(12))).font(metrics.monoFont(size: 12, weight: .regular))
                            .textSelection(.enabled)
                    } else if error == nil { ProgressView().controlSize(.small) }
                }
                HStack(spacing: metrics.size(6)) {
                    Text("pullRequests.reviewProject").foregroundStyle(theme[.fgMuted])
                    Text(verbatim: project?.name ?? "—")
                }
                if let error { Text(verbatim: error).foregroundStyle(theme[.statusOffline]).textSelection(.enabled) }
            }
        } footer: {
            Spacer(minLength: 0)
            Button("pullRequests.cancel") { closeOverlay?() }
            Button("pullRequests.startReview", action: start)
                .buttonStyle(AletheButtonStyle(.primary)).keyboardShortcut(.defaultAction)
                .disabled(headSHA == nil || project == nil || agents.isEmpty)
        }
        .onAppear {
            let state = environment.pullRequestReviewState
            agent = agents.contains(state.agent) ? state.agent : (agents.first ?? .claude)
            model = state.model
        }
        .accessibilityIdentifier("pullRequests.review.modal")
        .task { await loadHead() }
    }

    /// Reads the current head SHA from GitHub so the review and merge target the same commit.
    private func loadHead() async {
        do {
            let details = try await GitHubPullRequests().details(for: pr)
            if let sha = details.headSHA, !sha.isEmpty { headSHA = sha } else { error = String(localized: "pullRequests.noHead") }
        } catch is CancellationError {
        } catch GitHubPullRequestError.commandFailed(_, let stderr) where !stderr.isEmpty {
            error = stderr
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func start() {
        guard let headSHA, let project, let workspace = environment.workspace else { return }
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let tab = PaneTab(agent: agent.rawValue,
                          title: String(format: String(localized: "pullRequests.reviewPaneName"), pr.number),
                          extraArguments: trimmedModel.isEmpty ? [] : ["--model", trimmedModel],
                          initialPrompt: PullRequestReviewState.prompt(for: pr, headSHA: headSHA))
        workspace.update {
            $0.openInTab(project.id)
            $0.addPane(to: project.id, tab: tab)
        }
        let state = environment.pullRequestReviewState
        state.record(pr, headSHA: headSHA)
        state.setPreference(agent: agent, model: trimmedModel)
        closeOverlay?()
    }
}


struct GitPullRequestMergeWebModal: View {
    let pr: PullRequestSummary
    let headSHA: String
    var onMerged: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.gitModalClose) private var closeOverlay
    @State private var running = false
    @State private var merged = false
    @State private var error: String? { didSet { if error != oldValue { AppLog.shown(error, .git) } } }

    var body: some View {
        GitWebModal(close: { closeOverlay?() }) { Text("pullRequests.mergeTitle") } content: {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                GitPullRequestWebCard(pr: pr)
                Text(verbatim: headSHA).font(metrics.monoFont(size: 12, weight: .regular)).textSelection(.enabled)
                Text("pullRequests.mergeHint").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                if merged {
                    Label("pullRequests.merged", systemImage: "checkmark.circle").foregroundStyle(theme[.statusWorking])
                }
                if let error {
                    Text(verbatim: error).foregroundStyle(theme[.statusOffline]).textSelection(.enabled)
                    Text("pullRequests.reviewAgain").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                }
            }
        } footer: {
            if running { ProgressView().controlSize(.small) }
            Spacer(minLength: 0)
            if merged {
                Button("pullRequests.done") { closeOverlay?() }.keyboardShortcut(.defaultAction)
            } else {
                Button("pullRequests.cancel") { closeOverlay?() }
                Button("pullRequests.squashMerge") { Task { await merge() } }
                    .buttonStyle(AletheButtonStyle(.primary)).keyboardShortcut(.defaultAction).disabled(running)
            }
        }
        .accessibilityIdentifier("pullRequests.merge.modal")
    }

    private func merge() async {
        running = true
        error = nil
        defer { running = false }
        do {
            try await GitHubPullRequests().squashMerge(pr, headSHA: headSHA)
            merged = true
            environment.pullRequestReviewState.forget(pr)
            onMerged()
        } catch GitHubPullRequestError.commandFailed(_, let stderr) where !stderr.isEmpty {
            error = stderr
        } catch {
            self.error = error.localizedDescription
        }
    }
}
