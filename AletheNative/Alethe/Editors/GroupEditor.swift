import AletheDesign
import AletheModel
import SwiftUI

/// New Group / Edit Group sheet.
struct GroupEditor: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let editing: GroupID?
    let initialParent: GroupID?
    var closeOverlay: (() -> Void)? = nil
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @Environment(\.metrics) private var metrics

    @State private var iconUrl = ""
    @State private var name = ""
    @State private var color: ProjectColor?
    @State private var parent: GroupID?

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
    }

    private var nativeBody: some View {
        Form {
            TextField(text: $name) { Text("editor.group.name") }
                .accessibilityIdentifier("editor.group.name")
                .focused($focused)
            ImageInputField(value: $iconUrl, name: name, color: color)
            LabeledContent("editor.color") { ColorSwatchPicker(selection: $color, allowsNone: true) }
            Picker(selection: $parent) {
                Text("editor.group.topLevel").tag(GroupID?.none)
                ForEach(parentCandidates) { group in
                    Text(verbatim: group.name).tag(GroupID?.some(group.id))
                }
            } label: { Text("editor.group.parent") }
        }
        .formStyle(.grouped)
        .frame(width: metrics.size(420))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("editor.cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(editing == nil ? "editor.group.create" : "editor.save") { save() }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("editor.confirm")
            }
        }
        .navigationTitle(Text(editing == nil ? "editor.group.newTitle" : "editor.group.editTitle"))
        .onAppear {
            focused = true
            parent = initialParent
            if let editing, let group = workspace.document.group(editing) {
                iconUrl = group.iconUrl ?? ""
                name = group.name
                color = group.color
                parent = group.parentID
            }
        }
    }

    private var webBody: some View {
        ProjectGroupWebModal(title: editing == nil ? "editor.group.newTitle" : "editor.group.editTitle",
                             confirm: editing == nil ? "editor.group.create" : "editor.save",
                             disabled: name.trimmingCharacters(in: .whitespaces).isEmpty,
                             close: close, submit: submitWeb) {
            ProjectGroupWebField(title: "editor.web.name") {
                TextField(text: $name, prompt: Text("editor.group.web.namePlaceholder")) { Text("editor.group.name") }
                    .modifier(ProjectGroupWebInput(focus: $focused))
                    .accessibilityIdentifier("editor.group.name").onSubmit(submitWeb)
            }
            ProjectGroupWebField(title: editing == nil ? "editor.group.web.color" : "editor.color") {
                ColorSwatchPicker(selection: $color, webSwatchSize: editing == nil ? 24 : 28)
            }
            ImageInputField(value: $iconUrl, name: name, color: color)
                .onSubmit(submitWeb)
            ProjectGroupWebField(title: "editor.group.parent") {
                WebDropdown(selection: $parent, options: [nil] + parentCandidates.map { Optional($0.id) }) { value in
                    if let value, let group = workspace.document.group(value) {
                        Text(verbatim: group.name)
                    } else { Text("editor.group.topLevel") }
                }
            }
            if editing != nil {
                HStack(spacing: metrics.size(6)) {
                    if !iconUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        SidebarCoverImage(source: iconUrl.trimmingCharacters(in: .whitespacesAndNewlines), side: 14, cornerRadius: 3) {
                            Circle().fill(theme[color?.token ?? .fgMuted])
                                .frame(width: metrics.size(8), height: metrics.size(8))
                        }
                    } else {
                        Circle().fill(theme[color?.token ?? .fgMuted])
                            .frame(width: metrics.size(8), height: metrics.size(8))
                    }
                    Text("editor.group.web.preview").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
                .padding(.vertical, metrics.size(10)).padding(.horizontal, metrics.size(12))
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[color?.token ?? .border].opacity(0.5), lineWidth: metrics.size(2)))
                .padding(.top, metrics.size(6))
            }
        }
        .onAppear {
            parent = initialParent
            if let editing, let group = workspace.document.group(editing) {
                iconUrl = group.iconUrl ?? ""
                name = group.name; color = group.color; parent = group.parentID
            } else { color = .blue }
            focused = true
        }
    }

    private func close() {
        if metrics.isWebInterface, let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private func submitWeb() {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        save()
    }

    /// A group cannot be nested inside itself or its descendants.
    private var parentCandidates: [ProjectGroup] {
        workspace.document.groups.filter { candidate in
            guard let editing else { return true }
            return !workspace.document.isGroup(candidate.id, inside: editing)
        }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if let editing {
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.editGroup")) { doc in
                doc.updateGroup(editing) {
                    $0.iconUrl = ProjectImageInput.normalized(iconUrl)
                    $0.name = trimmed
                    $0.color = color
                }
                if doc.group(editing)?.parentID != parent { doc.moveGroup(editing, toParent: parent, at: Int.max) }
            }
        } else {
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newGroup")) {
                let id = $0.addGroup(name: trimmed, color: color, parent: parent)
                $0.updateGroup(id) { $0.iconUrl = ProjectImageInput.normalized(iconUrl) }
            }
        }
        close()
    }
}
