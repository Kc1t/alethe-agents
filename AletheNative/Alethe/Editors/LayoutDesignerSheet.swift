import AletheDesign
import AletheModel
import SwiftUI

/// Custom grid designer (upstream `LayoutDesignerModal`): track counts, presets and recent grids on
/// the left, a canvas where each pane is a box. Click a box to select it and grow or shrink it from
/// its edges; drag it onto a free slot or another box to move or swap. Save switches the project to
/// the Grid layout and remembers the grid in its recent ones.
struct LayoutDesignerSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let scope: LayoutDesignerScope
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var draft = CustomGrid(cols: 2, rows: 1)
    @State private var selected: String?
    @State private var dragging: (id: String, offset: CGSize)?
    @State private var loaded = false

    static let maxTracks = 8

    private var project: Project? {
        guard case .project(let id) = scope else { return nil }
        return workspace.document.project(id)
    }
    private var group: ProjectGroup? {
        guard case .group(let id) = scope else { return nil }
        return workspace.document.groups.first { $0.id == id }
    }
    private var children: [Project] {
        let ids = group?.projectIDs ?? workspace.document.workspace.openProjectIDs
        return ids.compactMap(workspace.document.project)
    }
    private var ids: [String] { project?.visiblePanes.map(\.id.rawValue) ?? children.map(\.id.rawValue) }
    private var currentLayout: CustomGrid? {
        switch scope {
        case .project: project?.effectiveGrid
        case .group: group?.gridLayout
        case .workspace: environment.preferences?.document.workspaceGridLayout
        }
    }
    private var history: [CustomGridHistoryEntry] {
        switch scope {
        case .project: project?.activeArrangement.gridLayoutHistory ?? []
        case .group: group?.gridLayoutHistory ?? []
        case .workspace: environment.preferences?.document.workspaceGridLayoutHistory ?? []
        }
    }
    private var title: String {
        switch scope {
        case .project: String(format: String(localized: "layoutDesigner.title"), project?.name ?? "")
        case .group: String(format: String(localized: "layoutDesigner.web.groupTitle"), group?.name ?? "")
        case .workspace: String(localized: "layoutDesigner.web.workspaceTitle")
        }
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    @Environment(\.newTerminalModalHeight) private var maximumHeight

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text(verbatim: title)
        } content: {
            VStack(spacing: metrics.size(12)) {
                webToolbar
                HStack(spacing: 0) {
                    library
                    canvas.padding(metrics.size(18))
                }
                .frame(height: max(metrics.size(160), min(metrics.size(340), maximumHeight - metrics.size(220))))
                Text("layoutDesigner.hint").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            }
        } footer: {
            if case .workspace = scope, currentLayout != nil {
                Button("layoutDesigner.web.remove") {
                    environment.preferences?.update { $0.workspaceGridLayout = nil }
                    dismiss()
                }.accessibilityIdentifier("layoutDesigner.remove")
            }
            Spacer()
            Button("editor.cancel", action: dismiss)
            Button("layoutDesigner.save", action: save).buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("editor.confirm")
        }
        .onAppear(perform: load)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("layoutDesigner")
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            HStack(spacing: 0) {
                library
                Divider()
                canvas
                    .padding(metrics.space(.xl))
            }
            Divider()
            HStack {
                Text("layoutDesigner.hint")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
                Spacer()
                Button("editor.cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("layoutDesigner.save", action: save)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("editor.confirm")
            }
            .padding(metrics.space(.l))
        }
        .frame(width: metrics.size(760), height: metrics.size(500))
        .background(theme[.surfaceModal])
        .onAppear(perform: load)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("layoutDesigner")
    }

    // MARK: - Toolbar

    private var webToolbar: some View {
        HStack(spacing: metrics.size(12)) {
            webStepper("layoutDesigner.web.columns", value: draft.cols, id: "columns") { setTracks(cols: $0, rows: draft.rows) }
            webStepper("layoutDesigner.web.rows", value: draft.rows, id: "rows") { setTracks(cols: draft.cols, rows: $0) }
            Button("layoutDesigner.autoArrange") { apply(.auto(ids, cols: draft.cols)) }
                .buttonStyle(AletheButtonStyle(size: .small))
                .accessibilityIdentifier("layoutDesigner.autoArrange")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, metrics.size(18)).padding(.vertical, metrics.size(10))
        .background(theme[.bgSunken])
        .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
    }

    private func webStepper(_ label: LocalizedStringKey, value: Int, id: String,
                            set: @escaping (Int) -> Void) -> some View {
        HStack(spacing: metrics.size(6)) {
            Text(label).textCase(.uppercase).font(metrics.font(size: 11, weight: .medium))
                .tracking(metrics.size(0.66)).foregroundStyle(theme[.fgFaint])
            Button { set(max(1, value - 1)) } label: { Image(systemName: "minus").font(metrics.font(size: 12)) }
                .buttonStyle(AletheIconButtonStyle(side: 22))
                .accessibilityLabel(Text("layoutDesigner.web.decrease"))
                .accessibilityIdentifier("layoutDesigner.\(id).decrease")
            Text(verbatim: String(value)).font(metrics.monoFont(size: 12)).foregroundStyle(theme[.fg])
                .frame(minWidth: metrics.size(14))
            Button { set(min(Self.maxTracks, value + 1)) } label: { Image(systemName: "plus").font(metrics.font(size: 12)) }
                .buttonStyle(AletheIconButtonStyle(side: 22))
                .accessibilityLabel(Text("layoutDesigner.web.increase"))
                .accessibilityIdentifier("layoutDesigner.\(id).increase")
        }
        .padding(.leading, metrics.size(10)).padding(.trailing, metrics.size(6)).padding(.vertical, metrics.size(4))
        .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityIdentifier("layoutDesigner.\(id)")
    }

    private var toolbar: some View {
        HStack(spacing: metrics.space(.xl)) {
            Text(verbatim: title)
                .font(metrics.font(.headline))
                .foregroundStyle(theme[.textPrimary])
            Spacer()
            Stepper(value: Binding(get: { draft.cols }, set: { setTracks(cols: $0, rows: draft.rows) }),
                    in: 1...Self.maxTracks) {
                Text(String(format: String(localized: "layoutDesigner.columns"), draft.cols))
                    .monospacedDigit()
            }
            .accessibilityIdentifier("layoutDesigner.columns")
            Stepper(value: Binding(get: { draft.rows }, set: { setTracks(cols: draft.cols, rows: $0) }),
                    in: 1...Self.maxTracks) {
                Text(String(format: String(localized: "layoutDesigner.rows"), draft.rows))
                    .monospacedDigit()
            }
            .accessibilityIdentifier("layoutDesigner.rows")
            Button("layoutDesigner.autoArrange") { apply(.auto(ids, cols: draft.cols)) }
            Button("pane.fillFreeSpace") {
                if let selected { draft = draft.fillingFreeSpace(ids, selected) }
            }
            .disabled(!canFill)
            .accessibilityIdentifier("layoutDesigner.fill")
        }
        .font(metrics.font(.body))
        .padding(metrics.space(.l))
    }

    private var canFill: Bool {
        guard let selected else { return false }
        return draft.fillingFreeSpace(ids, selected) != draft
    }

    // MARK: - Library

    private var library: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.space(.s)) {
                heading("layoutDesigner.presets", symbol: "square.grid.2x2")
                ForEach(CustomGridPreset.allCases, id: \.self) { preset in
                    let layout = preset.layout(ids)
                    libraryButton(Text(preset.title), meta: "\(layout.cols)×\(layout.rows)",
                                  id: "layoutDesigner.preset.\(preset.rawValue)") { apply(layout) }
                }
                heading("layoutDesigner.recent", symbol: "clock")
                    .padding(.top, metrics.space(.m))
                if history.isEmpty {
                    Text("layoutDesigner.noRecent")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textTertiary])
                }
                ForEach(history) { entry in
                    libraryButton(Text(entry.savedAt, format: .dateTime.day().month().hour().minute()),
                                  meta: "\(entry.layout.cols)×\(entry.layout.rows)", id: "layoutDesigner.recent") {
                        apply(entry.layout)
                    }
                }
            }
            .padding(.horizontal, metrics.isWebInterface ? metrics.size(10) : metrics.space(.l))
            .padding(.vertical, metrics.isWebInterface ? metrics.size(14) : metrics.space(.l))
        }
        .frame(width: metrics.size(metrics.isWebInterface ? 196 : 200))
        .background(theme[.bgSunken])
    }

    private func heading(_ title: LocalizedStringKey, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(metrics.font(.footnote).weight(.semibold))
            .foregroundStyle(theme[.textSecondary])
    }

    private func libraryButton(_ title: Text, meta: String, id: String,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                title.lineLimit(1)
                Spacer(minLength: metrics.space(.s))
                Text(verbatim: meta).monospacedDigit().foregroundStyle(theme[.textTertiary])
            }
            .font(metrics.font(.footnote))
            .padding(.horizontal, metrics.space(.m))
            .padding(.vertical, metrics.space(.s))
            .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme[.textPrimary])
        .accessibilityIdentifier(id)
    }

    // MARK: - Canvas

    private var canvas: some View {
        GeometryReader { proxy in
            let gap = metrics.space(.s)
            let rect = CGRect(origin: .zero, size: proxy.size)
            let geometry = PaneGridGeometry(count: max(2, ids.count), in: rect, weights: GridWeights(), gap: gap,
                                            handle: gap, mode: .grid, grid: draft, ids: ids)
            ZStack(alignment: .topLeading) {
                ForEach(allSlots(in: rect, gap: gap), id: \.id) { slot in
                    RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.borderSubtle], style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                        .frame(width: slot.frame.width, height: slot.frame.height)
                        .offset(x: slot.frame.minX, y: slot.frame.minY)
                }
                ForEach(Array(ids.enumerated()), id: \.element) { index, id in
                    if geometry.paneFrames.indices.contains(index) {
                        box(id: id, frame: geometry.paneFrames[index], rect: rect, gap: gap)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("layoutDesigner.canvas")
    }

    private struct SlotFrame {
        let col: Int, row: Int, frame: CGRect
        var id: String { "\(col):\(row)" }
    }

    /// Every slot of the draft, drawn under the boxes (and used to find a drop target).
    private func allSlots(in rect: CGRect, gap: CGFloat) -> [SlotFrame] {
        let columns = TrackMath.sizes(count: draft.cols, weights: [], total: rect.width, gap: gap)
        let rows = TrackMath.sizes(count: draft.rows, weights: [], total: rect.height, gap: gap)
        let x = TrackMath.offsets(columns, gap: gap), y = TrackMath.offsets(rows, gap: gap)
        return (0..<draft.rows).flatMap { row in
            (0..<draft.cols).map { col in
                SlotFrame(col: col + 1, row: row + 1, frame: CGRect(x: x[col], y: y[row], width: columns[col], height: rows[row]))
            }
        }
    }

    private func box(id: String, frame: CGRect, rect: CGRect, gap: CGFloat) -> some View {
        let pane = project?.panes.first { $0.id.rawValue == id }
        let isSelected = selected == id
        let offset = dragging?.id == id ? dragging?.offset ?? .zero : .zero
        return ZStack {
            RoundedRectangle(cornerRadius: metrics.radius(.md))
                .fill(theme[isSelected ? .surfaceCardSelected : .panel])
            RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[isSelected ? .accent : .border], lineWidth: isSelected ? 2 : 1)
            VStack(spacing: metrics.space(.xs)) {
                Circle()
                    .fill(theme[pane?.activeTab.map { AgentTokens.accent(for: $0.agent) } ?? .fgFaint])
                    .frame(width: metrics.size(8), height: metrics.size(8))
                Text(verbatim: childTitle(id))
                    .font(metrics.font(.footnote).weight(.medium))
                    .foregroundStyle(theme[.textPrimary])
                    .lineLimit(1)
            }
            .padding(metrics.space(.s))
            if isSelected { edgeControls(id) }
        }
        .frame(width: frame.width, height: frame.height)
        .offset(x: frame.minX + offset.width, y: frame.minY + offset.height)
        .zIndex(dragging?.id == id ? 1 : 0)
        .onTapGesture { selected = id }
        .gesture(
            DragGesture(minimumDistance: 6)
                .onChanged { value in
                    selected = id
                    dragging = (id, value.translation)
                }
                .onEnded { value in
                    dragging = nil
                    drop(id, at: CGPoint(x: frame.midX + value.translation.width, y: frame.midY + value.translation.height),
                         in: rect, gap: gap)
                }
        )
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
        .accessibilityLabel(Text(verbatim: childTitle(id)))
        .accessibilityIdentifier("layoutDesigner.box.\(childTitle(id))")
    }

    /// Grow (+) and shrink (−) buttons on each edge of the selected box, shown only when they apply.
    private func edgeControls(_ id: String) -> some View {
        let cell = draft.cells[id] ?? GridCell(col: 1, row: 1)
        return ZStack {
            ForEach(CustomGrid.Edge.allCases, id: \.self) { edge in
                let horizontal = edge == .left || edge == .right
                let span = horizontal ? cell.colSpan : cell.rowSpan
                HStack(spacing: metrics.space(.xxs)) {
                    if span > 1 {
                        edgeButton("minus", edge: edge, label: "layoutDesigner.shrink") {
                            draft = draft.expanding(ids, id, edge, by: -1)
                        }
                    }
                    if draft.freeSpan(ids, id, edge) > 0 {
                        edgeButton("plus", edge: edge, label: "layoutDesigner.grow") {
                            draft = draft.expanding(ids, id, edge, by: 1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge.alignment)
                .padding(metrics.space(.xs))
            }
        }
    }

    private func edgeButton(_ symbol: String, edge: CustomGrid.Edge, label: LocalizedStringKey,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(metrics.font(.caption).weight(.bold))
                .frame(width: metrics.size(18), height: metrics.size(18))
                .background(theme[.accent], in: Circle())
                .foregroundStyle(theme[.accentOn])
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier("layoutDesigner.\(symbol == "plus" ? "grow" : "shrink").\(edge.rawValue)")
    }

    // MARK: - Actions

    private static func title(_ pane: Pane) -> String {
        if let tab = pane.activeTab { return tab.title ?? AgentLabels.name(for: tab.agent) }
        return pane.content.filePath.map { URL(filePath: $0).lastPathComponent } ?? pane.content.kind.rawValue
    }

    private func childTitle(_ id: String) -> String {
        if let pane = project?.visiblePanes.first(where: { $0.id.rawValue == id }) { return Self.title(pane) }
        return children.first { $0.id.rawValue == id }?.name ?? id
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        draft = normalized(currentLayout ?? .auto(ids))
    }

    /// Explicit track sizes keep the steppers' add/remove predictable (upstream `normalizeDraft`).
    private func normalized(_ layout: CustomGrid) -> CustomGrid {
        var next = layout.reconciled(ids)
        next.colSizes = next.colSizes ?? Array(repeating: 1, count: next.cols)
        next.rowSizes = next.rowSizes ?? Array(repeating: 1, count: next.rows)
        return next
    }

    private func apply(_ layout: CustomGrid) {
        draft = normalized(layout)
        selected = nil
    }

    private func setTracks(cols: Int, rows: Int) {
        draft = normalized(draft.resized(cols: min(Self.maxTracks, cols), rows: min(Self.maxTracks, rows), ids))
    }

    private func drop(_ id: String, at point: CGPoint, in rect: CGRect, gap: CGFloat) {
        guard let slot = allSlots(in: rect, gap: gap).first(where: { $0.frame.insetBy(dx: -gap / 2, dy: -gap / 2).contains(point) })
        else { return }
        draft = draft.moving(ids, id, toCol: slot.col, row: slot.row)
    }

    private func save() {
        let clean = draft.reconciled(ids)
        var recent = history
        if recent.first?.layout != clean { recent.insert(CustomGridHistoryEntry(layout: clean), at: 0) }
        recent = Array(recent.prefix(WorkspaceDocument.maxGridLayoutHistory))
        switch scope {
        case .project(let id):
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.layout")) {
                $0.setGridLayout(clean, for: id, recordHistory: true)
            }
        case .group(let id):
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.layout")) {
                $0.updateGroup(id) { $0.layoutMode = .grid; $0.gridLayout = clean; $0.gridLayoutHistory = recent }
            }
        case .workspace:
            environment.preferences?.update { $0.workspaceGridLayout = clean; $0.workspaceGridLayoutHistory = recent }
        }
        dismiss()
    }
}

extension CustomGrid.Edge {
    var alignment: Alignment {
        switch self {
        case .left: .leading
        case .right: .trailing
        case .top: .top
        case .bottom: .bottom
        }
    }
}

extension CustomGridPreset {
    var title: LocalizedStringKey {
        switch self {
        case .balanced: "layoutDesigner.preset.balanced"
        case .columns: "layoutDesigner.preset.columns"
        case .rows: "layoutDesigner.preset.rows"
        case .focusLeft: "layoutDesigner.preset.focusLeft"
        case .focusTop: "layoutDesigner.preset.focusTop"
        }
    }
}
