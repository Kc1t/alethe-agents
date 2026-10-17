import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// The workspace pane area (ADR-3): open projects side by side as containers, each laying out its
/// panes. AppKit owns the terminal surfaces, so SwiftUI identity changes never recreate them.
@MainActor
final class PaneHostView: NSView {
    private var containers: [ProjectID: ContainerView] = [:]
    /// Containers shown, left to right (just the fullscreen one when set).
    private var order: [ProjectID] = []
    private var collapsed: Set<ProjectID> = []
    private var dividers: [DividerView] = []
    /// Weights of every open container, in `openProjectIDs` order.
    private var weights: [Double] = []
    private var openIDs: [ProjectID] = []
    private var context: PaneHostContext?
    private lazy var animator = FrameAnimator(host: self)
    private var animateNextLayout = false
    private var liveSizes: [CGFloat]?
    private var resizeBase: [CGFloat] = []
    private var resizeDelta: CGFloat = 0
    private var focusedPane: PaneID?
    private var mouseMonitor: Any?
    private var keyMonitor: Any?
    /// Flat workspace: the one container's panes and the project each belongs to.
    private var flatOwners: [PaneID: Project] = [:]
    /// Focus mode (upstream `FocusOverlay`): the pane floating over a blurred backdrop.
    private var focusModePane: PaneID?
    private var backdrop: FocusBackdropView?

    /// Id of the single container of a flat workspace.
    static let flatID = ProjectID(rawValue: "alethe.flat")

    private struct ContainerDrag {
        let project: ProjectID
        let base: CGRect
        var target: Int
    }
    private var containerDrag: ContainerDrag?

    override var isFlipped: Bool { true }

    func update(document: WorkspaceDocument, focusModePane: PaneID?, context: PaneHostContext) {
        self.context = context
        let state = document.workspace
        openIDs = state.openProjectIDs.filter { document.project($0) != nil }
        if liveSizes == nil { weights = state.containerWeights.count == openIDs.count ? state.containerWeights : [] }
        layer?.backgroundColor = context.theme.nsColor(.bg).cgColor
        FrameAnimator.reducesMotion = context.metrics.reducesMotion

        // Flat (upstream `workspaceFlat`): every open project's shown panes in one Auto area, unless
        // a project is shown alone.
        let flat = state.flat && state.fullscreenProjectID.map { !openIDs.contains($0) } ?? true && !openIDs.isEmpty
        var projects: [ProjectID: Project] = [:]
        flatOwners = [:]
        if flat {
            let open = openIDs.compactMap(document.project)
            for project in open { for pane in project.visiblePanes { flatOwners[pane.id] = project } }
            projects[Self.flatID] = Project(id: Self.flatID, name: "", folder: "", panes: open.flatMap(\.visiblePanes))
        } else {
            for id in openIDs { projects[id] = document.project(id) }
        }
        let ids = flat ? [Self.flatID] : state.fullscreenProjectID.flatMap { openIDs.contains($0) ? [$0] : nil } ?? openIDs
        let collapsedNow = flat ? [] : Set(state.collapsedProjectIDs).intersection(ids)
        if ids != order || collapsedNow != collapsed { animateNextLayout = !order.isEmpty }
        for (id, view) in containers where !ids.contains(id) {
            view.removeFromSuperview()
            containers.removeValue(forKey: id)
        }
        order = ids
        collapsed = collapsedNow
        for id in ids {
            guard let project = projects[id] else { continue }
            let view = containers[id] ?? {
                let view = ContainerView(projectID: id)
                addSubview(view)
                containers[id] = view
                return view
            }()
            view.configure(project: project, isSelected: state.selectedProjectID == id,
                           focusedPane: state.focusedPaneID,
                           weights: flat ? state.gridWeights[WorkspaceState.flatWeightsKey] ?? GridWeights()
                               : project.layout == .grid
                               ? GridWeights(columns: project.effectiveGrid.colSizes ?? [], rows: project.effectiveGrid.rowSizes ?? [])
                               : state.gridWeights[project.weightsKey] ?? GridWeights(),
                           isCollapsed: collapsed.contains(id),
                           isFullscreen: state.fullscreenProjectID == id,
                           isolatedPane: state.fullscreenProjectID == id ? state.isolatedPaneID : nil,
                           owners: flat ? flatOwners : [:], showsHeader: !flat,
                           context: context) { [weak self] translation in
                self?.containerDragged(id, translation: translation)
            }
        }
        self.focusModePane = containers.values.contains { $0.paneViews.contains { $0.paneID == focusModePane } }
            ? focusModePane : nil
        if state.focusedPaneID != focusedPane {
            focusedPane = state.focusedPaneID
            let pane = containers.values.lazy.flatMap(\.paneViews).first { $0.paneID == state.focusedPaneID }
            DispatchQueue.main.async { pane?.focusTerminal() }
        }
        needsLayout = true
    }

    private var gap: CGFloat { context.map { $0.metrics.isWebInterface ? $0.metrics.size(10) : $0.metrics.space(.s) } ?? 6 }
    private var minimumContainer: CGFloat { context?.metrics.size(260) ?? 260 }
    private var collapsedWidth: CGFloat { context.map { $0.metrics.size($0.metrics.isWebInterface ? 36 : 40) } ?? 40 }
    private var area: CGRect { context?.metrics.isWebInterface == true ? bounds : bounds.insetBy(dx: gap, dy: gap) }

    /// Shown containers that are not collapsed: the ones that share the width and have dividers.
    private var expanded: [ProjectID] { order.filter { !collapsed.contains($0) } }

    /// Weights of the expanded containers, from the weights of all open ones.
    private var expandedWeights: [Double] {
        guard weights.count == openIDs.count else { return [] }
        return expanded.compactMap { id in openIDs.firstIndex(of: id).map { weights[$0] } }
    }

    /// Width of each expanded container.
    private func expandedSizes() -> [CGFloat] {
        if let liveSizes { return liveSizes }
        let fixed = CGFloat(order.count - expanded.count) * (collapsedWidth + gap)
        return TrackMath.sizes(count: expanded.count, weights: expandedWeights, total: max(0, area.width - fixed), gap: gap)
    }

    /// Frame of every shown container, collapsed ones at their fixed width.
    private func frames() -> [ProjectID: CGRect] {
        let sizes = expandedSizes()
        var frames: [ProjectID: CGRect] = [:]
        var x = area.minX
        var next = 0
        for id in order {
            let width: CGFloat
            if collapsed.contains(id) {
                width = collapsedWidth
            } else {
                width = next < sizes.count ? sizes[next] : 0
                next += 1
            }
            frames[id] = CGRect(x: x, y: area.minY, width: width, height: area.height)
            x += width + gap
        }
        return frames
    }

    override func layout() {
        super.layout()
        let frames = frames()
        let animated = animateNextLayout
        animateNextLayout = false
        for (id, frame) in frames {
            guard let view = containers[id], containerDrag?.project != id else { continue }
            animator.set(view, frame: frame.integral, animated: animated)
        }
        layoutDividers(frames)
        layoutFocusMode(frames)
    }

    // MARK: - Focus mode

    /// Raises the focused pane's container above a blurred backdrop and floats the pane inside the
    /// whole area (upstream `FocusOverlay`: 24 × 32 pt margins). Click the backdrop or press Esc to
    /// leave.
    private func layoutFocusMode(_ frames: [ProjectID: CGRect]) {
        guard let pane = focusModePane,
              let (id, container) = containers.first(where: { $0.value.paneViews.contains { $0.paneID == pane } }) else {
            containers.values.forEach { $0.setFocus(nil, frame: .zero) }
            if let backdrop {
                NSAnimationContext.runAnimationGroup({ $0.duration = context?.metrics.reducesMotion == true ? 0 : 0.15; backdrop.animator().alphaValue = 0 },
                                                     completionHandler: { backdrop.removeFromSuperview() })
                self.backdrop = nil
            }
            return
        }
        let backdrop = self.backdrop ?? {
            let view = FocusBackdropView()
            view.onClick = { [weak self] in self?.context?.setFocusMode(nil) }
            view.alphaValue = 0
            self.backdrop = view
            return view
        }()
        backdrop.tint = context?.theme.nsColor(.bg).withAlphaComponent(0.55)
        backdrop.frame = bounds
        if backdrop.superview == nil {
            addSubview(backdrop, positioned: .above, relativeTo: nil)
            NSAnimationContext.runAnimationGroup { $0.duration = context?.metrics.reducesMotion == true ? 0 : 0.22; backdrop.animator().alphaValue = 1 }
        }
        addSubview(container, positioned: .above, relativeTo: backdrop)
        let origin = frames[id]?.origin ?? container.frame.origin
        let inset = CGSize(width: context?.metrics.size(32) ?? 32, height: context?.metrics.size(24) ?? 24)
        let target = bounds.insetBy(dx: inset.width, dy: inset.height).offsetBy(dx: -origin.x, dy: -origin.y)
        for (other, view) in containers where other != id { view.setFocus(nil, frame: .zero) }
        container.setFocus(pane, frame: target)
    }

    // MARK: - Container resizing

    /// One divider between each pair of neighboring expanded containers.
    private func layoutDividers(_ frames: [ProjectID: CGRect]) {
        let pairs = zip(expanded, expanded.dropFirst()).map { ($0, $1) }
        while dividers.count > pairs.count { dividers.removeLast().removeFromSuperview() }
        while dividers.count < pairs.count {
            let index = dividers.count
            let view = DividerView(axis: .vertical)
            view.setAccessibilityIdentifier("container.divider.\(index)")
            view.onDrag = { [weak self] delta in self?.resize(divider: index, delta: delta) }
            view.onEnd = { [weak self] in self?.endResize(divider: index) }
            addSubview(view)
            dividers.append(view)
        }
        let handle = max(gap, context?.metrics.size(8) ?? 8)
        for (index, view) in dividers.enumerated() {
            guard let left = frames[pairs[index].0] else { continue }
            // Right after the left container (a collapsed strip may follow before the next one).
            let center = left.maxX + gap / 2
            view.frame = CGRect(x: center - handle / 2, y: area.minY, width: handle, height: area.height)
        }
    }

    private func resize(divider: Int, delta: CGFloat) {
        if liveSizes == nil { resizeBase = expandedSizes() }
        liveSizes = TrackMath.drag(resizeBase, divider: divider, delta: delta, minimum: minimumContainer,
                                   rubberBand: { Motion.rubberBand(overshoot: $0, dimension: $1) })
        resizeDelta = delta
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    private func endResize(divider: Int) {
        let settled = TrackMath.drag(resizeBase, divider: divider, delta: resizeDelta, minimum: minimumContainer)
        let settledWeights = TrackMath.weights(settled)
        // Collapsed containers keep their stored weight for when they expand again.
        var all = weights.count == openIDs.count ? weights : Array(repeating: 1.0 / Double(max(1, openIDs.count)), count: openIDs.count)
        let expandedTotal = expanded.compactMap { openIDs.firstIndex(of: $0).map { all[$0] } }.reduce(0, +)
        for (index, id) in expanded.enumerated() {
            if let position = openIDs.firstIndex(of: id) { all[position] = settledWeights[index] * expandedTotal }
        }
        weights = all
        liveSizes = nil
        resizeDelta = 0
        animateNextLayout = true
        needsLayout = true
        context?.setContainerWeights(weights)
    }

    // MARK: - Container reorder

    /// Dragging a container's header moves it among the open ones; neighbors make room on release.
    private func containerDragged(_ project: ProjectID, translation: CGSize?) {
        guard let view = containers[project], context?.environment.workspace?.document.workspace.fullscreenProjectID == nil else {
            return
        }
        guard let translation else { return endContainerDrag() }
        if containerDrag == nil {
            let base = animator.target(of: view)
            containerDrag = ContainerDrag(project: project, base: base, target: order.firstIndex(of: project) ?? 0)
            addSubview(view, positioned: .above, relativeTo: nil)
            view.alphaValue = 0.94
        }
        guard var drag = containerDrag else { return }
        view.frame = drag.base.offsetBy(dx: translation.width, dy: 0)
        let frames = frames()
        let centers = order.filter { $0 != project }.compactMap { frames[$0]?.midX }
        drag.target = centers.filter { $0 < view.frame.midX }.count
        containerDrag = drag
    }

    private func endContainerDrag() {
        guard let drag = containerDrag, let view = containers[drag.project] else { return }
        containerDrag = nil
        view.alphaValue = 1
        animateNextLayout = true
        // No fullscreen while dragging, so `order` is every open container and `target` (how many
        // others sit left of the dragged center) is its index once removed and reinserted.
        if drag.target != order.firstIndex(of: drag.project) {
            context?.moveContainer(drag.project, to: drag.target)
        }
        needsLayout = true
    }

    // MARK: - Focus

    /// A click anywhere in a pane focuses it; the click itself still reaches the terminal.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
        mouseMonitor = nil
        guard window != nil else { return }
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            self?.focusPane(at: event)
            return event
        }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        // Esc leaves focus mode before the terminal sees it (upstream captures it too).
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window, event.keyCode == 53, self.focusModePane != nil else { return event }
            self.context?.setFocusMode(nil)
            return nil
        }
    }

    private func focusPane(at event: NSEvent) {
        guard event.window === window, let context else { return }
        let point = convert(event.locationInWindow, from: nil)
        for (id, container) in containers where container.frame.contains(point) || focusModePane != nil {
            let local = container.convert(point, from: self)
            if let pane = container.paneViews.first(where: { !$0.isHidden && $0.frame.contains(local) }) {
                context.focus(pane.paneID, in: flatOwners[pane.paneID]?.id ?? id)
            }
        }
    }
}

/// SwiftUI bridge. Everything the host renders is passed in as values so SwiftUI calls
/// `updateNSView` whenever any of it changes.
struct PaneHost: NSViewRepresentable {
    let document: WorkspaceDocument
    let terminalStates: [TabID: TerminalRegistry.State]
    let terminalGenerations: [TabID: Int]
    let focusModePane: PaneID?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    func makeNSView(context: Context) -> PaneHostView {
        let view = PaneHostView()
        view.wantsLayer = true
        view.setAccessibilityIdentifier("workspace.panes")
        return view
    }

    func updateNSView(_ view: PaneHostView, context: Context) {
        view.update(document: document, focusModePane: focusModePane, context: PaneHostContext(
            environment: environment, theme: theme, metrics: metrics,
            undoManager: { [weak view] in view?.window?.undoManager }))
    }
}

/// Focus mode backdrop: blurs and dims the workspace behind the focused pane; a click leaves.
final class FocusBackdropView: NSVisualEffectView {
    var onClick: () -> Void = {}
    var tint: NSColor? {
        didSet { dim.layer?.backgroundColor = tint?.cgColor }
    }
    private let dim = NSView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        material = .fullScreenUI
        blendingMode = .withinWindow
        state = .active
        dim.wantsLayer = true
        dim.autoresizingMask = [.width, .height]
        addSubview(dim)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(String(localized: "focusMode.exit"))
        setAccessibilityIdentifier("focusMode.backdrop")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layout() {
        super.layout()
        dim.frame = bounds
    }

    override func mouseDown(with event: NSEvent) { onClick() }

    override func accessibilityPerformPress() -> Bool {
        onClick()
        return true
    }
}
