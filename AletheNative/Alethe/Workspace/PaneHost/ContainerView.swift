import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// One open project: its header and its panes in the Auto layout, with live split resizing and
/// drag-to-reorder.
@MainActor
final class ContainerView: NSView {
    let projectID: ProjectID
    private let accentLine = CALayer()
    private let header = NSHostingView(rootView: AnyView(EmptyView()))
    private var emptyState: NSHostingView<AnyView>?
    private var panes: [PaneID: PaneView] = [:]
    private var order: [PaneID] = []
    private var stacks: [PaneGroup] = []
    private var stackFrames: [String: NSView] = [:]
    private var stackHeaders: [String: NSHostingView<AnyView>] = [:]
    private var dividers: [PaneGridGeometry.Divider: DividerView] = [:]
    private var weights = GridWeights()
    private var context: PaneHostContext?
    private lazy var animator = FrameAnimator(host: self)
    private var animateNextLayout = false

    /// Track sizes while a divider is being dragged (not yet committed).
    private var liveColumns: [CGFloat]?
    private var liveRows: [CGFloat]?
    private var resizeBase: [CGFloat] = []
    private var resizeDelta: CGFloat = 0

    private struct Reorder {
        let pane: PaneID
        let base: CGRect
        var target: PaneID?
        /// A free slot of a custom grid under the dragged pane (1-based column, row).
        var slot: (col: Int, row: Int)?
    }
    /// Dashed placeholders for a custom grid's free slots.
    private var slotViews: [NSView] = []
    private var reorder: Reorder?
    private var lastProject: Project?
    private var lastFocused: PaneID?
    private var lastSelected = false
    private var isCollapsed = false
    private var isFullscreen = false
    /// The one pane laid out (isolated); nil: all of them.
    private var isolatedPane: PaneID?
    private var onHeaderDrag: (CGSize?) -> Void = { _ in }
    /// The narrow strip shown instead of header and panes while collapsed.
    private var strip: NSHostingView<AnyView>?
    /// Flat workspace: no header, and each pane configured with its own project.
    private var owners: [PaneID: Project] = [:]
    private var showsHeader = true
    /// Focus mode: the one pane shown, at this frame (container coordinates), over the backdrop.
    private var focus: (pane: PaneID, frame: CGRect)?

    init(projectID: ProjectID) {
        self.projectID = projectID
        super.init(frame: .zero)
        addSubview(header)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }

    var paneViews: [PaneView] {
        context?.metrics.isWebInterface == true ? (lastProject?.visiblePanes.compactMap { panes[$0.id] } ?? [])
            : order.compactMap { panes[$0] }
    }

    func configure(project: Project, isSelected: Bool, focusedPane: PaneID?, weights: GridWeights,
                   isCollapsed: Bool, isFullscreen: Bool, isolatedPane: PaneID?,
                   owners: [PaneID: Project] = [:], showsHeader: Bool = true,
                   context: PaneHostContext, onHeaderDrag: @escaping (CGSize?) -> Void) {
        self.context = context
        let grouped = showsHeader && project.visiblePanes.count > 1 && isolatedPane == nil
        if context.metrics.isWebInterface {
            wantsLayer = true
            layer?.cornerRadius = 0
            layer?.borderWidth = grouped ? context.metrics.size(1) : 0
            layer?.borderColor = context.theme.nsColor(.border).cgColor
            layer?.backgroundColor = context.theme.nsColor(.bg).cgColor
            if accentLine.superlayer == nil { layer?.addSublayer(accentLine) }
            accentLine.backgroundColor = context.theme.nsColor(project.color.token).cgColor
            accentLine.opacity = grouped ? 0.65 : 0
            accentLine.zPosition = 10
        } else {
            layer?.borderWidth = 0
            layer?.backgroundColor = nil
            accentLine.removeFromSuperlayer()
        }
        self.owners = owners
        self.showsHeader = context.metrics.isWebInterface ? grouped : showsHeader
        if let lastProject, lastProject.layout != project.layout { animateNextLayout = true }
        lastProject = project
        lastFocused = focusedPane
        lastSelected = isSelected
        self.isCollapsed = isCollapsed
        self.isFullscreen = isFullscreen
        self.isolatedPane = project.visiblePanes.contains { $0.id == isolatedPane } ? isolatedPane : nil
        self.onHeaderDrag = onHeaderDrag
        if liveColumns == nil, liveRows == nil { self.weights = weights }
        setAccessibilityIdentifier("container.\(project.name)")
        header.rootView = context.hosted(ContainerHeader(
            project: project, isSelected: isSelected, isFullscreen: isFullscreen,
            onLayout: { context.setLayoutMode($0, for: project.id) },
            onDesignLayout: { context.designLayout(for: project.id) },
            onGrid: { action in
                switch action {
                case .activate(let grid): context.activateGrid(grid, in: project.id)
                case .new: context.newGrid(in: project.id)
                case .rename(let grid): context.renameGrid(grid, in: project.id)
                case .delete(let grid): context.deleteGrid(grid, in: project.id)
                }
            },
            onCollapse: { context.setCollapsed(project.id, true) },
            onFullscreen: { context.setFullscreen(isFullscreen ? nil : project.id) },
            onClose: { context.closeContainer(project.id) },
            onDrag: onHeaderDrag))
        configureStrip(project: project, context: context)

        let ids = project.visiblePanes.map(\.id)
        for (id, view) in panes where !ids.contains(id) {
            view.removeFromSuperview()
            panes.removeValue(forKey: id)
        }
        stacks = context.metrics.isWebInterface ? (project.paneGroups ?? []).compactMap { group in
            var next = group
            next.paneIds = group.paneIds.filter { ids.contains($0) }
            return next.paneIds.count >= 2 ? next : nil
        } : []
        let nested = Set(stacks.flatMap { $0.paneIds.dropFirst() })
        let nextOrder = ids.filter { !nested.contains($0) }
        if nextOrder != order { animateNextLayout = !order.isEmpty }
        order = nextOrder
        for (id, view) in stackHeaders where !stacks.contains(where: { $0.id == id }) {
            view.removeFromSuperview()
            stackHeaders.removeValue(forKey: id)
            stackFrames.removeValue(forKey: id)?.removeFromSuperview()
        }
        for stack in stacks {
            let view = stackHeaders[stack.id] ?? NSHostingView(rootView: AnyView(EmptyView()))
            let border = stackFrames[stack.id] ?? NSView()
            border.wantsLayer = true
            border.layer?.borderWidth = context.metrics.size(1)
            border.layer?.borderColor = context.theme.nsColor(.borderStrong).cgColor
            border.layer?.cornerRadius = context.metrics.style == .clean ? 0 : context.metrics.size(8)
            border.layer?.backgroundColor = context.theme.nsColor(.panel).blended(withFraction: 0.08,
                                                                                 of: context.theme.nsColor(.accent))?.cgColor
            if border.superview == nil { addSubview(border, positioned: .below, relativeTo: nil) }
            stackFrames[stack.id] = border
            view.rootView = context.hosted(PaneStackHeader(orchestration: stack.kind == "orchestration") {
                let owner = stack.paneIds.first.flatMap { owners[$0]?.id } ?? project.id
                context.workspace?.update { $0.updateProject(owner) { $0.ungroupPanes(stack.id) } }
            })
            if view.superview == nil { addSubview(view) }
            stackHeaders[stack.id] = view
        }
        for pane in project.visiblePanes {
            let view = panes[pane.id] ?? {
                let view = PaneView(paneID: pane.id)
                addSubview(view, positioned: .below, relativeTo: header)
                panes[pane.id] = view
                return view
            }()
            view.configure(pane: pane, project: owners[pane.id] ?? project, focused: pane.id == focusedPane,
                           dropTarget: reorder?.target == pane.id, context: context) { [weak self] translation in
                self?.reorderDrag(pane.id, translation: translation)
            }
        }

        if project.visiblePanes.isEmpty {
            let root = context.hosted(ProjectEmptyState(project: project))
            if let emptyState {
                emptyState.rootView = root
            } else {
                let view = NSHostingView(rootView: root)
                addSubview(view)
                emptyState = view
            }
        } else {
            emptyState?.removeFromSuperview()
            emptyState = nil
        }
        needsLayout = true
    }

    private var headerHeight: CGFloat { showsHeader ? context?.metrics.size(context?.metrics.isWebInterface == true ? 32 : 30) ?? 30 : 0 }
    private var gap: CGFloat {
        guard let context else { return 6 }
        guard context.metrics.isWebInterface else { return context.metrics.space(.s) }
        // Custom grids are flush in both styles; split panels are flush only in Clean.
        return context.metrics.size(lastProject?.layout == .grid || context.metrics.style == .clean ? 0 : 10)
    }
    private var minimumPane: CGSize {
        CGSize(width: context?.metrics.size(160) ?? 160, height: context?.metrics.size(100) ?? 100)
    }

    private var paneArea: CGRect {
        let edge = context?.metrics.isWebInterface == true && showsHeader ? context?.metrics.size(1) ?? 1 : 0
        let top = showsHeader ? headerHeight + (context?.metrics.isWebInterface == true ? edge : gap) : 0
        return CGRect(x: edge, y: top, width: max(0, bounds.width - edge * 2), height: max(0, bounds.height - top - edge))
    }

    /// Enters or leaves focus mode for one of this container's panes.
    func setFocus(_ pane: PaneID?, frame: CGRect) {
        let next = pane.flatMap { panes[$0] != nil ? ($0, frame) : nil }
        guard next?.0 != focus?.pane || next?.1 != focus?.frame else { return }
        animateNextLayout = true
        focus = next
        needsLayout = true
    }

    private func geometry() -> PaneGridGeometry {
        var current = weights
        if let liveColumns { current.columns = TrackMath.weights(liveColumns) }
        if let liveRows { current.rows = TrackMath.weights(liveRows) }
        let mode = lastProject?.layout ?? .auto
        return PaneGridGeometry(count: order.count, in: paneArea, weights: current, gap: gap,
                                handle: max(gap, context?.metrics.size(8) ?? 8), mode: mode,
                                grid: mode == .grid ? lastProject?.effectiveGrid : nil, ids: order.map(\.rawValue),
                                handlesInsideLeadingCell: context?.metrics.isWebInterface == true)
    }

    override func layout() {
        super.layout()
        accentLine.frame = CGRect(x: 0, y: 0, width: bounds.width, height: context?.metrics.size(1) ?? 1)
        strip?.frame = bounds
        header.isHidden = isCollapsed || !showsHeader || focus != nil
        emptyState?.isHidden = isCollapsed
        header.frame = CGRect(x: 0, y: 0, width: bounds.width, height: headerHeight)
        emptyState?.frame = paneArea
        let animated = animateNextLayout
        animateNextLayout = false
        stackHeaders.values.forEach { $0.isHidden = isCollapsed || focus != nil || isolatedPane != nil }
        stackFrames.values.forEach { $0.isHidden = isCollapsed || focus != nil || isolatedPane != nil }
        if isCollapsed {
            panes.values.forEach { $0.isHidden = true }
            dividers.values.forEach { $0.isHidden = true }
            layoutSlots([])
            return
        }
        if let focus {
            for (id, view) in panes {
                view.isHidden = id != focus.pane
                if id == focus.pane, view.superview === self {
                    animator.set(view, frame: focus.frame.integral, animated: animated)
                }
            }
            dividers.values.forEach { $0.isHidden = true }
            layoutSlots([])
            return
        }
        if let isolatedPane {
            for (id, view) in panes {
                view.isHidden = id != isolatedPane
                if id == isolatedPane { animator.set(view, frame: paneArea.integral, animated: animated) }
            }
            dividers.values.forEach { $0.isHidden = true }
            layoutSlots([])
            return
        }
        panes.values.forEach { $0.isHidden = false }
        dividers.values.forEach { $0.isHidden = false }
        let geometry = geometry()
        for (index, id) in order.enumerated() {
            guard let view = panes[id], geometry.paneFrames.indices.contains(index) else { continue }
            if reorder?.pane == id { continue }
            let frame = geometry.paneFrames[index]
            if let stack = stacks.first(where: { $0.paneIds.first == id }), let context {
                let m = context.metrics
                stackFrames[stack.id]?.frame = frame
                let head = min(frame.height, m.size(28))
                stackHeaders[stack.id]?.frame = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: head)
                let body = CGRect(x: frame.minX + m.size(6), y: frame.minY + head + m.size(6),
                                  width: max(0, frame.width - m.size(12)),
                                  height: max(0, frame.height - head - m.size(12)))
                let vertical = stack.kind == "orchestration"
                let columns = vertical ? 1 : 2
                let rows = vertical ? stack.paneIds.count : (stack.paneIds.count + 1) / 2
                let gap = m.size(6)
                let width = max(0, (body.width - CGFloat(columns - 1) * gap) / CGFloat(columns))
                let height = max(0, (body.height - CGFloat(rows - 1) * gap) / CGFloat(rows))
                for (position, member) in stack.paneIds.enumerated() {
                    guard reorder?.pane != member, let child = panes[member], child.superview === self else { continue }
                    let target = CGRect(x: body.minX + CGFloat(position % columns) * (width + gap),
                                        y: body.minY + CGFloat(position / columns) * (height + gap),
                                        width: width, height: height)
                    animator.set(child, frame: target.integral, animated: animated)
                }
            } else {
                animator.set(view, frame: context?.metrics.isWebInterface == true ? frame : frame.integral, animated: animated)
            }
        }
        layoutDividers(geometry)
        layoutSlots(geometry.freeSlots)
    }

    /// Free slots of a custom grid, drawn as dashed outlines (upstream `EmptyGridSlot`); the one under
    /// a dragged pane is highlighted.
    private func layoutSlots(_ slots: [PaneGridGeometry.Slot]) {
        while slotViews.count > slots.count { slotViews.removeLast().removeFromSuperview() }
        while slotViews.count < slots.count {
            let view = NSView()
            view.wantsLayer = true
            let border = CAShapeLayer()
            border.fillColor = nil
            border.lineDashPattern = [4, 4]
            view.layer?.addSublayer(border)
            addSubview(view, positioned: .below, relativeTo: nil)
            slotViews.append(view)
        }
        for (view, slot) in zip(slotViews, slots) {
            let inset = context?.metrics.isWebInterface == true ? context?.metrics.size(4) ?? 4 : 0
            view.frame = slot.frame.insetBy(dx: inset, dy: inset).integral
            let active = reorder?.slot.map { $0.col == slot.col && $0.row == slot.row } == true
            let radius = context.map { $0.metrics.isWebInterface ? $0.metrics.size(4) : $0.metrics.radius(.md) } ?? 8
            view.layer?.cornerRadius = radius
            view.layer?.backgroundColor = active ? context?.theme.nsColor(.accentFaint).cgColor : nil
            if let border = view.layer?.sublayers?.first as? CAShapeLayer {
                border.frame = view.bounds
                border.path = CGPath(roundedRect: view.bounds.insetBy(dx: 0.5, dy: 0.5), cornerWidth: radius,
                                     cornerHeight: radius, transform: nil)
                border.strokeColor = context?.theme.nsColor(active ? .accent : .borderSubtle).cgColor
                border.lineWidth = context?.metrics.isWebInterface == true ? context?.metrics.size(1) ?? 1 : (active ? 2 : 1)
            }
            view.setAccessibilityElement(true)
            view.setAccessibilityRole(.group)
            view.setAccessibilityIdentifier("grid.slot.\(slot.col).\(slot.row)")
        }
    }
    private func configureStrip(project: Project, context: PaneHostContext) {
        guard isCollapsed else {
            strip?.removeFromSuperview()
            strip = nil
            return
        }
        let root = context.hosted(CollapsedContainerStrip(project: project, isSelected: lastSelected,
                                                          onExpand: { context.setCollapsed(project.id, false) },
                                                          onDrag: onHeaderDrag))
        if let strip {
            strip.rootView = root
        } else {
            let view = NSHostingView(rootView: root)
            addSubview(view, positioned: .above, relativeTo: nil)
            strip = view
        }
    }

    // MARK: - Split resizing

    private func layoutDividers(_ geometry: PaneGridGeometry) {
        for (kind, view) in dividers where geometry.dividers[kind] == nil {
            view.removeFromSuperview()
            dividers.removeValue(forKey: kind)
        }
        for (kind, rect) in geometry.dividers {
            let view = dividers[kind] ?? makeDivider(kind)
            view.configure(context: context, gridHandle: lastProject?.layout == .grid)
            view.frame = rect
        }
    }

    private func makeDivider(_ kind: PaneGridGeometry.Divider) -> DividerView {
        let view: DividerView
        switch kind {
        case .column, .gridColumn: view = DividerView(axis: .vertical)
        case .row, .gridRow: view = DividerView(axis: .horizontal)
        }
        switch kind {
        case .column(let row): view.setAccessibilityIdentifier("pane.divider.column.\(row)")
        case .row(let index): view.setAccessibilityIdentifier("pane.divider.row.\(index)")
        case .gridColumn(let boundary, let segment): view.setAccessibilityIdentifier("pane.divider.gridColumn.\(boundary).\(segment)")
        case .gridRow(let boundary, let segment): view.setAccessibilityIdentifier("pane.divider.gridRow.\(boundary).\(segment)")
        }
        view.onDrag = { [weak self] delta in self?.resize(kind, delta: delta) }
        view.onEnd = { [weak self] in self?.endResize(kind) }
        view.onDoubleClick = { [weak self, weak view] point in
            guard let self, let view, self.lastProject?.layout == .grid,
                  self.context?.metrics.isWebInterface == true else { return }
            let point = self.convert(point, from: view)
            let geometry = self.geometry()
            if let index = geometry.paneFrames.firstIndex(where: { $0.contains(point) }), self.order.indices.contains(index) {
                self.context?.fillFreeSpace(self.order[index])
            }
        }
        addSubview(view)
        dividers[kind] = view
        return view
    }

    private func draggedSizes(_ kind: PaneGridGeometry.Divider, delta: CGFloat) -> [CGFloat] {
        let column: Bool
        let index: Int
        switch kind.track {
        case .column(let boundary): column = true; index = boundary
        case .row(let boundary): column = false; index = boundary
        }
        if context?.metrics.isWebInterface == true, lastProject?.layout != .grid,
           resizeBase.indices.contains(index + 1) {
            let total = column ? paneArea.width : paneArea.height
            let mode = lastProject?.layout ?? .auto
            let fractions: (CGFloat, CGFloat)
            if column && mode == .spotlight { fractions = (0.25, 0.15) }
            else if column && mode == .sidebar { fractions = (0.15, 0.40) }
            else if column && order.count == 2 { fractions = (0.15, 0.15) }
            else { fractions = (0.10, 0.10) }
            let pair = resizeBase[index] + resizeBase[index + 1]
            let leading = min(total * fractions.0, pair / 2)
            let trailing = min(total * fractions.1, pair / 2)
            var result = resizeBase
            result[index] = min(max(resizeBase[index] + delta, leading), pair - trailing)
            result[index + 1] = pair - result[index]
            return result
        }
        if context?.metrics.isWebInterface == true, let grid = lastProject?.effectiveGrid {
            let stored = column ? grid.colSizes : grid.rowSizes
            let count = column ? grid.cols : grid.rows
            let totalFractions = stored?.reduce(0, +) ?? Double(count)
            let extent = column ? paneArea.width : paneArea.height
            return TrackMath.drag(resizeBase, divider: index, delta: delta,
                                  minimum: extent * CGFloat(0.1 / max(0.1, totalFractions)))
        }
        return TrackMath.drag(resizeBase, divider: index, delta: delta,
                              minimum: column ? minimumPane.width : minimumPane.height,
                              rubberBand: { Motion.rubberBand(overshoot: $0, dimension: $1) })
    }

    private func resize(_ kind: PaneGridGeometry.Divider, delta: CGFloat) {
        let geometry = geometry()
        switch kind.track {
        case .column:
            if liveColumns == nil { resizeBase = geometry.columnSizes }
            liveColumns = draggedSizes(kind, delta: delta)
        case .row:
            if liveRows == nil { resizeBase = geometry.rowSizes }
            liveRows = draggedSizes(kind, delta: delta)
        }
        resizeDelta = delta
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    /// Settles a rubber-banded drag back to the minimum with a spring, then commits the weights.
    private func endResize(_ kind: PaneGridGeometry.Divider) {
        switch kind.track {
        case .column(let index):
            let settled = context?.metrics.isWebInterface == true ? draggedSizes(kind, delta: resizeDelta)
                : TrackMath.drag(resizeBase, divider: index, delta: resizeDelta, minimum: minimumPane.width)
            weights.columns = TrackMath.weights(settled)
        case .row(let index):
            let settled = context?.metrics.isWebInterface == true ? draggedSizes(kind, delta: resizeDelta)
                : TrackMath.drag(resizeBase, divider: index, delta: resizeDelta, minimum: minimumPane.height)
            weights.rows = TrackMath.weights(settled)
        }
        liveColumns = nil
        liveRows = nil
        resizeDelta = 0
        animateNextLayout = true
        needsLayout = true
        context?.setGridWeights(weights, for: projectID)
    }

    // MARK: - Reorder

    private func reorderDrag(_ pane: PaneID, translation: CGSize?) {
        guard let view = panes[pane] else { return }
        guard let translation else { return endReorder() }
        if reorder == nil {
            reorder = Reorder(pane: pane, base: animator.target(of: view))
            addSubview(view, positioned: .above, relativeTo: nil)
            lift(view, true)
        }
        guard var current = reorder else { return }
        view.frame = current.base.offsetBy(dx: translation.width, dy: translation.height)
        let center = CGPoint(x: view.frame.midX, y: view.frame.midY)
        let candidates = context?.metrics.isWebInterface == true ? (lastProject?.visiblePanes.map(\.id) ?? []) : order
        let target = candidates.first { $0 != pane && (panes[$0].map { animator.target(of: $0).contains(center) } ?? false) }
        let slot = target == nil ? geometry().freeSlots.first { $0.frame.contains(center) }.map { ($0.col, $0.row) } : nil
        if target != current.target || slot?.0 != current.slot?.col || slot?.1 != current.slot?.row {
            current.target = target
            current.slot = slot.map { (col: $0.0, row: $0.1) }
            reorder = current
            refreshPanes()
        }
    }

    private func endReorder() {
        guard let finished = reorder, let view = panes[finished.pane] else { return }
        reorder = nil
        lift(view, false)
        addSubview(view, positioned: .below, relativeTo: header)
        let grid = lastProject?.layout == .grid ? lastProject?.effectiveGrid : nil
        if let grid, let destination = finished.target.flatMap({ grid.cells[$0.rawValue] }).map({ ($0.col, $0.row) })
            ?? finished.slot.map({ ($0.col, $0.row) }) {
            animateNextLayout = true
            context?.moveGridCell(finished.pane, toCol: destination.0, row: destination.1)
        } else if let target = finished.target {
            animateNextLayout = true
            context?.swapPanes(finished.pane, target)
        } else {
            animator.set(view, frame: finished.base, animated: true)
        }
        refreshPanes()
    }

    private func refreshPanes() {
        guard let project = lastProject, let context else { return }
        configure(project: project, isSelected: lastSelected, focusedPane: lastFocused, weights: weights,
                  isCollapsed: isCollapsed, isFullscreen: isFullscreen, isolatedPane: isolatedPane,
                  owners: context.metrics.isWebInterface ? owners : [:],
                  showsHeader: context.metrics.isWebInterface ? showsHeader : true,
                  context: context, onHeaderDrag: onHeaderDrag)
    }

    /// A lifted pane casts the theme's large shadow (unclipped while it floats).
    private func lift(_ view: NSView, _ lifted: Bool) {
        guard let layer = view.layer else { return }
        let shadow = context?.theme.shadow(.lg)
        layer.masksToBounds = !lifted
        layer.shadowColor = shadow?.color.nsColor.cgColor
        layer.shadowOpacity = lifted && !(context?.metrics.isWebInterface == true && context?.metrics.style == .clean) ? 1 : 0
        layer.shadowRadius = lifted ? CGFloat(shadow?.blur ?? 0) / 2 : 0
        layer.shadowOffset = CGSize(width: shadow?.x ?? 0, height: -(shadow?.y ?? 0))
        view.alphaValue = lifted ? (context?.metrics.isWebInterface == true ? 0.55 : 0.94) : 1
    }
}

/// The pane area of a project that has no terminals yet.
private struct ProjectEmptyState: View {
    let project: Project
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if metrics.isWebInterface {
                GeometryReader { geometry in
                    VStack(spacing: metrics.size(geometry.size.width <= metrics.size(520) ? 16 : 24)) {
                        Image("AletheMark")
                            .resizable()
                            .renderingMode(.template)
                            .scaledToFit()
                            .foregroundStyle(theme[.fg])
                            .opacity(0.045)
                            .frame(width: metrics.size(geometry.size.width <= metrics.size(520) ? 104 : 190),
                                   height: min(metrics.size(geometry.size.width <= metrics.size(520) ? 104 : 190),
                                               max(0, geometry.size.height - metrics.size(110))))
                            .accessibilityHidden(true)
                        VStack(spacing: metrics.size(2)) {
                            emptyAction("terminal.new", shortcut: "⌘T", id: "terminal.new") {
                                environment.editorRequest = .newTerminal(project.id)
                            }
                            emptyAction("menu.file.addContent", shortcut: "⇧⌘A", id: "workspace.project.addContent") {
                                environment.editorRequest = .addContent(project.id)
                            }
                        }
                        .frame(maxWidth: metrics.size(280))
                    }
                    .frame(maxWidth: min(metrics.size(360), max(0, geometry.size.width - metrics.size(32))))
                    .padding(.horizontal, metrics.size(16))
                    .frame(width: geometry.size.width, height: geometry.size.height)
                }
            } else {
                VStack(spacing: metrics.space(.l)) {
                    Text("workspace.project.noTerminals")
                        .font(metrics.font(.body))
                        .foregroundStyle(theme[.textSecondary])
                    NewTerminalButton(project: project)
                        .fixedSize()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace.project.empty")
    }

    private func emptyAction(_ title: LocalizedStringKey, shortcut: String, id: String,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: metrics.size(18)) {
                Text(title).font(metrics.font(size: 12)).lineLimit(1)
                Spacer(minLength: 0)
                Text(verbatim: shortcut)
                    .font(metrics.monoFont(size: 10))
                    .padding(.horizontal, metrics.size(5))
                    .frame(minWidth: metrics.size(18), minHeight: metrics.size(18))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(3)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(3))
                        .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, metrics.size(4))
            .padding(.vertical, metrics.size(2))
            .frame(minHeight: metrics.size(26))
            .contentShape(Rectangle())
        }
        .buttonStyle(AletheWorkspaceActionStyle())
        .accessibilityIdentifier(id)
    }
}

extension PaneGridGeometry.Divider {
    enum Track { case column(Int), row(Int) }

    /// The track boundary a divider moves: Auto, Spotlight and Sidebar share one column boundary.
    var track: Track {
        switch self {
        case .column: .column(0)
        case .row(let index): .row(index)
        case .gridColumn(let boundary, _): .column(boundary)
        case .gridRow(let boundary, _): .row(boundary)
        }
    }
}
