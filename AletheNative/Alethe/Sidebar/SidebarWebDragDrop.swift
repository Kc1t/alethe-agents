import AletheDesign
import AletheModel
import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

/// Separate row/header and body targets mirror dnd-kit's ranked collision targets.
enum SidebarWebDropTarget: Equatable, Sendable {
    case project(ProjectID), groupHeader(GroupID), groupBody(GroupID), ungrouped
}

/// Rows register their live AppKit view with the surface; one delegate resolves every overlapping target.
/// (SwiftUI named-space frames are not reliable inside List cells, so geometry is read from the views on demand.)
struct SidebarWebDrop: ViewModifier {
    let target: SidebarWebDropTarget
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag
    @Environment(\.sidebarDropGeometry) private var geometry
    @Environment(\.sidebarWebAncestors) private var ancestors
    @State private var token = UUID()

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            let top: CGFloat = if case .project = target { metrics.size(6) } else { 0 }
            content.background {
                ZStack {
                    RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .fill(theme[.panelHover].opacity(isInside ? 1 : 0))
                        .padding(.top, top)
                    SidebarDropProbe(token: token, target: target, ancestors: ancestors, geometry: geometry, unit: metrics.size(1))
                }
            }
        } else { content }
    }

    private var isInside: Bool {
        guard drag?.edge == .inside, let indicator = drag?.indicator else { return false }
        if indicator.target == target { return true }
        guard case .groupBody = indicator.target, let rect = geometry?.rect(of: token) else { return false }
        return indicator.hit.contains(CGPoint(x: rect.midX, y: rect.midY))
    }
}

struct SidebarDropRegion: Equatable, Sendable {
    let target: SidebarWebDropTarget
    let hit: CGRect
    let visual: CGRect
}

/// Live row geometry for the drop surface: every row registers its AppKit view and the frames are converted to
/// surface coordinates only when a drag asks for them, so scrolling and expanding can never leave them stale.
@MainActor final class SidebarDropGeometry {
    private struct Entry {
        let target: SidebarWebDropTarget
        let ancestors: [GroupID]
        let unit: CGFloat
        weak var view: NSView?
    }

    private var entries: [UUID: Entry] = [:]
    weak var surface: NSView?

    func register(_ token: UUID, target: SidebarWebDropTarget, ancestors: [GroupID], unit: CGFloat, view: NSView) {
        entries[token] = Entry(target: target, ancestors: ancestors, unit: unit, view: view)
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

    func regions() -> [SidebarDropRegion] {
        var result: [SidebarDropRegion] = []
        var bodies: [GroupID: CGRect] = [:]
        var unitFor: [GroupID: CGFloat] = [:]
        for entry in entries.values {
            guard let view = entry.view, let hit = local(view) else { continue }
            for group in entry.ancestors where entry.target != .groupHeader(group) {
                bodies[group] = bodies[group].map { $0.union(hit) } ?? hit
                unitFor[group] = entry.unit
            }
            if case .groupBody = entry.target { continue }
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
        for (group, bounds) in bodies {
            let pad = 7 * (unitFor[group] ?? 1)
            let rect = CGRect(x: bounds.minX - pad, y: bounds.minY, width: bounds.width + pad, height: bounds.height)
            result.append(SidebarDropRegion(target: .groupBody(group), hit: rect, visual: rect))
        }
        return result
    }

    func dropRegions(size: CGSize) -> [SidebarDropRegion] {
        let found = regions()
        let bottom = found.filter { $0.target != .ungrouped }.map(\.hit.maxY).max() ?? 0
        let rect = CGRect(x: 0, y: bottom, width: size.width, height: max(0, size.height - bottom))
        return found + [SidebarDropRegion(target: .ungrouped, hit: rect, visual: rect)]
    }
}

/// Zero-size-hit AppKit view that lets the drop surface read a row's real frame.
struct SidebarDropProbe: NSViewRepresentable {
    let token: UUID
    let target: SidebarWebDropTarget
    let ancestors: [GroupID]
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
        geometry?.register(token, target: target, ancestors: ancestors, unit: unit, view: view)
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

@MainActor @Observable final class SidebarWebDragState {
    var indicator: SidebarDropRegion?
    var edge: SidebarDropEdge?
    var source: String?
    var escapeMonitor: Any?

    func watchCancellation() {
        guard escapeMonitor == nil else { return }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                if event.keyCode == 53 { self?.clear() }
            }
            return event
        }
    }

    func stopWatching() {
        if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
        escapeMonitor = nil
        clear()
    }

    func clear() {
        indicator = nil
        edge = nil
        source = nil
    }
}

private extension EnvironmentValues {
    @Entry var sidebarWebDrag: SidebarWebDragState? = nil
    @Entry var sidebarWebParentGroup: GroupID? = nil
    @Entry var sidebarWebAncestors: [GroupID] = []
    @Entry var sidebarDropGeometry: SidebarDropGeometry? = nil
}

/// Expanded terminal rows contribute to their group's complete body bounds.
struct SidebarWebGroupContents: ViewModifier {
    let group: GroupID
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content.environment(\.sidebarWebParentGroup, group) }
        else { content }
    }
}

struct SidebarWebTerminalBodyDrop: ViewModifier {
    let enabled: Bool
    @Environment(\.sidebarWebParentGroup) private var group
    @Environment(\.sidebarWebAncestors) private var ancestors
    @Environment(\.sidebarDropGeometry) private var geometry
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag
    @State private var token = UUID()

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface, enabled, let group {
            let inside = drag?.edge == .inside && drag?.indicator?.target == .groupBody(group)
            content.background {
                ZStack {
                    theme[.panelHover].opacity(inside ? 1 : 0)
                    SidebarDropProbe(token: token, target: .groupBody(group), ancestors: ancestors, geometry: geometry, unit: metrics.size(1))
                }
            }
        } else { content }
    }
}

struct SidebarWebDropSurface: ViewModifier {
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var state = SidebarWebDragState()
    /// Live row frames, read lazily by the drop delegate (never SwiftUI state, so scrolling does not re-render).
    @State private var store = SidebarDropGeometry()
    @State private var size: CGSize = .zero

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
                .environment(\.sidebarWebDrag, state)
                .environment(\.sidebarDropGeometry, store)
                .background(SidebarDropSurfaceProbe(geometry: store))
                .overlay(alignment: .topLeading) {
                    if let region = state.indicator, let edge = state.edge {
                        let rect = region.visual
                        if edge != .inside {
                            Capsule().fill(theme[.accent])
                                .frame(width: max(0, rect.width - metrics.size(10)), height: metrics.size(2))
                                .allowsHitTesting(false)
                                .offset(x: rect.minX + metrics.size(5),
                                        y: edge == .before ? rect.minY - metrics.size(2) : rect.maxY)
                        }
                    }
                }
                .overlay(alignment: .topLeading) {
                    if let region = state.indicator, state.edge == .inside {
                        RoundedRectangle(cornerRadius: metrics.radius(.sm))
                            .fill(theme[.panelHover].opacity(region.target == .ungrouped ? 1 : 0))
                            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                                .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                            .frame(width: region.visual.width, height: region.visual.height)
                            .offset(x: region.visual.minX, y: region.visual.minY)
                            .allowsHitTesting(false)
                    }
                }
                .clipped()
                .onDrop(of: SidebarDrag.webTypes, delegate: SidebarWebDropDelegate(
                    state: state, store: store, size: size, width: size.width, actions: actions, scrollStep: metrics.size(8)))
                .task {
                    state.watchCancellation()
                    // SwiftUI does not guarantee dropExited on Escape, release outside, or removal.
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(50))
                        if NSEvent.pressedMouseButtons == 0 { state.clear() }
                    }
                }
                .onDisappear { state.stopWatching() }
        } else { content }
    }
}

private struct SidebarWebDropDelegate: DropDelegate {
    let state: SidebarWebDragState
    let store: SidebarDropGeometry
    let size: CGSize
    let width: CGFloat
    let actions: SidebarActions
    let scrollStep: CGFloat

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: SidebarDrag.webTypes) }

    @MainActor private func resolve(_ info: DropInfo) -> (SidebarDropRegion, SidebarDropEdge)? {
        let payload = state.source ?? info.itemProviders(for: SidebarDrag.webTypes).first?.suggestedName
        let source = payload.flatMap(SidebarDrag.parse)
        let files = info.hasItemsConforming(to: [.fileURL])
        let candidates = store.dropRegions(size: size).compactMap { region -> (SidebarDropRegion, Int)? in
            let rank: Int
            switch (source, region.target) {
            case (.project(let id), .project(let destination)):
                guard id != destination else { return nil }; rank = 0
            case (.project, .groupHeader), (.project, .ungrouped): rank = 1
            case (.pane(let id), .project(let destination)):
                guard actions.workspace.document.pane(id)?.project.id != destination else { return nil }; rank = 0
            case (.group(let id), .groupHeader(let destination)), (.group(let id), .groupBody(let destination)):
                guard !actions.workspace.document.isGroup(destination, inside: id) else { return nil }
                if case .groupHeader = region.target { rank = 0 } else { rank = 1 }
            case (.group, .ungrouped): rank = 1
            default:
                guard files else { return nil }
                switch region.target {
                case .project, .groupHeader: rank = 0
                case .groupBody, .ungrouped: rank = 1
                }
            }
            return (region, rank)
        }
        let hit = SidebarDropResolution.winner(at: info.location, candidates: candidates.map {
            let region = $0.0
            let bounds: CGRect
            switch region.target {
            case .project, .groupHeader:
                // List insets and indentation belong to the same row's hit area.
                bounds = CGRect(x: 0, y: region.hit.minY, width: width, height: region.hit.height)
            default: bounds = region.hit
            }
            return SidebarDropCandidate(bounds: bounds, rank: $0.1)
        })
        guard let hit else { return nil }
        let region = candidates[hit].0
        let edge: SidebarDropEdge
        var isPane = false, isGroup = false
        switch source {
        case .pane: isPane = true
        case .group: isGroup = true
        default: break
        }
        // The dragged payload decides the edge; provider type checks can lag behind mid-drag and made a group
        // reorder resolve as "inside" (nesting it) while the indicator showed the right row.
        if files || isPane || (source == nil && info.hasItemsConforming(to: [SidebarDrag.paneType])) { edge = .inside }
        else {
            switch region.target {
            case .project: edge = SidebarDropResolution.edge(at: info.location.y, row: region.visual)
            case .groupHeader:
                edge = isGroup || (source == nil && info.hasItemsConforming(to: [SidebarDrag.groupType]))
                    ? SidebarDropResolution.edge(at: info.location.y, row: region.visual) : .inside
            case .groupBody, .ungrouped: edge = .inside
            }
        }
        return (region, edge)
    }

    func dropEntered(info: DropInfo) { _ = dropUpdated(info: info) }
    func dropExited(info: DropInfo) { MainActor.assumeIsolated { state.indicator = nil; state.edge = nil } }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        MainActor.assumeIsolated {
            let resolved = resolve(info)
            state.indicator = resolved?.0
            state.edge = resolved?.1
            scrollNearEdge()
            return DropProposal(operation: resolved == nil ? .forbidden
                : info.hasItemsConforming(to: [.fileURL]) ? .copy : .move)
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        MainActor.assumeIsolated {
            let resolved = resolve(info)
            state.clear()
            guard let (region, placement) = resolved else { return false }
            let target = region.target
            if info.hasItemsConforming(to: [.fileURL]) {
                for provider in info.itemProviders(for: [.fileURL]) {
                    _ = provider.loadObject(ofClass: NSURL.self) { [target, actions] object, _ in
                        guard let url = object as? URL else { return }
                        Task { @MainActor in
                            let location: ProjectLocation
                            switch target {
                            case .project(let id): location = actions.workspace.document.location(of: id) ?? .ungrouped
                            case .groupHeader(let id), .groupBody(let id): location = .group(id)
                            case .ungrouped: location = .ungrouped
                            }
                            actions.addProjects(folders: [url], in: location)
                        }
                    }
                }
            } else {
                SidebarDrag.load(info.itemProviders(for: SidebarDrag.webTypes)) { [target, actions] dropped in
                    actions.webDrop(dropped, target: target, edge: placement)
                }
            }
            return true
        }
    }

    /// AppKit owns the drag session (including Escape); scroll only the sidebar under the pointer.
    @MainActor private func scrollNearEdge() {
        guard let window = NSApp.keyWindow, let root = window.contentView else { return }
        let point = window.convertPoint(fromScreen: NSEvent.mouseLocation)
        guard let hit = root.hitTest(root.convert(point, from: nil)),
              let scroll = hit.enclosingScrollView else { return }
        let clip = scroll.contentView
        let local = clip.convert(point, from: nil)
        let margin = scrollStep * 3
        let delta: CGFloat = local.y < clip.bounds.minY + margin ? -scrollStep
            : local.y > clip.bounds.maxY - margin ? scrollStep : 0
        guard delta != 0, let document = scroll.documentView else { return }
        let y = max(0, min(clip.bounds.origin.y + delta, max(0, document.bounds.height - clip.bounds.height)))
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        scroll.reflectScrolledClipView(clip)
    }
}

extension SidebarActions {
    func webDrop(_ dropped: SidebarDrag.Dropped, target: SidebarWebDropTarget, edge: SidebarDropEdge) {
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.move")) { doc in
            switch (dropped, target) {
            case (.project(let id), .project(let destination)):
                doc.dropProject(id, beside: destination, edge: edge)
            case (.pane(let id), .project(let destination)):
                doc.moveWebPane(id, to: destination)
            case (.group(let id), .groupHeader(let destination)):
                doc.dropGroup(id, beside: destination, edge: edge)
            case (.group(let id), .groupBody(let destination)):
                doc.dropGroup(id, beside: destination, edge: .inside)
            case (.project(let id), .groupHeader(let destination)):
                if doc.location(of: id) != .group(destination) { doc.moveProject(id, to: .group(destination), at: Int.max) }
            case (.project(let id), .ungrouped):
                doc.moveProject(id, to: .ungrouped, at: Int.max)
            case (.group(let id), .ungrouped):
                doc.moveGroup(id, toParent: nil, at: Int.max)
            default: break
            }
        }
    }
}

struct SidebarWebDragSource: ViewModifier {
    let payload: String
    let name: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.opacity(drag?.source == payload ? 0.45 : 1).onDrag {
                drag?.source = payload
                return SidebarDrag.provider(payload)
            } preview: {
                HStack(spacing: metrics.size(8)) {
                    Image(systemName: "folder").font(metrics.font(size: 14))
                    Text(verbatim: name).lineLimit(1).truncationMode(.tail)
                }
                .font(metrics.font(size: 12, weight: .semibold))
                .foregroundStyle(theme[.fg])
                .padding(.vertical, metrics.size(7)).padding(.horizontal, metrics.size(10))
                .frame(minWidth: metrics.size(150), maxWidth: metrics.size(260), minHeight: metrics.size(34), alignment: .leading)
                .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
            }
        } else { content }
    }
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
                .frame(maxWidth: .infinity, minHeight: metrics.size(24))
                .modifier(SidebarWebDrop(target: .ungrouped, actions: actions))
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
