import AletheDesign
import SwiftUI

extension BranchTestingSheet {
    var webContent: some View {
        GitWebModal(close: closeWeb, closeIdentifier: "branchTest.close") {
            Text("branchTest.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(16)) {
                if let model {
                    HStack(spacing: metrics.size(6)) {
                        Text("branchTest.branch").foregroundStyle(theme[.fgMuted])
                        Text(verbatim: model.branch).font(metrics.monoFont(size: 12, weight: .semibold))
                            .foregroundStyle(theme[.accent])
                        Spacer(minLength: 0)
                        Text(verbatim: model.folder.lastPathComponent)
                    }
                    .font(metrics.font(size: 12))
                    .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(10))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    Text("branchTest.explain").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    if let error = model.error {
                        Text(verbatim: error).foregroundStyle(theme[.statusOffline]).textSelection(.enabled)
                            .accessibilityIdentifier("branchTest.error")
                    }
                    ProjectGroupWebField(title: "branchTest.branch") {
                        WebDropdown(selection: Bindable(model).branch, options: model.branches, appearance: .input) { Text(verbatim: $0) }
                            .accessibilityIdentifier("branchTest.branch")
                    }
                    ProjectGroupWebField(title: "branchTest.commands") {
                        TextEditor(text: Bindable(model).commandsText)
                            .font(metrics.monoFont(size: 12, weight: .regular))
                            .scrollContentBackground(.hidden)
                            .frame(height: metrics.size(70))
                            .modifier(GitWebEditor())
                            .accessibilityIdentifier("branchTest.commands")
                    }
                    HStack(spacing: metrics.size(8)) {
                        TextField("branchTest.healthCommand", text: Bindable(model).healthCommand)
                            .modifier(ProjectGroupWebInput(mono: true))
                            .accessibilityIdentifier("branchTest.healthCommand")
                        TextField("branchTest.healthPath", text: Bindable(model).healthPath)
                            .modifier(ProjectGroupWebInput(mono: true))
                            .frame(width: metrics.size(140))
                    }
                    results(model).font(metrics.font(size: 12))
                } else {
                    Text("merge.noProject").foregroundStyle(theme[.fgMuted])
                }
            }
        } footer: {
            Spacer(minLength: 0)
            Button("branchTest.close", action: closeWeb)
            if let model {
                if model.running {
                    ProgressView().controlSize(.small)
                    Text(stepTitle(model.step)).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                    Button("merge.cancel") { model.cancel() }.accessibilityIdentifier("branchTest.cancel")
                } else {
                    Button("branchTest.run") { model.run() }
                        .buttonStyle(AletheButtonStyle(.primary))
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.branch.isEmpty || model.root == nil)
                        .accessibilityIdentifier("branchTest.run")
                }
            }
        }
        .frame(width: closeOverlay == nil ? metrics.size(560) : nil)
        .task { await loadModel() }
        .onDisappear { model?.cancel() }
        .accessibilityIdentifier("branchTest.sheet")
    }

    func closeWeb() { if let closeOverlay { closeOverlay() } else { dismiss() } }
}

/// controls.module.css textarea, including its focus border.
struct GitWebEditor: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @FocusState private var focused: Bool
    func body(content: Content) -> some View {
        content.padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(7))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[focused ? .accent : .border], lineWidth: metrics.size(1)))
            .focused($focused)
    }
}
