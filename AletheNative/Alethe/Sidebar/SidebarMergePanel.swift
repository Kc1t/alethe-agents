import AletheDesign
import AletheGit
import AletheIntegrations
import AletheMerge
import AletheModel
import SwiftUI

/// In-progress merge environments of a project's repository, read from the Merge Center metadata
/// (`.alethe/merge-envs/<id>.json`). Polls the folder (no git) while the sidebar row is visible.
@MainActor @Observable
final class ProjectMergeWatcher {
    private(set) var sessions: [MergeSessionSummary] = []
    static let interval: Duration = .seconds(4)

    /// Refreshes until the calling task is cancelled; sessions of other projects sharing the
    /// repository are left out.
    func watch(folder: URL, projectID: ProjectID) async {
        guard let root = try? await GitRepository.discover(folder) else { return }
        while !Task.isCancelled {
            let found = await Task.detached { ConflictResolution(root: root).inProgress() }.value
            let mine = found.filter { $0.meta.projectId == nil || $0.meta.projectId == projectID.rawValue }
            if mine != sessions { sessions = mine }
            try? await Task.sleep(for: Self.interval)
        }
    }
}

/// Compact merge panel under a project in the left sidebar (upstream `SidebarMergePanel` /
/// `MergeTree`): the merge, its stage, and its conflicted files as a tree grouped by folder or by
/// class. Clicking reopens the Merge Center at that stage.
struct SidebarMergePanel: View {
    let session: MergeSessionSummary
    let project: Project
    @AppStorage("sidebar.mergeGrouping") private var grouping = MergeTreeGrouping.folder
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let groups = MergeTree.groups(session.conflicts, by: grouping)
        if groups.isEmpty {
            header
        } else {
            DisclosureGroup {
                ForEach(groups) { group in
                    DisclosureGroup {
                        ForEach(group.files, id: \.path) { file in
                            Button(action: open) {
                                Label {
                                    Text(verbatim: grouping == .folder ? MergeTree.fileName(of: file.path) : file.path)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                } icon: {
                                    Image(systemName: "exclamationmark.triangle").webProfileSized(14)
                                        .foregroundStyle(theme[.statusWaiting])
                                }
                            }
                            .buttonStyle(.plain)
                            .help(Text(verbatim: "\(file.path) — \(file.class.variantName)"))
                            .accessibilityIdentifier("sidebar.merge.file")
                        }
                    } label: {
                        Label {
                            Text(verbatim: group.title).lineLimit(1).truncationMode(.middle)
                        } icon: {
                            Image(systemName: grouping == .folder ? "folder" : "tag").webProfileSized(14)
                                .foregroundStyle(theme[.textSecondary])
                        }
                    }
                }
            } label: {
                header
            }
        }
    }

    private var header: some View {
        Button(action: open) {
            Label {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: String(format: String(localized: "sidebar.merge.title"),
                                          session.meta.source, session.meta.target))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HStack(spacing: metrics.space(.xs)) {
                        Text(stageTitle(session.stage))
                        if !session.conflicts.isEmpty {
                            Text(verbatim: "·")
                            Text(verbatim: String(format: String(localized: "sidebar.merge.conflicts"), session.conflicts.count))
                        }
                    }
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                }
            } icon: {
                Image(systemName: "arrow.triangle.merge").webProfileSized(14)
                    .foregroundStyle(theme[session.conflicts.isEmpty ? .accent : .statusWaiting])
            }
        }
        .buttonStyle(.plain)
        .help(Text("sidebar.merge.open"))
        .contextMenu {
            Button("sidebar.merge.open", action: open)
            Divider()
            Picker("sidebar.merge.groupBy", selection: $grouping) {
                Text("sidebar.merge.groupByFolder").tag(MergeTreeGrouping.folder)
                Text("sidebar.merge.groupByClass").tag(MergeTreeGrouping.class)
            }
        }
        .accessibilityIdentifier("sidebar.merge.\(session.id)")
    }

    private func open() {
        environment.editorRequest = .mergeCenter(project.id, resume: session.id)
    }

    private func stageTitle(_ stage: MergeCenterStage) -> LocalizedStringKey {
        switch stage {
        case .analyze: "merge.stage.analyze"
        case .prepare: "merge.stage.prepare"
        case .validate: "merge.stage.validate"
        case .finish: "merge.stage.finish"
        }
    }
}

/// A worktree's GSD planning status under its project (upstream `SidebarMergePanel` planning gate,
/// P5-24): the child session's state and the roadmap progress; clicking opens its activity.
struct SidebarPlanningStatus: View {
    let session: GSDSyncSession
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Button {
            environment.editorRequest = .gsdSyncActivity(GSDSyncActivityTarget(session))
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: format("sidebar.planning.title", session.name))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HStack(spacing: metrics.space(.xs)) {
                        GSDSyncStateGlyph(session: session)
                        Text(verbatim: GSDPlanningText.progress(session) ?? String(localized: "gsdSync.planning.started"))
                    }
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                }
            } icon: {
                Image(systemName: session.planning.reportedComplete ? "checkmark.circle" : "list.bullet.clipboard").webProfileSized(14)
                    .foregroundStyle(theme[session.planning.reportedComplete ? .statusActive : .accent])
            }
        }
        .buttonStyle(.plain)
        .help(Text("sidebar.planning.open"))
        .accessibilityIdentifier("sidebar.planning.\(session.name)")
    }
}
