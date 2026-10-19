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

/// Rows only publish geometry. One delegate resolves every overlapping target before painting.
struct SidebarWebDrop: ViewModifier {
    let target: SidebarWebDropTarget
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.background(GeometryReader { geometry in
                let hit = geometry.frame(in: .named("sidebar.web.drop"))
                let top: CGFloat = switch target {
                case .project: metrics.size(6)
                case .groupHeader: max(0, hit.height - metrics.size(26))
                default: 0
                }
                let bottom: CGFloat = if case .groupHeader = target { metrics.size(2) } else { 0 }
                let inside = drag?.edge == .inside && (drag?.indicator?.target == target || {
                    guard let indicator = drag?.indicator,
                          case .groupBody = indicator.target else { return false }
                    return indicator.hit.contains(CGPoint(x: hit.midX, y: hit.midY))
                }())
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .fill(theme[.panelHover].opacity(inside ? 1 : 0))
                    .padding(.top, top)
                    .padding(.bottom, bottom)
                    .preference(key: SidebarDropRegions.self, value: [SidebarDropRegion(
                    target: target, hit: hit,
                    visual: CGRect(x: hit.minX, y: hit.minY + top, width: hit.width,
                                   height: max(0, hit.height - top - bottom)))])
            })
        } else { content }
    }
}

struct SidebarDropRegion: Equatable, Sendable {
    let target: SidebarWebDropTarget
    let hit: CGRect
    let visual: CGRect
}

struct SidebarDropRegions: PreferenceKey {
    static let defaultValue: [SidebarDropRegion] = []
    static func reduce(value: inout [SidebarDropRegion], nextValue: () -> [SidebarDropRegion]) {
        value += nextValue()
    }
}

/// A group's body includes descendants, but excludes its own header and its top margin.
struct SidebarWebGroupRegion: ViewModifier {
    let group: GroupID
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.transformPreference(SidebarDropRegions.self) { regions in
                let children = regions.filter { $0.target != .groupHeader(group) }
                guard let first = children.first else { return }
                let bounds = children.dropFirst().reduce(first.hit) { $0.union($1.hit) }
                let rect = CGRect(x: bounds.minX - metrics.size(7), y: bounds.minY,
                                  width: bounds.width + metrics.size(7), height: bounds.height)
                regions.removeAll { $0.target == .groupBody(group) }
                regions.append(SidebarDropRegion(target: .groupBody(group), hit: rect, visual: rect))
            }
        } else { content }
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
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarWebDrag) private var drag

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface, enabled, let group {
            content.background(GeometryReader { geometry in
                let rect = geometry.frame(in: .named("sidebar.web.drop"))
                let inside = drag?.edge == .inside && drag?.indicator?.target == .groupBody(group)
                theme[.panelHover].opacity(inside ? 1 : 0)
                    .preference(key: SidebarDropRegions.self, value: [SidebarDropRegion(
                        target: .groupBody(group), hit: rect, visual: rect)])
            })
        } else { content }
    }
}

struct SidebarWebDropSurface: ViewModifier {
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var state = SidebarWebDragState()
    @State private var regions: [SidebarDropRegion] = []
    @State private var size: CGSize = .zero

    private var dropRegions: [SidebarDropRegion] {
        let bottom = regions.map(\.hit.maxY).max() ?? 0
        let rect = CGRect(x: 0, y: bottom, width: size.width, height: max(0, size.height - bottom))
        return regions + [SidebarDropRegion(target: .ungrouped, hit: rect, visual: rect)]
    }

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .coordinateSpace(name: "sidebar.web.drop")
                .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
                .environment(\.sidebarWebDrag, state)
                .onPreferenceChange(SidebarDropRegions.self) { updated in
                    let wasEnd = state.indicator.map { !regions.contains($0) && $0.target == .ungrouped } ?? false
                    regions = updated
                    if let current = state.indicator {
                        state.indicator = wasEnd ? dropRegions.last : updated.first { $0.target == current.target }
                        if state.indicator == nil { state.edge = nil }
                    }
                }
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
                            .fill(theme[.panelHover].opacity(region.target == .ungrouped && !regions.contains(region) ? 1 : 0))
                            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                                .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                            .frame(width: region.visual.width, height: region.visual.height)
                            .offset(x: region.visual.minX, y: region.visual.minY)
                            .allowsHitTesting(false)
                    }
                }
                .clipped()
                .onDrop(of: SidebarDrag.webTypes, delegate: SidebarWebDropDelegate(
                    state: state, regions: dropRegions, width: size.width, actions: actions, scrollStep: metrics.size(8)))
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
    let regions: [SidebarDropRegion]
    let width: CGFloat
    let actions: SidebarActions
    let scrollStep: CGFloat

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: SidebarDrag.webTypes) }

    @MainActor private func resolve(_ info: DropInfo) -> (SidebarDropRegion, SidebarDropEdge)? {
        let payload = state.source ?? info.itemProviders(for: SidebarDrag.webTypes).first?.suggestedName
        let source = payload.flatMap(SidebarDrag.parse)
        let files = info.hasItemsConforming(to: [.fileURL])
        let candidates = regions.compactMap { region -> (SidebarDropRegion, Int)? in
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
        if files || info.hasItemsConforming(to: [SidebarDrag.paneType]) { edge = .inside }
        else {
            switch region.target {
            case .project: edge = SidebarDropResolution.edge(at: info.location.y, row: region.visual)
            case .groupHeader:
                edge = info.hasItemsConforming(to: [SidebarDrag.groupType])
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
