import AletheDesign
import AletheGit
import Foundation
import SwiftUI

/// ConfirmWorktreeCommitModal.tsx and its CSS, using the selected worktree's real status.
struct ConfirmWorktreeCommitWebModal: View {
    let folder: URL
    let branch: String
    @Binding var message: String
    let confirm: () -> Void
    @Environment(\.gitModalClose) private var closeOverlay
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var pending: [GitStatusEntry] = []
    @State private var loading = true
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        GitWebModal(close: { closeOverlay?() }) {
            Text(verbatim: format("gitModals.commit.title", branch))
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                Text("gitModals.commit.description")
                    .font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    .padding(.bottom, metrics.size(12))
                if loading { ProgressView().controlSize(.small) }
                if let error {
                    Text(verbatim: error).foregroundStyle(theme[.statusOffline]).textSelection(.enabled)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: metrics.size(2)) {
                        ForEach(pending, id: \.path) { entry in
                            HStack(spacing: metrics.size(8)) {
                                Text(verbatim: entry.index?.rawValue ?? entry.worktree?.rawValue ?? "?")
                                    .foregroundStyle(theme[.accent]).frame(width: metrics.size(20))
                                Text(verbatim: entry.path).lineLimit(1).help(entry.path)
                            }
                            .font(metrics.monoFont(size: 11, weight: .regular))
                            .frame(height: metrics.size(17.6))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: metrics.size(min(140, CGFloat(pending.count) * 19.6 + 12)))
                .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(6))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .padding(.bottom, metrics.size(14))
                ProjectGroupWebField(title: "worktree.commit.message") {
                    TextEditor(text: $message)
                        .font(metrics.font(size: 12)).scrollContentBackground(.hidden)
                        .frame(minHeight: metrics.size(96))
                        .modifier(GitWebEditor()).focused($focused)
                        .accessibilityIdentifier("worktrees.commit.message")
                }
            }
        } footer: {
            Spacer(minLength: 0)
            Button("branchTest.close") { closeOverlay?() }
            Button("worktree.commit.confirm") { confirm(); closeOverlay?() }
                .buttonStyle(AletheButtonStyle(.primary))
                .disabled(loading || error != nil)
                .keyboardShortcut(.defaultAction)
        }
        .task {
            defer { loading = false }
            do { pending = try await GitRepository(root: folder).status().entries.filter { $0.kind != .ignored } }
            catch { self.error = error.localizedDescription }
        }
        .onAppear { focused = true }
    }
}
