import AletheDesign
import SwiftUI

/// SidebarMergePanel.module.css card and branchHeader, retaining native worktree actions.
struct GitWorktreeWebRow: View {
    let row: WorktreesModel.Row
    let selected: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(8)) {
            HStack(spacing: metrics.size(6)) {
                Image(systemName: row.info.mode == .gitWorktree ? "arrow.triangle.branch" : "doc.on.doc")
                    .font(metrics.font(size: 14)).foregroundStyle(theme[.fgMuted])
                Text(verbatim: row.info.branch.isEmpty ? row.info.agentId : row.info.branch)
                    .font(metrics.monoFont(size: 12, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 0)
                Text(row.info.mode == .gitWorktree ? "newTerminal.worktree.mode.gitWorktree" : "newTerminal.worktree.mode.localCopy")
                    .font(metrics.font(size: 10, weight: .semibold)).foregroundStyle(theme[.fgMuted])
            }
            Text(verbatim: row.info.path).font(metrics.monoFont(size: 11, weight: .regular))
                .foregroundStyle(theme[.fgMuted]).lineLimit(1).truncationMode(.middle)
            if row.isLocked {
                Label("worktrees.locked", systemImage: "lock")
                    .font(metrics.font(size: 10)).foregroundStyle(theme[.statusOffline])
                    .accessibilityIdentifier("worktrees.row.\(row.id).locked")
                if let reason = row.lockReason, !reason.isEmpty {
                    Text(verbatim: format("worktrees.lockReason", reason))
                        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                        .accessibilityIdentifier("worktrees.row.\(row.id).reason")
                }
            }
        }
        .padding(metrics.size(10)).frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(theme[.fg])
        .background(theme[selected ? .accentFaint : .panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
            .strokeBorder(theme[selected ? .accentBorder : hovering ? .borderStrong : .border], lineWidth: metrics.size(1)))
        .contentShape(RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .onHover { hovering = $0 }
        .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: hovering)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("worktrees.row.\(row.id)")
    }
}
