import AletheDesign
import AletheModel
import AletheTodos
import AppKit
import SwiftUI

/// The Todos plugin's `todos` view (P4-16): the global list and the selected project's list.
struct TodosView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var draft = ""
    @State private var addToProject = true
    @State private var editingID: String?
    @State private var editingTitle = ""
    @State private var taggingID: String?
    @State private var tagDraft = ""
    @State private var showingSettings = false
    @State private var dropTarget: String?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case draft, rename, tags }

    private var project: Project? {
        environment.workspace.flatMap { model in
            model.document.workspace.selectedProjectID.flatMap(model.document.project)
        }
    }

    var body: some View {
        if let store = environment.todoStore {
            Group {
                if metrics.isWebInterface {
                    TodosWebPanel(store: store) { showingSettings = true }
                } else {
            VStack(spacing: 0) {
                addRow(store)
                    .padding(.top, metrics.size(8))
                if metrics.isWebInterface {
                    ScrollView {
                        VStack(spacing: metrics.size(16)) {
                            if let project {
                                section(store, scope: .project(project.id.rawValue), title: Text(verbatim: project.name))
                            }
                            section(store, scope: .global, title: Text("todos.global"))
                        }
                        .padding(.horizontal, metrics.size(8))
                        .padding(.top, metrics.size(4)).padding(.bottom, metrics.size(14))
                    }
                } else {
                List {
                    if let project {
                        section(store, scope: .project(project.id.rawValue), title: Text(project.name))
                    }
                    section(store, scope: .global, title: Text("todos.global"))
                }
                .listStyle(.sidebar)
                }
            }
                }
            }
            .onChange(of: environment.newTodoRequest) { focus = .draft }
            .gitWebSheet(isPresented: $showingSettings, width: 520) { TodosSettingsSheet(store: store) }
        } else {
            ContentUnavailableView("todos.disabled", systemImage: "checklist")
        }
    }

    private func addRow(_ store: TodoStore) -> some View {
        HStack(spacing: 6) {
            TextField("todos.new.placeholder", text: $draft)
                .textFieldStyle(.roundedBorder)
                .focused($focus, equals: .draft)
                .onSubmit { add(store) }
                .accessibilityIdentifier("todos.newField")
            if project != nil {
                Toggle(isOn: $addToProject) { Image(systemName: "folder") }
                    .toggleStyle(.button)
                    .help("todos.new.toProject")
            }
            Button {
                showingSettings = true
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.borderless)
            .help("todos.settings")
            .accessibilityLabel(Text("todos.settings"))
            .accessibilityIdentifier("todos.settingsButton")
        }
        .padding(8)
    }

    @ViewBuilder
    private func section(_ store: TodoStore, scope: TodoScope, title: Text) -> some View {
        let items = store.todos(in: scope)
        if metrics.isWebInterface {
            AletheSidebarTodoSection(title: title, count: items.count) {
                ForEach(items) { todo in
                    row(store, todo)
                        .modifier(AletheSidebarRowHover())
                        .modifier(AletheSidebarDropIndicator(targeted: dropTarget == todo.id))
                        .draggable(todo.id)
                        .dropDestination(for: String.self) { ids, _ in
                            defer { dropTarget = nil }
                            guard let dragged = ids.first else { return false }
                            store.reorder(dragged, onto: todo.id)
                            return true
                        } isTargeted: { targeted in
                            if targeted { dropTarget = todo.id }
                            else if dropTarget == todo.id { dropTarget = nil }
                        }
                }
            }
        } else {
        Section {
            if items.isEmpty {
                Text("todos.empty").foregroundStyle(.secondary)
            }
            ForEach(items) { todo in
                row(store, todo)
                    .draggable(todo.id)
                    .dropDestination(for: String.self) { ids, _ in
                        guard let dragged = ids.first else { return false }
                        store.reorder(dragged, onto: todo.id)
                        return true
                    }
            }
        } header: {
            title
        }
        }
    }

    private func row(_ store: TodoStore, _ todo: Todo) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button {
                store.toggle(todo.id)
            } label: {
                Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(todo.done ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(todo.done ? "todos.reopen" : "todos.complete"))
            VStack(alignment: .leading, spacing: 2) {
                if editingID == todo.id {
                    TextField("todos.rename", text: $editingTitle)
                        .textFieldStyle(.plain)
                        .focused($focus, equals: .rename)
                        .onSubmit { commitRename(store) }
                        .onExitCommand { editingID = nil }
                } else {
                    Text(todo.title)
                        .strikethrough(todo.done)
                        .foregroundStyle(todo.done ? .secondary : .primary)
                        .onTapGesture(count: 2) { beginRename(todo) }
                }
                if taggingID == todo.id {
                    TextField("todos.tags.placeholder", text: $tagDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .focused($focus, equals: .tags)
                        .onSubmit { commitTags(store) }
                        .onExitCommand { taggingID = nil }
                        .accessibilityIdentifier("todos.tagsField")
                } else if !todo.tags.isEmpty {
                    Text(todo.tags.map { "#" + $0 }.joined(separator: " "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if let url = todo.prURL {
                Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "arrow.triangle.pull") }
                    .buttonStyle(.borderless)
                    .help("todos.openPullRequest")
                    .accessibilityLabel(Text("todos.openPullRequest"))
            }
        }
        .contextMenu { menu(store, todo) }
    }

    @ViewBuilder
    private func menu(_ store: TodoStore, _ todo: Todo) -> some View {
        Button("todos.rename") { beginRename(todo) }
        Button("todos.editTags") { beginTags(todo) }
        Divider()
        if todo.projectID != nil {
            Button("todos.moveToGlobal") { store.move(todo.id, to: .global) }
        }
        if let project, todo.projectID != project.id.rawValue {
            Button(String(format: String(localized: "todos.moveToProject"), project.name)) {
                store.move(todo.id, to: .project(project.id.rawValue))
            }
        }
        if let url = todo.prURL {
            Button("todos.openPullRequest") { NSWorkspace.shared.open(url) }
        }
        Divider()
        Button("todos.delete", role: .destructive) { store.delete(todo.id) }
    }

    private func add(_ store: TodoStore) {
        // `#word` tokens become tags.
        let words = draft.split(separator: " ").map(String.init)
        let tags = words.filter { $0.count > 1 && $0.hasPrefix("#") }.map { String($0.dropFirst()) }
        let title = words.filter { !($0.count > 1 && $0.hasPrefix("#")) }.joined(separator: " ")
        let scope: TodoScope = addToProject ? project.map { .project($0.id.rawValue) } ?? .global : .global
        if store.add(title: title, tags: tags, scope: scope) != nil { draft = "" }
    }

    private func beginRename(_ todo: Todo) {
        editingTitle = todo.title
        editingID = todo.id
        focus = .rename
    }

    private func commitRename(_ store: TodoStore) {
        if let editingID { store.rename(editingID, to: editingTitle) }
        editingID = nil
    }

    private func beginTags(_ todo: Todo) {
        tagDraft = todo.tags.map { "#" + $0 }.joined(separator: " ")
        taggingID = todo.id
        focus = .tags
    }

    /// Replaces the tags with the field's words (`#` optional); an empty field clears them.
    private func commitTags(_ store: TodoStore) {
        if let taggingID { store.setTags(taggingID, [tagDraft]) }
        taggingID = nil
    }
}
