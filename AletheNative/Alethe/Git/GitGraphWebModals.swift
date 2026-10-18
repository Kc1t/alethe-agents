import AletheDesign
import Foundation
import SwiftUI

/// GitGraph.tsx uses window.prompt/window.confirm; retain their text and actions in themed chrome.
struct GitGraphBranchWebModal: View {
    @Binding var name: String
    let create: () -> Void
    @Environment(\.gitModalClose) private var close
    @FocusState private var focused: Bool
    var body: some View {
        GitWebModal(close: { close?() }) { Text("git.history.branch.title") } content: {
            TextField("git.history.branch.name", text: $name)
                .modifier(ProjectGroupWebInput(focus: $focused))
                .accessibilityIdentifier("git.history.branch.name")
        } footer: {
            Spacer(minLength: 0)
            Button("editor.cancel") { close?() }
            Button("git.history.branch.create") { create(); close?() }
                .buttonStyle(AletheButtonStyle(.primary)).keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .accessibilityIdentifier("git.history.branch.modal")
        .onAppear { focused = true }
    }
}

struct GitGraphResetWebModal: View {
    let hash: String
    let reset: () -> Void
    @Environment(\.gitModalClose) private var close
    var body: some View {
        GitWebModal(close: { close?() }) { Text("git.history.resetHard.title") } content: {
            Text(verbatim: format("git.history.resetHard.message", String(hash.prefix(7))))
        } footer: {
            Spacer(minLength: 0)
            Button("editor.cancel") { close?() }
            Button("git.history.resetHard.confirm") { reset(); close?() }
                .buttonStyle(AletheButtonStyle(.danger)).keyboardShortcut(.defaultAction)
        }
        .accessibilityIdentifier("git.history.reset.modal")
    }
}
