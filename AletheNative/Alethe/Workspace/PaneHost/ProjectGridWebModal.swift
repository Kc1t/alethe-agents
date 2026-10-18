import AletheDesign
import AletheModel
import SwiftUI

/// `ProjectGridModal.tsx` (create / rename / delete) in `Modal.module.css` chrome, 540 points wide.
struct ProjectGridWebModal: View {
    enum Mode {
        case create
        case rename
        case delete(name: String, count: Int)
    }

    let mode: Mode
    let initial: String
    /// True when the name is unique, non-empty and not reserved (the web `createProjectGrid` check).
    let isValid: (String) -> Bool
    let finish: (WebDialogCenter.Outcome) -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var name: String
    @State private var showsError = false
    @FocusState private var focused: Bool

    init(mode: Mode, initial: String = "", isValid: @escaping (String) -> Bool = { _ in true },
         finish: @escaping (WebDialogCenter.Outcome) -> Void) {
        self.mode = mode
        self.initial = initial
        self.isValid = isValid
        self.finish = finish
        _name = State(initialValue: initial)
    }

    var body: some View {
        GitWebModal(close: { finish(.cancelled) }, closeIdentifier: "projectGrid.close") {
            Text(title)
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(8)) {
                switch mode {
                case .delete(let grid, let count):
                    Text(verbatim: format("projectGrid.web.deleteDescription", grid, count))
                        .font(metrics.font(size: 13))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("projectGrid.deleteDescription")
                case .create, .rename:
                    ProjectGroupWebField(title: "projectGrid.web.name") {
                        TextField(text: $name) { Text("projectGrid.web.name") }
                            .modifier(ProjectGroupWebInput(focus: $focused))
                            .onChange(of: name) { _, _ in showsError = false }
                            .onSubmit(save)
                            .accessibilityIdentifier("projectGrid.name")
                    }
                    .padding(.bottom, 0)
                }
                if showsError {
                    Text("projectGrid.web.invalidName")
                        .font(metrics.font(size: 13))
                        .foregroundStyle(theme[.statusStopped])
                        .accessibilityIdentifier("projectGrid.error")
                }
            }
        } footer: {
            Spacer(minLength: 0)
            Button("editor.cancel") { finish(.cancelled) }
                .accessibilityIdentifier("projectGrid.cancel")
            switch mode {
            case .delete:
                Button("projectGrid.web.keepTerminals") { finish(.confirmed("")) }
                    .accessibilityIdentifier("projectGrid.keep")
                Button("projectGrid.web.deleteTerminals") { finish(.alternate) }
                    .buttonStyle(AletheButtonStyle(.danger))
                    .accessibilityIdentifier("projectGrid.deleteTerminals")
            case .create, .rename:
                Button("editor.save", action: save)
                    .buttonStyle(AletheButtonStyle(.primary))
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("projectGrid.save")
            }
        }
        .onAppear { focused = true }
    }

    private var title: LocalizedStringKey {
        switch mode {
        case .create: "projectGrid.web.create"
        case .rename: "projectGrid.web.rename"
        case .delete: "projectGrid.web.delete"
        }
    }

    private func save() {
        guard isValid(name) else { showsError = true; return }
        finish(.confirmed(name))
    }
}
