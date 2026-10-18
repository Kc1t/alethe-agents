import AletheDesign
import AletheModel
import AletheIntegrations
import AletheTodos
import AppKit
import SwiftUI

/// TodoSidebar.tsx and TodoSidebar.module.css; the native list remains in TodosView.
struct TodosWebPanel: View {
    let store: TodoStore
    let settings: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var filter = Filter.all
    @State private var draft = ""
    @State private var tags = ""
    @State private var projectID = ""
    @State private var expanded = false
    @State private var dropTarget: String?
    @FocusState private var composerFocused: Bool

    private enum Filter: String, CaseIterable {
        case all, active, completed
        var title: LocalizedStringKey {
            switch self {
            case .all: "rightSidebar.todo.all"
            case .active: "rightSidebar.todo.active"
            case .completed: "rightSidebar.todo.completed"
            }
        }
    }

    private var projects: [Project] { environment.workspace?.document.projects ?? [] }
    private var completed: [Todo] { store.todos.filter(\.done) }
    private var unassigned: [Todo] {
        store.todos.filter { todo in
            !todo.done && !projects.contains { $0.id.rawValue == todo.projectID }
        }
    }
    private var sessions: [GSDSyncSession] {
        guard let id = environment.workspace?.document.workspace.selectedProjectID else { return [] }
        return environment.gsdSync.sessions(of: id)
    }

    var body: some View {
        VStack(spacing: 0) {
            header.modifier(AletheSidebarWebEntrance(.header))
            composer.modifier(AletheSidebarWebEntrance(.composer))
                // TodoSidebar.tsx `focusComposer`: Cmd+N expands and focuses the composer while the panel is mounted.
                .background(TodoComposerShortcut { expanded = true; composerFocused = true })
            ScrollView {
                VStack(spacing: metrics.size(16)) {
                    if filter != .completed && !sessions.isEmpty {
                        VStack(spacing: metrics.size(1)) {
                            HStack(spacing: metrics.size(7)) {
                                Text("rightSidebar.gsdSync")
                                Text(verbatim: String(sessions.count))
                                Spacer(minLength: 0)
                            }
                            .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                            .frame(height: metrics.size(26))
                            ForEach(sessions) { GSDSyncRow(session: $0) }
                        }
                    }
                    if store.todos.isEmpty {
                        WebSidebarEmpty(title: "rightSidebar.todo.empty", detail: "rightSidebar.todo.emptyDetail",
                                        symbol: "checklist", boxed: true, iconSize: 20, centeredInPanel: false)
                    } else {
                        if filter != .completed {
                            ForEach(projects) { project in
                                let items = store.todos(in: .project(project.id.rawValue)).filter { !$0.done }
                                if !items.isEmpty {
                                    section(Text(verbatim: project.name), items: items, project: project.id.rawValue)
                                }
                            }
                            if !unassigned.isEmpty {
                                section(Text("rightSidebar.todo.noProject"), items: unassigned)
                            }
                        }
                        if filter != .active {
                            section(Text("rightSidebar.todo.completed"), items: completed, completed: true)
                        }
                        if filter == .active && store.todos.allSatisfy(\.done) {
                            Text("rightSidebar.todo.empty").font(metrics.font(size: 11))
                                .foregroundStyle(theme[.fgFaint]).padding(.vertical, metrics.size(12))
                                .padding(.horizontal, metrics.size(6)).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(.horizontal, metrics.size(8)).padding(.top, metrics.size(4))
                .padding(.bottom, metrics.size(14))
            }.modifier(AletheSidebarWebEntrance(.content))
        }
        .background(theme[.bg])
        .modifier(AletheSidebarWebEntrance(.sidebar))
        .accessibilityIdentifier("todos.web.panel")
        .onChange(of: environment.newTodoRequest) { expanded = true; composerFocused = true }
    }

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "checklist").resizable().scaledToFit()
                    .frame(width: metrics.size(17), height: metrics.size(17))
                Text("rightSidebar.todo.title").font(metrics.font(size: metrics.style == .clean ? 13 : 14, weight: .medium))
                Spacer(minLength: 0)
                Button(action: settings) {
                    Label("todos.settings", systemImage: "gearshape").font(metrics.font(size: 14))
                }
                .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 24, height: 24))
                .help(Text("todos.settings")).accessibilityIdentifier("todos.settingsButton")
            }
            .foregroundStyle(theme[.fg]).frame(minHeight: metrics.size(28))
            HStack(spacing: metrics.size(9)) {
                GeometryReader { geometry in
                    RoundedRectangle(cornerRadius: metrics.size(2)).fill(theme[.borderStrong])
                        .overlay(alignment: .leading) {
                            RoundedRectangle(cornerRadius: metrics.size(2)).fill(theme[.statusWorking])
                                .frame(width: geometry.size.width * CGFloat(completed.count) / CGFloat(max(1, store.todos.count)))
                                .animation(Motion.sidebarEntrance(duration: 0.22, reduceMotion: metrics.reducesMotion), value: completed.count)
                        }
                }
                .frame(height: metrics.size(4))
                .accessibilityLabel(Text("rightSidebar.todo.completed"))
                .accessibilityValue(Text(verbatim: "\(completed.count) / \(store.todos.count)"))
                Text(verbatim: "\(completed.count) / \(store.todos.count)")
                    .font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint]).fixedSize()
            }
            .padding(.horizontal, metrics.size(2)).padding(.top, metrics.size(8)).padding(.bottom, metrics.size(7))
            HStack(spacing: metrics.size(2)) {
                ForEach(Filter.allCases, id: \.self) { option in
                    Button { filter = option } label: { Text(option.title) }
                        .buttonStyle(AletheSidebarFilterStyle(selected: filter == option, kind: .todo))
                        .accessibilityAddTraits(filter == option ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: metrics.size(32))
            .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
        }
        .padding(.horizontal, metrics.size(metrics.style == .clean ? 8 : 10)).padding(.top, metrics.size(metrics.style == .clean ? 8 : 10))
    }

    private var composer: some View {
        VStack(spacing: metrics.size(6)) {
            HStack(spacing: metrics.size(7)) {
                Button(action: add) {
                    Label("rightSidebar.todo.add", systemImage: "plus").font(metrics.font(size: 15))
                }
                .buttonStyle(AletheSidebarUtilityStyle(width: 22, height: 22, disabledOpacity: 0.55))
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help(Text("rightSidebar.todo.add"))
                .accessibilityIdentifier("todos.add")
                TextField("rightSidebar.todo.placeholder", text: $draft)
                    .textFieldStyle(.plain).font(metrics.font(size: 12)).foregroundStyle(theme[.fg])
                    .focused($composerFocused).onSubmit(add)
                    .onChange(of: composerFocused) { if composerFocused { expanded = true } }
                    .onExitCommand { if draft.isEmpty { expanded = false; composerFocused = false } }
                    .accessibilityIdentifier("todos.newField")
                Text(verbatim: "⌘N").font(metrics.monoFont(size: 9)).foregroundStyle(theme[.fgFaint])
            }
            .padding(.horizontal, metrics.size(8)).frame(height: metrics.size(36))
            .modifier(AletheSidebarFieldBorder(focused: composerFocused, composer: true))
            if expanded {
                HStack(spacing: metrics.size(6)) {
                    HStack(spacing: metrics.size(5)) {
                        Image(systemName: "tag").font(metrics.font(size: 13))
                        TextField("todos.tags.placeholder", text: $tags).textFieldStyle(.plain)
                    }
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                    .padding(.horizontal, metrics.size(7)).frame(height: metrics.size(26))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    TodoWebProjectPicker(projects: projects, selected: projectID) { projectID = $0 }
                }
            }
        }
        .padding(.horizontal, metrics.size(metrics.style == .clean ? 8 : 10)).padding(.top, metrics.size(metrics.style == .clean ? 8 : 10)).padding(.bottom, metrics.size(2))
    }

    private func add() {
        if store.add(title: draft, tags: tags.split(whereSeparator: { $0 == "#" || $0 == "," || $0.isWhitespace }).map(String.init),
                     scope: projectID.isEmpty ? .global : .project(projectID)) != nil {
            draft = ""; tags = ""; projectID = ""; expanded = false
        }
    }

    private func section(_ title: Text, items: [Todo], project: String = "", completed: Bool = false) -> some View {
        TodoWebSection(title: title, count: items.count, completed: completed, add: {
            projectID = project; expanded = true; composerFocused = true
        }) {
            ForEach(items) { todo in
                TodoWebRow(store: store, todo: todo, projects: projects)
                    .modifier(AletheSidebarDropIndicator(targeted: dropTarget == todo.id))
                    .draggable(todo.id)
                    .dropDestination(for: String.self) { ids, _ in
                        defer { dropTarget = nil }
                        guard let id = ids.first, let dragged = store.todo(id: id), dragged.done == todo.done else { return false }
                        store.reorder(id, onto: todo.id)
                        return true
                    } isTargeted: { targeted in
                        if targeted { dropTarget = todo.id }
                        else if dropTarget == todo.id { dropTarget = nil }
                    }
            }
        }
    }
}

private struct TodoWebSection<Content: View>: View {
    let title: Text
    let count: Int
    let completed: Bool
    let add: () -> Void
    let content: Content
    @State private var collapsed: Bool
    @State private var hovering = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    init(title: Text, count: Int, completed: Bool, add: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title; self.count = count; self.completed = completed; self.add = add
        self.content = content(); _collapsed = State(initialValue: completed)
    }

    var body: some View {
        VStack(spacing: metrics.size(metrics.style == .clean ? 0 : 1)) {
            HStack(spacing: metrics.size(2)) {
                Button { collapsed.toggle() } label: {
                    HStack(spacing: metrics.size(7)) {
                        Image(systemName: "chevron.down").resizable().scaledToFit()
                            .frame(width: metrics.size(13), height: metrics.size(13))
                            .rotationEffect(.degrees(collapsed ? -90 : 0))
                            .animation(Motion.sidebarChevron(reduceMotion: metrics.reducesMotion), value: collapsed)
                        title.font(metrics.font(size: 11, weight: metrics.style == .clean ? .semibold : .medium)).lineLimit(1)
                        Text(verbatim: String(count)).font(metrics.font(size: 9))
                            .padding(.horizontal, metrics.size(metrics.style == .clean ? 0 : 5))
                            .frame(minWidth: metrics.style == .clean ? nil : metrics.size(18), minHeight: metrics.style == .clean ? nil : metrics.size(16))
                            .background(theme[.bgElevated].opacity(metrics.style == .clean ? 0 : 1), in: Capsule())
                        Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
                    }
                    .foregroundStyle(theme[.fgMuted]).padding(.horizontal, metrics.size(metrics.style == .clean ? 0 : 5))
                    .frame(height: metrics.size(26)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).modifier(AletheSidebarRowHover())
                .accessibilityLabel(title).accessibilityValue(Text(verbatim: String(count)))
                if !completed {
                    Button(action: add) { Label("rightSidebar.todo.add", systemImage: "plus").font(metrics.font(size: 13)) }
                        .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 22, height: 22))
                        .opacity(hovering ? 1 : 0).help(Text("rightSidebar.todo.add"))
                }
            }
            .onHover { hovering = $0 }
            if !collapsed { content }
            if completed && (collapsed || count == 0) {
                Text("rightSidebar.todo.emptyCompleted").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                    .padding(metrics.size(6)).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct TodoWebRow: View {
    let store: TodoStore
    let todo: Todo
    let projects: [Project]
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false
    @State private var editing = false
    @State private var draft = ""
    @State private var editingTags = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: metrics.size(5)) {
            Image(systemName: "ellipsis").rotationEffect(.degrees(90))
                .font(metrics.font(size: 13)).foregroundStyle(theme[.fgMuted])
                .frame(width: metrics.size(13), height: metrics.size(24)).opacity(hovering || focused ? 1 : 0)
                .accessibilityHidden(true)
            Button { store.toggle(todo.id) } label: {
                Image(systemName: "checkmark").resizable().scaledToFit()
                    .frame(width: metrics.size(12), height: metrics.size(12)).opacity(todo.done ? 1 : 0)
                    .foregroundStyle(theme[.bg]).frame(width: metrics.size(17), height: metrics.size(17))
                    .background(theme[.statusWorking].opacity(todo.done ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.size(5)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(5))
                        .strokeBorder(theme[todo.done ? .statusWorking : .fgFaint], lineWidth: metrics.size(1.5)))
            }
            .buttonStyle(.plain).frame(width: metrics.size(19))
            .accessibilityIdentifier("todos.toggle.\(todo.id)")
            .accessibilityLabel(Text((todo.done ? "todos.reopen" : "todos.complete") as LocalizedStringKey))
            .help(Text((todo.done ? "todos.reopen" : "todos.complete") as LocalizedStringKey))
            if editing || editingTags {
                TextField((editingTags ? "todos.tags.placeholder" : "todos.rename") as LocalizedStringKey, text: $draft)
                    .textFieldStyle(.plain).font(metrics.font(size: 12)).focused($focused)
                    .padding(.horizontal, metrics.size(6)).frame(height: metrics.size(26))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                    .onSubmit(save).onExitCommand { editing = false; editingTags = false }
                    .accessibilityIdentifier(editingTags ? "todos.tagsField" : "todos.renameField")
            } else {
                HStack(spacing: metrics.size(5)) {
                    Button { beginEdit() } label: {
                        Text(verbatim: todo.title).strikethrough(todo.done).lineLimit(1)
                            .font(metrics.font(size: 12)).foregroundStyle(theme[todo.done ? .fgFaint : .fg])
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.buttonStyle(.plain).help(todo.title)
                    if !todo.tags.isEmpty {
                        Text(verbatim: todo.tags.map { "#" + $0 }.joined(separator: " "))
                            .font(metrics.font(size: 9)).foregroundStyle(theme[.fgFaint])
                            .lineLimit(1).frame(maxWidth: metrics.size(72))
                    }
                    if let url = todo.prURL {
                        Button { NSWorkspace.shared.open(url) } label: {
                            Label("todos.openPullRequest", systemImage: "arrow.up.right.square").font(metrics.font(size: 11))
                        }.labelStyle(.iconOnly).buttonStyle(.plain).help(Text("todos.openPullRequest"))
                    }
                    TodoWebProjectPicker(projects: projects, selected: todo.projectID ?? "", compact: true) {
                        store.move(todo.id, to: $0.isEmpty ? .global : .project($0))
                    }
                    .frame(maxWidth: metrics.size(84))
                }
                .padding(.vertical, metrics.size(4))
            }
            if hovering || focused {
                HStack(spacing: metrics.size(1)) {
                    Button { if editing { save() } else { beginEdit() } } label: {
                        Label((editing ? "rightSidebar.todo.save" : "todos.rename") as LocalizedStringKey, systemImage: editing ? "checkmark" : "pencil")
                            .font(metrics.font(size: 12))
                    }.help(Text((editing ? "rightSidebar.todo.save" : "todos.rename") as LocalizedStringKey))
                    Button { store.delete(todo.id) } label: {
                        Label("todos.delete", systemImage: "trash").font(metrics.font(size: 12))
                    }.help(Text("todos.delete"))
                }.buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 20, height: 20))
            }
        }
        .padding(.leading, metrics.size(1)).padding(.trailing, metrics.size(5)).padding(.vertical, metrics.size(2))
        .frame(minHeight: metrics.size(metrics.style == .clean ? 30 : 36))
        .background(theme[.panelHover].opacity(hovering || focused ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(0) : metrics.radius(.md)))
        .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
        .onHover { hovering = $0 }
        .accessibilityIdentifier("todos.row.\(todo.id)")
        .contextMenu {
            Button { beginEdit() } label: { Label("todos.rename", systemImage: "pencil") }
            Button {
                draft = todo.tags.map { "#" + $0 }.joined(separator: " ")
                editingTags = true; focused = true
            } label: { Label("todos.editTags", systemImage: "tag") }
            Divider()
            Button(role: .destructive) { store.delete(todo.id) } label: { Label("todos.delete", systemImage: "trash") }
        }
    }

    private func beginEdit() { draft = todo.title; editing = true; focused = true }
    private func save() {
        if editingTags { store.setTags(todo.id, draft.split(whereSeparator: { $0 == "#" || $0 == "," || $0.isWhitespace }).map(String.init)) }
        else { store.rename(todo.id, to: draft) }
        editing = false; editingTags = false
    }
}

private struct TodoWebProjectPicker: View {
    let projects: [Project]
    let selected: String
    var compact = false
    let choose: (String) -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        Menu {
            Button("rightSidebar.todo.noProject") { choose("") }
            ForEach(projects) { project in
                Button { choose(project.id.rawValue) } label: { Text(verbatim: project.name) }
            }
        } label: {
            HStack(spacing: metrics.size(compact ? 4 : 5)) {
                Image(systemName: "folder").resizable().scaledToFit()
                    .frame(width: metrics.size(compact ? 11 : 13), height: metrics.size(compact ? 11 : 13))
                Group {
                    if let project = projects.first(where: { $0.id.rawValue == selected }) { Text(verbatim: project.name) }
                    else { Text("rightSidebar.todo.noProject") }
                }.lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down").font(metrics.font(size: 8))
            }
            .font(metrics.font(size: compact ? 10 : 11)).foregroundStyle(theme[compact ? .fgFaint : .fgMuted])
            .padding(.horizontal, metrics.size(compact ? 6 : 7)).frame(height: metrics.size(compact ? 21 : 26))
            .background(theme[.bgSunken].opacity(compact ? 0.72 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border].opacity(compact ? 0 : 1), lineWidth: metrics.size(1)))
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(Text("todos.new.toProject"))
    }
}

/// A local key monitor that claims plain Cmd+N for the todo composer (it is installed after the
/// window-level shortcuts, so it sees the key first while the panel is on screen).
private struct TodoComposerShortcut: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> MonitorView { MonitorView() }
    func updateNSView(_ view: MonitorView, context: Context) { view.action = action; view.install() }
    static func dismantleNSView(_ view: MonitorView, coordinator: ()) { view.uninstall() }

    @MainActor final class MonitorView: NSView {
        var action: (() -> Void)?
        private var monitor: Any?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func install() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                let handled = MainActor.assumeIsolated { self?.handle(event) ?? false }
                return handled ? nil : event
            }
        }

        func uninstall() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }

        private func handle(_ event: NSEvent) -> Bool {
            guard let window, window.isKeyWindow, event.window === window, window.attachedSheet == nil,
                  event.modifierFlags.intersection([.command, .control, .option, .shift]) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "n" else { return false }
            action?()
            return true
        }
    }
}
