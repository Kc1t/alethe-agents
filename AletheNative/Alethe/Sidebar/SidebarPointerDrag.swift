import AletheDesign
import AletheFoundation
import AletheModel
import AppKit
import Observation
import SwiftUI

/// Pointer-driven sidebar drag: the equivalent of dnd-kit's `PointerSensor` in the web app.
///
/// The system drag session is not used for sidebar items. SwiftUI reports no drag end or cancel, delivers
/// `performDrop` unreliably for custom types and draws its own preview. Instead a row's `DragGesture` calls
/// `begin`; from then on the pointer is read from `NSEvent`, targets come from the live row views
/// (`SidebarDropGeometry`) ranked by `SidebarWebDropRules`, the preview is a floating window (dnd-kit's
/// `DragOverlay`) and the drop is applied on mouse up. Escape cancels.
@MainActor @Observable
final class SidebarWebDragState {
    /// What dropping here would do; drives the insertion line, the box and the row fills.
    private(set) var plan: SidebarDropPlan?
    /// Payload string of the item being dragged; nil when idle. Rows dim themselves while it matches.
    private(set) var source: String?
    private(set) var sourceGroup: GroupID?

    var isDragging: Bool { source != nil }

    @ObservationIgnored private weak var geometry: SidebarDropGeometry?
    @ObservationIgnored private var document: (() -> WorkspaceDocument)?
    @ObservationIgnored private var perform: ((SidebarDropPlan.Action) -> Void)?
    @ObservationIgnored private var payload: SidebarDragPayload?
    @ObservationIgnored private var unit: CGFloat = 1
    @ObservationIgnored private var grab: CGPoint = .zero
    @ObservationIgnored private var ghost: SidebarDragGhost?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var escapeMonitor: Any?
    @ObservationIgnored private var releasedTicks = 0
    #if DEBUG
    /// Self-test seam: pretends the left button stays down.
    @ObservationIgnored var debugHoldsButton = false
    var debugGhostVisible: Bool { ghost?.isVisible ?? false }
    #endif

    func configure(geometry: SidebarDropGeometry, document: @escaping () -> WorkspaceDocument,
                   perform: @escaping (SidebarDropPlan.Action) -> Void) {
        self.geometry = geometry
        self.document = document
        self.perform = perform
    }

    // MARK: - Drag lifecycle (rows)

    /// Picks `item` up. `translation` is the gesture's offset when it activated, which recovers where the
    /// mouse went down inside `row`.
    func begin(_ item: SidebarDragPayload, raw: String, label: String, translation: CGSize, row: NSView?,
               theme: Theme, metrics: Metrics) {
        guard !isDragging, geometry?.surface != nil else { return }
        payload = item
        source = raw
        if case .group(let id) = item { sourceGroup = id }
        unit = metrics.scale
        let ghost = SidebarDragGhost(label: label, theme: theme, metrics: metrics, parent: row?.window)
        self.ghost = ghost
        grab = grabOffset(row: row, translation: translation, ghostSize: ghost.size)
        releasedTicks = 0
        installEscapeMonitor()
        ticker = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.tick()
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
        tick()
    }

    /// Mouse up: drops where the pointer is.
    func finish() {
        guard isDragging else { return }
        if let point = geometry?.pointer() { resolve(at: point) }
        let action = plan?.action
        log("DROP")
        teardown()
        if let action { perform?(action) }
    }

    func cancel() {
        guard isDragging else { return }
        log("CANCEL")
        teardown()
    }

    // MARK: - Finder folders (system drag, hover feedback only)

    func hover(_ plan: SidebarDropPlan?) {
        guard !isDragging else { return }
        publish(plan)
    }

    func clearHover() {
        guard !isDragging else { return }
        publish(nil)
    }

    // MARK: - Tracking

    private func tick() {
        guard isDragging else { return }
        // Mouse up normally arrives through the gesture; this also covers a row torn down mid-drag.
        if !buttonDown {
            releasedTicks += 1
            if releasedTicks >= 3 { finish(); return }
        } else {
            releasedTicks = 0
        }
        ghost?.move(pointer: geometry?.screenPointer() ?? NSEvent.mouseLocation, grab: grab)
        guard let geometry, let point = geometry.pointer() else {
            publish(nil)
            return
        }
        geometry.autoscroll(pointer: point, unit: unit)
        resolve(at: point)
    }

    private func resolve(at point: CGPoint) {
        guard let payload, let geometry, let size = geometry.surface?.bounds.size, let document else { return }
        publish(SidebarWebDropRules.plan(.item(payload), regions: geometry.regions(), at: point, width: size.width,
                                         in: document()))
    }

    private func publish(_ new: SidebarDropPlan?) {
        guard plan != new else { return }
        let moved = plan?.action != new?.action
        plan = new
        if moved, isDragging { log("target") }
    }

    private var buttonDown: Bool {
        #if DEBUG
        if debugHoldsButton { return true }
        #endif
        return NSEvent.pressedMouseButtons & 1 != 0
    }

    private func grabOffset(row: NSView?, translation: CGSize, ghostSize: CGSize) -> CGPoint {
        let pointer = geometry?.screenPointer() ?? NSEvent.mouseLocation
        let start = CGPoint(x: pointer.x - translation.width, y: pointer.y + translation.height)
        var offset = CGPoint(x: 14 * unit, y: ghostSize.height / 2)
        if let row, let window = row.window {
            let rect = window.convertToScreen(row.convert(row.bounds, to: nil))
            offset = CGPoint(x: start.x - rect.minX, y: rect.maxY - start.y)
        }
        let margin = 6 * unit
        return CGPoint(x: min(max(offset.x, margin), max(margin, ghostSize.width - margin)),
                       y: min(max(offset.y, margin), max(margin, ghostSize.height - margin)))
    }

    private func teardown() {
        ticker?.cancel()
        ticker = nil
        if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
        escapeMonitor = nil
        ghost?.close()
        ghost = nil
        payload = nil
        source = nil
        sourceGroup = nil
        plan = nil
    }

    private func installEscapeMonitor() {
        guard escapeMonitor == nil else { return }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            let handled: Bool = MainActor.assumeIsolated {
                guard let self, self.isDragging else { return false }
                self.cancel()
                return true
            }
            return handled ? nil : event
        }
    }

    // MARK: - Diagnostics

    /// `defaults write com.kc1t.alethe.mac debug.sidebarDrop -bool true` logs every target change and the drop
    /// to `~/Library/Application Support/com.kc1t.alethe.mac/logs/sidebar-drop.log`.
    private func log(_ event: String) {
        guard UserDefaults.standard.bool(forKey: "debug.sidebarDrop") else { return }
        func r(_ rect: CGRect) -> String { "(\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height)))" }
        let point = geometry?.pointer() ?? .zero
        let size = geometry?.surface?.bounds.size ?? .zero
        var lines = ["\(Date()) \(event) pointer=(\(Int(point.x)),\(Int(point.y))) surface=\(Int(size.width))x\(Int(size.height)) source=\(source ?? "nil")"]
        lines.append("  plan=\(plan.map { "\($0.action) mark=\($0.mark) fill=\($0.fill.map { "\($0)" } ?? "nil")" } ?? "none")")
        for region in geometry?.regions() ?? [] { lines.append("  \(region.target) hit=\(r(region.hit)) visual=\(r(region.visual))") }
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/\(AppIdentity.bundleIdentifier)/logs/sidebar-drop.log")
        let data = Data((lines.joined(separator: "\n") + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}

// MARK: - Drag overlay

/// dnd-kit's `DragOverlay`: a borderless window that follows the pointer so it is never clipped by the
/// sidebar and never takes events.
@MainActor
final class SidebarDragGhost {
    /// The pill alone, without the transparent margin that leaves room for its shadow.
    let size: CGSize
    var isVisible: Bool { panel.isVisible }
    private let panel: NSPanel
    private let inset: CGFloat
    private weak var parent: NSWindow?

    init(label: String, theme: Theme, metrics: Metrics, parent: NSWindow?) {
        inset = metrics.size(16)
        let root = SidebarDragPill(label: label)
            .environment(\.theme, theme)
            .environment(\.metrics, metrics)
            .padding(inset)
        let host = NSHostingView(rootView: root)
        host.layoutSubtreeIfNeeded()
        var fitting = host.fittingSize
        // An off-screen hosting view can report no size; fall back to the pill's minimum (web `.dragOverlay`).
        if fitting.width < 2 * inset + 1 || fitting.height < 2 * inset + 1 {
            fitting = CGSize(width: metrics.size(150) + 2 * inset, height: metrics.size(34) + 2 * inset)
        }
        size = CGSize(width: fitting.width - 2 * inset, height: fitting.height - 2 * inset)
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: fitting), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.contentView = host
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        self.parent = parent
        parent?.addChildWindow(panel, ordered: .above)
        panel.orderFront(nil)
    }

    /// `pointer` is in screen coordinates; `grab` is where the pointer sits inside the pill, from its top-left.
    func move(pointer: CGPoint, grab: CGPoint) {
        panel.setFrameTopLeftPoint(CGPoint(x: pointer.x - grab.x - inset, y: pointer.y + grab.y + inset))
    }

    func close() {
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }
}

/// Web `.dragOverlay`: folder glyph and name in an elevated, bordered pill.
struct SidebarDragPill: View {
    let label: String
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        let shadow = theme.shadow(.md)
        HStack(spacing: metrics.size(8)) {
            Image(systemName: "folder").font(metrics.font(size: 14)).fixedSize()
            Text(verbatim: label).lineLimit(1).truncationMode(.tail)
        }
        .font(metrics.font(size: 12, weight: .semibold))
        .foregroundStyle(theme[.fg])
        .padding(.vertical, metrics.size(7)).padding(.horizontal, metrics.size(10))
        .frame(minWidth: metrics.size(150), maxWidth: metrics.size(260), minHeight: metrics.size(34), alignment: .leading)
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
        .shadow(color: shadow.color.color, radius: metrics.size(shadow.blur / 2),
                x: metrics.size(shadow.x), y: metrics.size(shadow.y))
    }
}
