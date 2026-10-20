import AletheDesign
import AletheModel
import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

/// Rows register their live AppKit view with the surface; the drag engine reads the frames when it needs them.
/// (SwiftUI named-space frames are not reliable inside List cells, so geometry comes from the views on demand.)
struct SidebarWebDrop: ViewModifier {
    let target: SidebarWebDropTarget
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag
    @Environment(\.sidebarDropGeometry) private var geometry
    @State private var token = UUID()

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            let top: CGFloat = if case .project = target { metrics.size(6) } else { 0 }
            content.background {
                ZStack {
                    RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .fill(theme[.panelHover].opacity(drag?.plan?.fill == target ? 1 : 0))
                        .padding(.top, top)
                    SidebarDropProbe(token: token, target: target, geometry: geometry, unit: metrics.size(1))
                }
            }
        } else { content }
    }
}

/// Live row geometry for the drag surface: every row registers its AppKit view and the frames are converted to
/// surface coordinates only when a drag asks for them, so scrolling and expanding can never leave them stale.
@MainActor final class SidebarDropGeometry {
    private struct Entry {
        let target: SidebarWebDropTarget
        let unit: CGFloat
        weak var view: NSView?
    }

    private var entries: [UUID: Entry] = [:]
    private weak var cachedScroll: NSScrollView?
    weak var surface: NSView?

    func register(_ token: UUID, target: SidebarWebDropTarget, unit: CGFloat, view: NSView) {
        // List cells are reused: one view must never keep a stale registration under another token.
        entries = entries.filter { $0.key == token ? false : $0.value.view != nil && $0.value.view !== view }
        entries[token] = Entry(target: target, unit: unit, view: view)
    }

    func unregister(_ token: UUID) { entries[token] = nil }

    private func local(_ view: NSView) -> CGRect? {
        guard let surface, surface.window != nil, view.window === surface.window, !view.isHiddenOrHasHiddenAncestor,
              view.bounds.width > 0, view.bounds.height > 0 else { return nil }
        var rect = surface.convert(view.bounds, from: view)
        if !surface.isFlipped { rect.origin.y = surface.bounds.height - rect.maxY }
        return rect
    }

    func rect(of token: UUID) -> CGRect? { entries[token]?.view.flatMap(local) }

    #if DEBUG
    /// Self-test seam: a scripted pointer, in surface coordinates, used instead of the mouse.
    var pointerOverride: CGPoint?
    #endif

    /// The mouse in screen coordinates.
    func screenPointer() -> CGPoint {
        #if DEBUG
        if let point = pointerOverride, let surface, let window = surface.window {
            let local = CGPoint(x: point.x, y: surface.isFlipped ? point.y : surface.bounds.height - point.y)
            return window.convertPoint(toScreen: surface.convert(local, to: nil))
        }
        #endif
        return NSEvent.mouseLocation
    }

    /// The mouse in surface coordinates (top-left origin), or nil while the surface is off screen.
    func pointer() -> CGPoint? {
        guard let surface, let window = surface.window else { return nil }
        var point = surface.convert(window.convertPoint(fromScreen: screenPointer()), from: nil)
        if !surface.isFlipped { point.y = surface.bounds.height - point.y }
        return point
    }

    /// Every registered row with its hit cell and the element the user sees inside it.
    func regions() -> [SidebarDropRegion] {
        var result: [SidebarDropRegion] = []
        for entry in entries.values {
            guard let view = entry.view, let hit = local(view) else { continue }
            let top: CGFloat
            let bottom: CGFloat
            switch entry.target {
            case .project: (top, bottom) = (6 * entry.unit, 0)
            case .groupHeader: (top, bottom) = (max(0, hit.height - 26 * entry.unit), 2 * entry.unit)
            default: (top, bottom) = (0, 0)
            }
            result.append(SidebarDropRegion(
                target: entry.target, hit: hit,
                visual: CGRect(x: hit.minX, y: hit.minY + top, width: hit.width, height: max(0, hit.height - top - bottom))))
        }
        return result
    }

    // MARK: Auto-scroll

    /// Scrolls the list while the pointer is inside its top or bottom 20% (dnd-kit's default threshold).
    func autoscroll(pointer: CGPoint, unit: CGFloat) {
        guard let surface, let scroll = scrollView() else { return }
        let size = surface.bounds.size
        guard size.height > 0, pointer.x > -20 * unit, pointer.x < size.width + 20 * unit else { return }
        let zone = min(size.height * 0.2, 80 * unit)
        let fromBottom = size.height - pointer.y
        let direction: CGFloat
        if pointer.y < zone { direction = -(1 - max(pointer.y, 0) / zone) }
        else if fromBottom < zone { direction = 1 - max(fromBottom, 0) / zone }
        else { return }
        guard let document = scroll.documentView else { return }
        let clip = scroll.contentView
        let insets = scroll.contentInsets
        let lowest = -insets.top
        let highest = max(lowest, document.bounds.height - clip.bounds.height + insets.bottom)
        let y = min(max(clip.bounds.origin.y + direction * 14 * unit, lowest), highest)
        guard y != clip.bounds.origin.y else { return }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        scroll.reflectScrolledClipView(clip)
    }

    /// The list's `NSScrollView`: the one that covers the surface.
    private func scrollView() -> NSScrollView? {
        if let cachedScroll, cachedScroll.window != nil { return cachedScroll }
        guard let surface else { return nil }
        let area = surface.bounds.width * surface.bounds.height
        var ancestor = surface.superview
        while let root = ancestor {
            var queue = [root]
            while !queue.isEmpty {
                let view = queue.removeFirst()
                if let scroll = view as? NSScrollView {
                    let overlap = surface.convert(scroll.bounds, from: scroll).intersection(surface.bounds)
                    if overlap.width * overlap.height > area * 0.5 {
                        cachedScroll = scroll
                        return scroll
                    }
                }
                queue.append(contentsOf: view.subviews)
            }
            ancestor = root.superview
        }
        return nil
    }
}

/// Zero-size-hit AppKit view that lets the drop surface read a row's real frame.
struct SidebarDropProbe: NSViewRepresentable {
    let token: UUID
    let target: SidebarWebDropTarget
    let geometry: SidebarDropGeometry?
    let unit: CGFloat

    final class View: NSView {
        var token: UUID?
        weak var geometry: SidebarDropGeometry?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> View { View() }

    func updateNSView(_ view: View, context: Context) {
        view.token = token
        view.geometry = geometry
        geometry?.register(token, target: target, unit: unit, view: view)
    }

    static func dismantleNSView(_ view: View, coordinator: ()) {
        if let token = view.token { MainActor.assumeIsolated { view.geometry?.unregister(token) } }
    }
}

/// Marks the drop surface's own view so row frames can be converted into its coordinates.
private struct SidebarDropSurfaceProbe: NSViewRepresentable {
    let geometry: SidebarDropGeometry

    final class View: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> View {
        let view = View()
        geometry.surface = view
        return view
    }

    func updateNSView(_ view: View, context: Context) { geometry.surface = view }
}

/// A group's body includes descendants, but excludes its own header and its top margin.
struct SidebarWebGroupRegion: ViewModifier {
    let group: GroupID
    @Environment(\.metrics) private var metrics
    @Environment(\.sidebarWebAncestors) private var ancestors

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content.environment(\.sidebarWebAncestors, ancestors + [group]) }
        else { content }
    }
}

extension EnvironmentValues {
    @Entry var sidebarWebDrag: SidebarWebDragState? = nil
    @Entry var sidebarWebAncestors: [GroupID] = []
    @Entry var sidebarDropGeometry: SidebarDropGeometry? = nil
}

/// The terminal and pane rows under a project count as part of that project's node when something is dropped.
struct SidebarWebTerminalBodyDrop: ViewModifier {
    let enabled: Bool
    let project: ProjectID?
    @Environment(\.sidebarDropGeometry) private var geometry
    @Environment(\.metrics) private var metrics
    @State private var token = UUID()

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface, enabled, let project {
            content.background {
                SidebarDropProbe(token: token, target: .terminals(project), geometry: geometry, unit: metrics.size(1))
            }
        } else { content }
    }
}

struct SidebarWebDropSurface: ViewModifier {
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var state = SidebarWebDragState()
    /// Live row frames, read lazily while dragging (never SwiftUI state, so scrolling does not re-render).
    @State private var store = SidebarDropGeometry()

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .environment(\.sidebarWebDrag, state)
                .environment(\.sidebarDropGeometry, store)
                .background(SidebarDropSurfaceProbe(geometry: store))
                .overlay(alignment: .topLeading) {
                    // Web `.dropBefore` / `.dropAfter`: a 2px accent line 2px outside the element, inset 5px.
                    if case .line(let rect, let edge, let indent)? = state.plan?.mark {
                        Capsule().fill(theme[.accent])
                            .frame(width: max(0, rect.width - indent - metrics.size(10)), height: metrics.size(2))
                            .allowsHitTesting(false)
                            .offset(x: rect.minX + indent + metrics.size(5),
                                    y: edge == .before ? rect.minY - metrics.size(2) : rect.maxY)
                    }
                }
                .overlay(alignment: .topLeading) {
                    // Web `.dropInside`: panel-hover fill (drawn by the row) and a 1px inset strong border.
                    if case .box(let rect)? = state.plan?.mark {
                        RoundedRectangle(cornerRadius: metrics.radius(.sm))
                            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1))
                            .frame(width: rect.width, height: rect.height)
                            .offset(x: rect.minX, y: rect.minY)
                            .allowsHitTesting(false)
                    }
                }
                .clipped()
                // Only Finder folders use the system drag session; sidebar items are dragged by `SidebarWebDragState`.
                .onDrop(of: [.fileURL], delegate: SidebarFileDropDelegate(
                    state: state, geometry: store, actions: actions, unit: metrics.size(1)))
                .onAppear {
                    let document = { actions.workspace.document }
                    let perform: (SidebarDropPlan.Action) -> Void = { actions.webDrop($0) }
                    state.configure(geometry: store, document: document, perform: perform)
                    #if DEBUG
                    if SidebarDragSelfTest.enabled {
                        Task {
                            await SidebarDragSelfTest.run(state: state, geometry: store, document: document,
                                                          restore: { state.configure(geometry: store, document: document, perform: perform) })
                        }
                    }
                    #endif
                }
                .task {
                    // SwiftUI does not guarantee dropExited on Escape or a release outside the window.
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(100))
                        if !state.isDragging, state.plan != nil, NSEvent.pressedMouseButtons == 0 { state.clearHover() }
                    }
                }
                .onDisappear { state.cancel() }
        } else { content }
    }
}

/// Finder folders dropped on the list: added as projects in the container under the pointer.
private struct SidebarFileDropDelegate: DropDelegate {
    let state: SidebarWebDragState
    let geometry: SidebarDropGeometry
    let actions: SidebarActions
    let unit: CGFloat

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.fileURL]) }

    @MainActor private func resolve(_ info: DropInfo) -> SidebarDropPlan? {
        guard let width = geometry.surface?.bounds.width else { return nil }
        return SidebarWebDropRules.plan(.files, regions: geometry.regions(), at: info.location, width: width,
                                        in: actions.workspace.document)
    }

    func dropEntered(info: DropInfo) { _ = dropUpdated(info: info) }
    func dropExited(info: DropInfo) { MainActor.assumeIsolated { state.clearHover() } }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        MainActor.assumeIsolated {
            let plan = resolve(info)
            state.hover(plan)
            geometry.autoscroll(pointer: info.location, unit: unit)
            return DropProposal(operation: plan == nil ? .forbidden : .copy)
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        MainActor.assumeIsolated {
            let plan = resolve(info)
            state.clearHover()
            guard case .addFolders(let container)? = plan?.action else { return false }
            let location: ProjectLocation = container.map { .group($0) } ?? .ungrouped
            for provider in info.itemProviders(for: [.fileURL]) {
                _ = provider.loadObject(ofClass: NSURL.self) { [actions] object, _ in
                    guard let url = object as? URL else { return }
                    Task { @MainActor in actions.addProjects(folders: [url], in: location) }
                }
            }
            return true
        }
    }
}

extension SidebarActions {
    /// Applies what the drag engine decided (undoable). Finder folders are added by the file drop delegate.
    func webDrop(_ action: SidebarDropPlan.Action) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) { doc in
            switch action {
            case .place(let item, let container, let before): doc.place(item, in: container, before: before)
            case .movePane(let id, let project): doc.moveWebPane(id, to: project)
            case .addFolders: break
            }
        }
    }
}

/// Starts the pointer drag of `SidebarWebDragState` from a row (web `useDraggable` + `PointerSensor`, 8px).
struct SidebarWebDragSource: ViewModifier {
    let payload: String
    let name: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag
    @Environment(\.sidebarWebAncestors) private var ancestors
    @State private var rowView = SidebarViewBox()
    @State private var started = false

    /// Web `.dragSource`: the picked-up item (and, for a group, everything inside it) fades to 45%.
    private var dimmed: Bool {
        guard let drag else { return false }
        if drag.source == payload { return true }
        return drag.sourceGroup.map { ancestors.contains($0) } ?? false
    }

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface, let item = SidebarDrag.parse(payload) {
            content
                .opacity(dimmed ? 0.45 : 1)
                .animation(.easeOut(duration: 0.12), value: dimmed)
                .background(SidebarRowViewProbe(box: rowView))
                .simultaneousGesture(DragGesture(minimumDistance: metrics.size(8), coordinateSpace: .global)
                    .onChanged { value in
                        guard !started, let drag else { return }
                        started = true
                        drag.begin(item, raw: payload, label: name, translation: value.translation,
                                   row: rowView.view, theme: theme, metrics: metrics)
                    }
                    .onEnded { _ in
                        started = false
                        drag?.finish()
                    })
        } else { content }
    }
}

final class SidebarViewBox {
    weak var view: NSView?
}

/// Lets a drag source read its row's screen frame to place the preview where the mouse grabbed it.
private struct SidebarRowViewProbe: NSViewRepresentable {
    let box: SidebarViewBox

    final class View: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> View {
        let view = View()
        box.view = view
        return view
    }

    func updateNSView(_ view: View, context: Context) { box.view = view }
}

/// An empty ungrouped list must remain reachable when all projects belong to groups.
struct SidebarUngroupedDropArea: View {
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag

    var body: some View {
        if let source = drag?.source, !source.hasPrefix(SidebarDrag.panePrefix) {
            Text("sidebar.drag.ungrouped")
                .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                // Web `.ungroupedEmptyDrop`: 24pt (clean: 22pt, no margin), normal adds a 2pt margin above the section.
                .frame(maxWidth: .infinity, minHeight: metrics.size(metrics.style == .clean ? 22 : 24))
                .modifier(SidebarWebDrop(target: .ungrouped, actions: actions))
                .padding(.top, metrics.size(metrics.style == .clean ? 0 : 2))
                .listRowSeparator(.hidden)
                .listRowBackground(theme[.bg])
                .accessibilityIdentifier("sidebar.drop.ungrouped")
        }
    }
}

/// Preserve the original native row delegates and their accepted payloads.
struct SidebarGroupRowDrop: ViewModifier {
    let target: GroupID
    let actions: SidebarActions
    @Binding var targeted: Bool
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.modifier(SidebarWebDrop(target: .groupHeader(target), actions: actions))
        } else {
            content.modifier(SidebarDropAppearance(targeted: targeted))
                .onDrop(of: [.plainText], isTargeted: $targeted) { providers in
                    SidebarDrag.load(providers) { actions.drop($0, onGroup: target) }
                    return true
                }
        }
    }
}

struct SidebarProjectRowDrop: ViewModifier {
    let project: ProjectID
    let actions: SidebarActions
    @Binding var targeted: Bool
    @Binding var inside: Bool
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.modifier(SidebarWebDrop(target: .project(project), actions: actions))
        } else {
            content.modifier(SidebarDropAppearance(targeted: targeted, insertion: !inside))
                .onDrop(of: [.plainText, SidebarDrag.paneType], delegate: SidebarProjectDrop(
                    targeted: $targeted, inside: $inside, project: project, actions: actions))
        }
    }
}

/// The web surface handles Finder folders together with internal ranked targets.
struct SidebarNativeFolderDrop: ViewModifier {
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content }
        else {
            content.dropDestination(for: URL.self) { urls, _ in
                !actions.addProjects(folders: urls).isEmpty
            }
        }
    }
}
