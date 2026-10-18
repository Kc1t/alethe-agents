import AletheDesign
import AletheModel
import AletheOrchestrator
import AppKit
import SwiftUI

/// The board canvas (upstream `board`/`world`): the P6-12 layout with its connectors and dot grid
/// drawn by one SwiftUI `Canvas`, the node cards placed over it at their zoomed size (only those
/// near the viewport), pan by dragging the background, pinch and button zoom, fit and focus.
/// Screen point = (canvas point × scale + offset) × UI scale.
struct BoardCanvasView: View {
    let board: OrchestratorBoardModel
    let group: PlannerGroup
    let plannerGone: Bool
    let project: ProjectID
    let onRevealPlanner: () -> Void
    let onOpenMedia: (MediaItem) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var dragged = CGSize.zero
    @State private var magnified: CGFloat = 1

    /// Nodes this far (canvas units) outside the viewport are still built, so panning never shows
    /// a card popping in at the edge.
    private static let cullMargin: Double = 160

    var body: some View {
        GeometryReader { proxy in
            let ui = Double(metrics.scale)
            let view = board.view
            let units = BoardUnits(metrics: metrics, zoom: view.scale)
            ZStack(alignment: .topLeading) {
                BoardEdgesCanvas(graph: board.graph, view: view, ui: ui, selected: board.selectedWorker,
                                 reducesMotion: metrics.reducesMotion)
                    .contentShape(Rectangle())
                    .gesture(pan(ui: ui))
                    .accessibilityHidden(true)
                if group.runs.isEmpty {
                    Text("orchestrator.emptyPlanner")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textTertiary])
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .allowsHitTesting(false)
                }
                BoardNodesLayout {
                    nodes(units: units, view: view, ui: ui, viewport: proxy.size)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipShape(Rectangle())
            .simultaneousGesture(magnify(ui: ui))
            .background(BoardWheelZoom { delta, point in
                // OrchestratorPane/index.tsx: Cmd/Ctrl + wheel zooms by exp(-deltaY / 400) around the pointer.
                board.zoom(by: exp(delta / 400), at: BoardPoint(x: point.x / ui, y: point.y / ui), animated: false)
            })
            .overlay(alignment: .bottomLeading) { hint }
            .overlay(alignment: .bottomTrailing) { zoomControls }
            .onChange(of: proxy.size, initial: true) { _, size in
                board.setViewport(BoardSize(width: size.width / ui, height: size.height / ui))
            }
            .onChange(of: metrics.scale) { _, scale in
                board.setViewport(BoardSize(width: proxy.size.width / scale, height: proxy.size.height / scale))
            }
        }
        .background(theme[.bgSunken])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.board")
    }

    // MARK: Nodes

    @ViewBuilder
    private func nodes(units: BoardUnits, view: ViewTransform, ui: Double, viewport: CGSize) -> some View {
        let graph = board.graph
        let visible = visibleRect(view: view, ui: ui, viewport: viewport)
        let selected = board.selectedWorker
        if let planner = graph.planner {
            BoardPlannerNode(group: group, isGone: plannerGone, units: units, onReveal: onRevealPlanner)
                .boardNode(planner, view: view, ui: ui, units: units, board: board)
        }
        ForEach(Array(zip(graph.roots, group.runs)), id: \.0.id) { node, run in
            if node.box.intersects(visible) {
                BoardRunNode(run: run, units: units, onClick: board.clearSelection)
                    .boardNode(node, view: view, ui: ui, units: units, board: board)
            }
        }
        ForEach(graph.workers) { node in
            if let job = board.jobsByID[node.id], node.id == selected || node.box.intersects(visible) {
                BoardWorkerNode(job: job, selected: node.id == selected, elapsed: board.elapsed(job), units: units,
                                project: project, board: board, onSelect: { board.toggleWorker(node.id) },
                                onOpenMedia: onOpenMedia)
                    .boardNode(node, view: view, ui: ui, units: units, board: board)
            }
        }
        ForEach(graph.media) { node in
            let jobID = String(node.id.dropLast(":media".count))
            if let item = board.media[jobID], node.box.intersects(visible) {
                BoardMediaNode(jobID: jobID, item: item, units: units, onOpen: { onOpenMedia(item) })
                    .boardNode(node, view: view, ui: ui, units: units, board: board)
            }
        }
    }

    /// The viewport in canvas units, grown by the cull margin.
    private func visibleRect(view: ViewTransform, ui: Double, viewport: CGSize) -> BoardBox {
        let scale = max(view.scale, BoardLayout.minScale)
        let margin = Self.cullMargin
        return BoardBox(
            x: -view.x / scale - margin,
            y: -view.y / scale - margin,
            width: viewport.width / ui / scale + margin * 2,
            height: viewport.height / ui / scale + margin * 2
        )
    }

    // MARK: Gestures

    private func pan(ui: Double) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                let dx = value.translation.width - dragged.width
                let dy = value.translation.height - dragged.height
                dragged = value.translation
                board.pan(by: dx / ui, dy / ui)
            }
            .onEnded { _ in dragged = .zero }
    }

    private func magnify(ui: Double) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let factor = value.magnification / magnified
                magnified = value.magnification
                let anchor = BoardPoint(x: value.startLocation.x / ui, y: value.startLocation.y / ui)
                board.zoom(by: factor, at: anchor, animated: false)
            }
            .onEnded { _ in magnified = 1 }
    }

    // MARK: Overlays

    private var hint: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            Text("orchestrator.canvasHint")
            Text("orchestrator.forestHint")
        }
        .font(metrics.font(.caption))
        .foregroundStyle(theme[.textTertiary])
        .padding(metrics.space(.m))
        .allowsHitTesting(false)
    }

    private var zoomControls: some View {
        let percent = Int((board.view.scale * 100).rounded())
        return HStack(spacing: metrics.space(.xxs)) {
            zoomButton(symbol: "minus", label: "orchestrator.zoomOut", id: "orchestrator.zoomOut") {
                board.zoom(by: 1 / OrchestratorBoardModel.zoomStep)
            }
            Button(action: board.fitFromButton) {
                Text("orchestrator.zoomFit")
                    .font(metrics.font(.caption).weight(.medium))
                    .padding(.horizontal, metrics.space(.s))
                    .frame(height: metrics.size(22))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(theme[.textSecondary])
            .help(Text("orchestrator.zoomFitTitle"))
            .accessibilityIdentifier("orchestrator.zoomFit")
            Text(verbatim: String(format: String(localized: "orchestrator.percent"), percent))
                .font(metrics.font(.caption))
                .monospacedDigit()
                .foregroundStyle(theme[.textTertiary])
                .frame(minWidth: metrics.size(36))
                .id(percent)
                .accessibilityIdentifier("orchestrator.zoomValue")
            zoomButton(symbol: "plus", label: "orchestrator.zoomIn", id: "orchestrator.zoomIn") {
                board.zoom(by: OrchestratorBoardModel.zoomStep)
            }
            zoomButton(symbol: "scope", label: "orchestrator.focusSelected", id: "orchestrator.focus",
                       action: board.focusSelected)
                .disabled(board.selectedWorker == nil)
        }
        .padding(.horizontal, metrics.space(.xs))
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay { RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: 1) }
        .padding(metrics.space(.m))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orchestrator.zoomControls")
    }

    private func zoomButton(symbol: String, label: LocalizedStringKey, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(metrics.font(.caption).weight(.semibold))
                .frame(width: metrics.size(22), height: metrics.size(22))
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(theme[.textSecondary])
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }
}

private extension BoardBox {
    func intersects(_ other: BoardBox) -> Bool {
        x < other.x + other.width && other.x < x + width && y < other.y + other.height && other.y < y + height
    }
}

// MARK: - Placement

/// Where a node goes, in screen points relative to the canvas, and how wide it is.
private struct BoardNodeFrame: LayoutValueKey {
    static let defaultValue = CGRect.zero
}

/// Places each node at its screen origin with its zoomed width; the height is the card's own.
/// Layout-based placement (never `offset`) keeps every control's hit area where it is drawn.
private struct BoardNodesLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            let frame = subview[BoardNodeFrame.self]
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: nil)
            )
        }
    }
}

private extension View {
    /// Places a card for `node` and reports its rendered height back to the layout.
    func boardNode(_ node: GraphNode, view: ViewTransform, ui: Double, units: BoardUnits,
                   board: OrchestratorBoardModel) -> some View {
        let unit = Double(units.unit)
        let frame = CGRect(
            x: (node.x * view.scale + view.x) * ui,
            y: (node.y * view.scale + view.y) * ui,
            width: node.width * unit,
            height: 0
        )
        return self
            .frame(width: frame.width)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                board.reportHeight(node.id, screenHeight: Double(height), unit: unit)
            }
            .layoutValue(key: BoardNodeFrame.self, value: frame)
    }
}

// MARK: - Connectors

/// The dot grid and the connectors (upstream `.board` background and `svg.edges`), redrawn in one
/// pass. A running connector's dashes flow unless motion is reduced.
private struct BoardEdgesCanvas: View {
    let graph: BoardGraph
    let view: ViewTransform
    let ui: Double
    let selected: String?
    let reducesMotion: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let flowing = !reducesMotion && graph.edges.contains { $0.lane == .running }
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !flowing)) { timeline in
            let phase = flowing
                ? timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.6) / 0.6
                : 0
            Canvas { context, size in
                drawDots(in: &context, size: size)
                for edge in graph.edges { draw(edge, in: &context, phase: phase) }
                for edge in graph.edges {
                    if let note = edge.note { draw(note, in: &context) }
                }
            }
        }
    }

    private func screen(_ point: BoardPoint) -> CGPoint {
        CGPoint(x: (point.x * view.scale + view.x) * ui, y: (point.y * view.scale + view.y) * ui)
    }

    private var unit: Double { view.scale * ui }

    private func drawDots(in context: inout GraphicsContext, size: CGSize) {
        var spacing = BoardLayout.dotSpacing * unit
        // Below this the texture turns into noise and costs more than it shows.
        while spacing < 10 { spacing *= 2 }
        let radius = max(0.6, unit * 0.8)
        let startX = (view.x * ui).truncatingRemainder(dividingBy: spacing) - spacing
        let startY = (view.y * ui).truncatingRemainder(dividingBy: spacing) - spacing
        var dots = Path()
        var y = startY
        while y < size.height + spacing {
            var x = startX
            while x < size.width + spacing {
                dots.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
                x += spacing
            }
            y += spacing
        }
        context.fill(dots, with: .color(theme[.borderStrong].opacity(0.4)))
    }

    private func draw(_ edge: GraphEdge, in context: inout GraphicsContext, phase: Double) {
        var path = Path()
        for step in edge.steps {
            switch step {
            case .move(let point):
                path.move(to: screen(point))
            case .vertical(let y):
                let current = path.currentPoint ?? .zero
                path.addLine(to: CGPoint(x: current.x, y: screen(BoardPoint(x: 0, y: y)).y))
            case .horizontal(let x):
                let current = path.currentPoint ?? .zero
                path.addLine(to: CGPoint(x: screen(BoardPoint(x: x, y: 0)).x, y: current.y))
            case .quad(let control, let to):
                path.addQuadCurve(to: screen(to), control: screen(control))
            }
        }
        let isSelected = edge.to == selected
        var width = 1.0
        var dash: [Double] = []
        var cap = CGLineCap.butt
        var opacity = 0.7
        let token: ThemeToken
        switch edge.lane {
        case .finished:
            token = .fgFaint
        case .queued:
            token = .statusWaiting
            dash = [3, 4]
        case .interrupted:
            token = .statusWaiting
            dash = [1, 4]
            cap = .round
        case .running:
            token = .statusWorking
            width = 1.6
            dash = [7, 5]
        case .failed:
            token = .statusOffline
            width = 1.4
        case .blocked:
            token = .statusWaiting
            width = 2
            opacity = 1
        }
        if isSelected {
            width = 2
            opacity = 1
        }
        let scaledDash = dash.map { $0 * unit }
        let style = StrokeStyle(
            lineWidth: width * unit,
            lineCap: cap,
            dash: scaledDash.map { CGFloat($0) },
            dashPhase: edge.lane == .running ? -phase * 12 * unit : 0
        )
        context.stroke(path, with: .color(theme[isSelected ? .accent : token].opacity(opacity)), style: style)
    }

    private func draw(_ note: GraphEdgeNote, in context: inout GraphicsContext) {
        let ignored = note.verdict == "ignored"
        let text = Text(verbatim: BoardText.routing(verdict: note.verdict, agent: note.agent, window: note.window, used: note.used))
            .font(metrics.font(.caption, zoom: view.scale))
            .foregroundStyle(theme[ignored ? .statusWaiting : .fgFaint])
        let resolved = context.resolve(text)
        let size = resolved.measure(in: CGSize(width: 10_000, height: 10_000))
        let center = screen(BoardPoint(x: note.x, y: note.y))
        let padding = CGSize(width: 6 * unit, height: 1 * unit)
        let box = CGRect(
            x: center.x - size.width / 2 - padding.width,
            y: center.y - size.height / 2 - padding.height,
            width: size.width + padding.width * 2,
            height: size.height + padding.height * 2
        )
        let capsule = Path(roundedRect: box, cornerRadius: box.height / 2)
        context.fill(capsule, with: .color(theme[.bg]))
        context.stroke(capsule, with: .color(theme[ignored ? .statusWaiting : .border]), lineWidth: 1)
        context.draw(resolved, at: center, anchor: .center)
    }
}

/// Cmd/Ctrl + scroll wheel over the board zooms it (upstream `onWheel` with `ctrlKey || metaKey`).
/// A passive local monitor: the view never takes hits, and events outside its bounds pass through.
private struct BoardWheelZoom: NSViewRepresentable {
    /// Scroll delta (positive = content moves down, i.e. zoom in) and the pointer in view points, top-left origin.
    let onZoom: (Double, CGPoint) -> Void

    func makeNSView(context: Context) -> MonitorView {
        let view = MonitorView()
        view.onZoom = onZoom
        return view
    }

    func updateNSView(_ view: MonitorView, context: Context) { view.onZoom = onZoom }

    static func dismantleNSView(_ view: MonitorView, coordinator: ()) { view.removeMonitor() }

    final class MonitorView: NSView {
        var onZoom: ((Double, CGPoint) -> Void)?
        private var monitor: Any?

        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeMonitor()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self, event.window === window,
                      event.modifierFlags.intersection([.command, .control]) != [] else { return event }
                let point = convert(event.locationInWindow, from: nil)
                guard bounds.contains(point) else { return event }
                onZoom?(Double(event.scrollingDeltaY), point)
                return nil
            }
        }

        func removeMonitor() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}
