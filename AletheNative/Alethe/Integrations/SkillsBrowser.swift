import AletheDesign
import AletheDocuments
import AletheFoundation
import AletheIntegrations
import AppKit
import SwiftUI

/// The skills of every agent (upstream `SkillsBrowser`, EXT-2): list with agent filter and search,
/// detail with where it is installed, frontmatter, install source, files and the rendered `SKILL.md`;
/// uninstall asks once. Embedded by the MCP manager (P5-25) and shown alone by `SkillsSheet`.
struct SkillsBrowser: View {
    @State var model: SkillsBrowserModel
    @State private var removal: SkillsBrowserModel.Removal?
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.isWebInterface ? metrics.size(14) : 0) {
            sidebar
                .frame(width: metrics.size(metrics.isWebInterface ? 210 : 240))
            if !metrics.isWebInterface { Divider() }
            detailPane
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await model.load() }
        .onDisappear { model.cancel() }
        .webConfirm(isPresented: Binding { removal != nil } set: { if !$0 { removal = nil } },
                    message: removal.map(removalMessage) ?? "", title: String(localized: "skills.remove.title"),
                    confirmTitle: String(localized: "skills.remove.action"), destructive: true) {
            if let removal { model.remove(removal) }
        }
        .confirmationDialog(Text("skills.remove.title"), isPresented: Binding {
            !metrics.isWebInterface && removal != nil
        } set: { if !$0 { removal = nil } }, presenting: removal) { removal in
            Button("skills.remove.action", role: .destructive) { model.remove(removal) }
                .accessibilityIdentifier("skills.remove.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { removal in
            Text(verbatim: removalMessage(removal))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("skills.browser")
    }

    // MARK: List

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            TextField(text: $model.query, prompt: Text("skills.filter")) { Text("skills.filter") }
                .textFieldStyle(.roundedBorder)
                .modifier(ModalsM2Input())
                .accessibilityIdentifier("skills.filter")
            if metrics.isWebInterface {
                WebDropdown(selection: $model.agentFilter, options: [SkillAgent?.none] + SkillAgent.allCases.map { Optional($0) }) { value in
                    if let value { Text(verbatim: value.label) } else { Text("skills.agent.all") }
                }
                .accessibilityIdentifier("skills.agentFilter")
            } else {
            Picker(selection: $model.agentFilter) {
                Text("skills.agent.all").tag(SkillAgent?.none)
                ForEach(SkillAgent.allCases, id: \.self) { agent in
                    Text(verbatim: agent.label).tag(SkillAgent?.some(agent))
                }
            } label: {
                Text("skills.agent.filter")
            }
            .labelsHidden()
            .accessibilityIdentifier("skills.agentFilter")
            }
            list
        }
        .padding(metrics.isWebInterface ? 0 : metrics.space(.m))
        .padding(.trailing, metrics.isWebInterface ? metrics.size(12) : 0)
        .overlay(alignment: .trailing) {
            if metrics.isWebInterface { Rectangle().fill(theme[.borderSubtle]).frame(width: metrics.size(1)) }
        }
    }

    @ViewBuilder private var list: some View {
        if model.snapshots == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.groups.isEmpty {
            Text("skills.empty.title")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("skills.empty")
        } else if model.visibleGroups.isEmpty {
            Text("skills.noMatch")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("skills.noMatch")
        } else {
            if metrics.isWebInterface {
                ScrollView {
                    VStack(spacing: metrics.size(2)) {
                        ForEach(model.visibleGroups) { group in
                            Button { model.selection = group.name } label: { row(group) }
                                .buttonStyle(ModalsM2RowStyle(selected: model.activeGroup?.name == group.name, vertical: 6))
                        }
                    }
                }.accessibilityIdentifier("skills.list")
            } else {
                List(model.visibleGroups, selection: $model.selection) { group in row(group).tag(group.name) }
                    .listStyle(.sidebar).accessibilityIdentifier("skills.list")
            }
        }
    }

    private func row(_ group: SkillGroup) -> some View {
        HStack(spacing: metrics.space(.xs)) {
            Text(verbatim: group.name)
                .lineLimit(1)
                .truncationMode(.middle)
            if group.bundled {
                Image(systemName: "lock.fill")
                    .foregroundStyle(theme[.textTertiary])
                    .accessibilityLabel(Text("skills.badge.bundled"))
            }
            if group.sharedEntry != nil {
                Image(systemName: "link")
                    .foregroundStyle(theme[.textTertiary])
                    .accessibilityLabel(Text("skills.badge.shared"))
            }
            Spacer(minLength: 0)
            Text(verbatim: "\(group.agents.count)")
                .font(metrics.font(.caption).monospacedDigit())
                .foregroundStyle(theme[.textTertiary])
        }
        .font(metrics.isWebInterface ? metrics.font(size: 12.5) : metrics.font(.body))
        .accessibilityIdentifier("skills.row.\(group.name)")
    }

    // MARK: Detail

    @ViewBuilder private var detailPane: some View {
        if let group = model.activeGroup {
            ScrollView {
                VStack(alignment: .leading, spacing: metrics.isWebInterface ? metrics.size(14) : metrics.space(.xl)) {
                    banners
                    header(group)
                    installedOn(group)
                    if let detail = model.detail, detail.summary.name == group.name {
                        fields(detail)
                        files(detail)
                        section("skills.section.skillFile") {
                            MarkdownBlocksView(blocks: model.blocks)
                                .padding(metrics.isWebInterface ? metrics.size(12) : 0)
                                .overlay {
                                    if metrics.isWebInterface {
                                        RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1))
                                    }
                                }
                                .accessibilityIdentifier("skills.body")
                        }
                    } else if model.detailError == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding(metrics.isWebInterface ? 0 : metrics.space(.xl))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if model.snapshots != nil {
            VStack(spacing: metrics.space(.m)) {
                banners
                if model.groups.isEmpty {
                    ContentUnavailableView {
                        Label("skills.empty.title", systemImage: "wand.and.stars")
                    } description: {
                        Text("skills.empty.detail")
                    }
                } else {
                    ContentUnavailableView("skills.noMatch", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            .padding(metrics.isWebInterface ? 0 : metrics.space(.xl))
        }
    }

    @ViewBuilder private var banners: some View {
        if let error = model.error ?? model.detailError {
            Label { Text(verbatim: error).textSelection(.enabled) } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(metrics.font(.footnote))
            .foregroundStyle(theme[.statusStopped])
            .accessibilityIdentifier("skills.error")
        }
        if let note = model.note {
            Text(verbatim: note)
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                .accessibilityIdentifier("skills.note")
        }
    }

    private func header(_ group: SkillGroup) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: group.name)
                    .font(metrics.isWebInterface ? metrics.font(size: 15, weight: .medium) : metrics.font(.title3))
                    .textSelection(.enabled)
                if group.bundled {
                    badge("skills.badge.bundled", systemImage: "lock.fill")
                }
                Spacer()
                if !group.bundled && !group.removable.isEmpty {
                    Button(role: .destructive) {
                        removal = .init(group: group.name, entries: group.removable)
                    } label: {
                        Text(verbatim: group.removable.count > 1
                             ? format("skills.remove.all", group.removable.count)
                             : String(localized: "skills.remove.action"))
                    }
                    .disabled(model.busy)
                    .accessibilityIdentifier("skills.remove")
                }
            }
            if !group.description.isEmpty {
                Text(verbatim: group.description)
                    .font(metrics.isWebInterface ? metrics.font(size: 12.5) : metrics.font(.body))
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private func installedOn(_ group: SkillGroup) -> some View {
        section("skills.section.installedOn") {
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                ForEach(group.entries) { entry in
                    HStack(spacing: metrics.space(.s)) {
                        Circle().fill(theme[entry.agent.colorToken]).frame(width: metrics.size(8), height: metrics.size(8))
                        Text(verbatim: entry.agent.label)
                            .font(metrics.font(.body).weight(.medium))
                        if entry.bundled { badge("skills.badge.bundled", systemImage: "lock.fill") }
                        if entry.linked { badge("skills.badge.linked", systemImage: "link") }
                        Text(verbatim: entry.path)
                            .font(metrics.isWebInterface ? metrics.monoFont(size: 10.5) : metrics.font(.caption).monospaced())
                            .foregroundStyle(theme[.textSecondary])
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(Text(verbatim: entry.resolvedPath))
                        Spacer(minLength: 0)
                        Button {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: entry.resolvedPath)])
                        } label: {
                            Image(systemName: "folder")
                        }
                        .buttonStyle(.borderless)
                        .help(Text("skills.reveal"))
                        .accessibilityLabel(Text("skills.reveal"))
                        // The shared copy goes only when no agent links it; otherwise remove the links.
                        if !entry.bundled && (entry.agent != .shared || group.agents.isEmpty) {
                            Button {
                                removal = .init(group: group.name, entries: [entry])
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                            .disabled(model.busy)
                            .help(Text("skills.remove.action"))
                            .accessibilityLabel(Text("skills.remove.action"))
                            .accessibilityIdentifier("skills.remove.\(entry.agent.rawValue)")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func fields(_ detail: SkillDetail) -> some View {
        if !detail.frontmatter.isEmpty {
            section("skills.section.frontmatter") {
                keyValues(detail.frontmatter.sorted { $0.key < $1.key }.map { ($0.key, $0.value) })
            }
        }
        if let lock = detail.lock {
            let rows: [(String, String)] = [
                (String(localized: "skills.lock.source"), lock.source),
                (String(localized: "skills.lock.url"), lock.sourceURL),
                (String(localized: "skills.lock.installed"), lock.installedAt),
                (String(localized: "skills.lock.updated"), lock.updatedAt),
            ].compactMap { key, value in value.map { (key, $0) } }
            if !rows.isEmpty {
                section("skills.section.installInfo") { keyValues(rows) }
            }
        }
    }

    private func keyValues(_ rows: [(String, String)]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: metrics.space(.l), verticalSpacing: metrics.space(.xs)) {
            ForEach(rows, id: \.0) { key, value in
                GridRow {
                    Text(verbatim: key)
                        .font(metrics.font(.footnote).monospaced())
                        .foregroundStyle(theme[.textTertiary])
                    Text(verbatim: value)
                        .font(metrics.isWebInterface ? metrics.font(size: 12.5) : metrics.font(.body))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func files(_ detail: SkillDetail) -> some View {
        section("skills.section.files") {
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                OutlineGroup(detail.tree, children: \.childrenIfFolder) { node in
                    Label {
                        Text(verbatim: node.name)
                            .font(metrics.isWebInterface ? metrics.font(size: 12.5) : metrics.font(.body))
                    } icon: {
                        Image(systemName: node.isDirectory ? "folder" : "doc.text")
                            .foregroundStyle(theme[.textTertiary])
                    }
                    .help(Text(verbatim: node.path))
                }
                if detail.tree.contains(where: \.truncated) {
                    Text("skills.files.truncated")
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textTertiary])
                }
            }
            .accessibilityIdentifier("skills.files")
        }
    }

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            Text(title)
                .font(metrics.font(.footnote).weight(.semibold))
                .foregroundStyle(theme[.textSecondary])
                .textCase(.uppercase)
            content()
        }
    }

    private func badge(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(metrics.font(.caption))
            .foregroundStyle(theme[.textSecondary])
            .padding(.horizontal, metrics.space(.s))
            .padding(.vertical, metrics.space(.xxs))
            .background(theme[.bgSunken], in: Capsule())
    }

    private func removalMessage(_ removal: SkillsBrowserModel.Removal) -> String {
        var message = format("skills.remove.message", removal.group,
                             removal.entries.map(\.agent.label).joined(separator: ", "))
        if let linked = removal.entries.first(where: \.linked) {
            message += "\n\n" + format("skills.remove.linkNote", linked.resolvedPath)
        } else {
            message += "\n\n" + String(localized: "skills.remove.trashNote")
        }
        return message
    }
}

/// The browser on its own (History › Skills…); the MCP manager (P5-25) embeds it too.
struct SkillsSheet: View {
    let store: SkillStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if metrics.isWebInterface {
                ModalsM2WebModal(title: Text("mcp.tab.skills"), close: { if let closeOverlay { closeOverlay() } else { dismiss() } }, width: 880) {
                    SkillsBrowser(model: SkillsBrowserModel(store: store)).frame(height: metrics.size(380))
                } footer: {
                    Spacer()
                    Button("agentInstall.done") { if let closeOverlay { closeOverlay() } else { dismiss() } }.accessibilityIdentifier("skills.done")
                }
            } else { nativeBody }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("skills.sheet")
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            SkillsBrowser(model: SkillsBrowserModel(store: store))
            Divider()
            HStack {
                Spacer()
                Button("agentInstall.done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("skills.done")
            }
            .padding(metrics.space(.l))
        }
        .frame(width: metrics.size(820), height: metrics.size(560))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("skills.sheet")
    }
}

@MainActor @Observable
final class SkillsBrowserModel {
    /// Entries of one skill to uninstall together, confirmed once.
    struct Removal: Hashable {
        var group: String
        var entries: [SkillSummary]
    }

    let store: SkillStore
    private(set) var snapshots: [SkillAgentSnapshot]?
    private(set) var groups: [SkillGroup] = []
    private(set) var detail: SkillDetail?
    private(set) var blocks: [MarkdownBlock] = []
    private(set) var busy = false
    private(set) var error: String? { didSet { if error != oldValue { AppLog.shown(error, .integrations) } } }
    private(set) var detailError: String? { didSet { if detailError != oldValue { AppLog.shown(detailError, .integrations) } } }
    /// Outcome of the last removal.
    private(set) var note: String?
    var query = "" { didSet { loadDetail() } }
    var agentFilter: SkillAgent? { didSet { loadDetail() } }
    var selection: String? { didSet { loadDetail() } }

    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var detailTask: Task<Void, Never>?
    /// The skill copy `detail` shows or is loading.
    @ObservationIgnored private var detailKey: String?

    init(store: SkillStore) { self.store = store }

    var visibleGroups: [SkillGroup] {
        groups.filter { $0.matches(query) && $0.isInstalled(for: agentFilter) }
    }

    /// The selected skill, or the first one shown.
    var activeGroup: SkillGroup? {
        let visible = visibleGroups
        return visible.first { $0.name == selection } ?? visible.first
    }

    func load() async {
        loadTask?.cancel()
        let store = store
        let task = Task {
            do {
                let snapshots = try await store.scan()
                self.snapshots = snapshots
                groups = SkillGroup.group(snapshots)
                error = nil
                if !groups.contains(where: { $0.name == selection }) { selection = nil }
            } catch is CancellationError {
            } catch {
                snapshots = snapshots ?? []
                self.error = Self.describe(error)
            }
            loadDetail()
        }
        loadTask = task
        await task.value
    }

    /// Stops pending reads; the next `load` starts them again.
    func cancel() {
        loadTask?.cancel()
        detailTask?.cancel()
        detailKey = nil
    }

    /// Reads the active skill from wherever it lives (every copy is the same folder).
    private func loadDetail() {
        guard let source = activeGroup?.entries.first else {
            detailTask?.cancel()
            detailKey = nil
            detail = nil
            blocks = []
            detailError = nil
            return
        }
        guard source.id != detailKey else { return }
        detailTask?.cancel()
        detailKey = source.id
        let store = store
        detailError = nil
        detailTask = Task {
            do {
                let detail = try await store.detail(agent: source.agent, name: source.name)
                let base = URL(filePath: detail.summary.path, directoryHint: .isDirectory)
                let body = detail.body
                let blocks = await Task.detached { MarkdownBlocks.parse(body, base: base) }.value
                try Task.checkCancellation()
                self.detail = detail
                self.blocks = blocks
            } catch is CancellationError {
            } catch {
                detail = nil
                blocks = []
                detailError = Self.describe(error)
            }
        }
    }

    func remove(_ removal: Removal) {
        guard !busy else { return }
        busy = true
        error = nil
        note = nil
        let store = store
        Task {
            var removed: [String] = []
            var failures: [String] = []
            var keptShared: String?
            var trashed = false
            for entry in removal.entries {
                do {
                    let report = try await store.uninstall(agent: entry.agent, name: entry.name)
                    removed.append(entry.agent.label)
                    keptShared = report.sharedCopyPath ?? keptShared
                    trashed = trashed || report.movedToTrash
                } catch {
                    failures.append("\(entry.agent.label): \(Self.describe(error))")
                }
            }
            if !removed.isEmpty {
                var note = format("skills.removed", removal.group, removed.joined(separator: ", "))
                if let keptShared { note += " " + format("skills.removed.linkOnly", keptShared) }
                if trashed { note += " " + String(localized: "skills.removed.trash") }
                self.note = note
            }
            if !failures.isEmpty {
                error = format("skills.remove.failed", failures.joined(separator: " · "))
            }
            detail = nil
            detailKey = nil
            await load()
            busy = false
        }
    }

    static func describe(_ error: any Error) -> String {
        switch error as? SkillError {
        case .invalidName?: String(localized: "skills.error.invalidName")
        case .notFound?: String(localized: "skills.error.notFound")
        case .outsideRoot?: String(localized: "skills.error.outsideRoot")
        case .bundled?: String(localized: "skills.error.bundled")
        case .removeFailed(let reason)?: reason
        case nil: error.localizedDescription
        }
    }
}

extension SkillAgent {
    /// Product names stay as they are; only the shared store is translated.
    var label: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        case .antigravity: "Antigravity"
        case .shared: String(localized: "skills.agent.shared")
        }
    }

    var colorToken: ThemeToken {
        switch self {
        case .claude: .agentClaude
        case .codex: .agentCodex
        case .opencode: .agentOpencode
        case .antigravity: .agentAntigravity
        case .shared: .textTertiary
        }
    }
}

extension SkillNode {
    /// Nil for files, so `OutlineGroup` shows no disclosure triangle.
    var childrenIfFolder: [SkillNode]? { isDirectory ? children : nil }
}
