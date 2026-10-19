import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Separate row/header and body targets mirror dnd-kit's ranked collision targets.
enum SidebarWebDropTarget: Sendable {
    case project(ProjectID), groupHeader(GroupID), groupBody(GroupID), ungrouped
}

struct SidebarWebDrop: ViewModifier {
    let target: SidebarWebDropTarget
    let actions: SidebarActions
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var edge: SidebarDropEdge?

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .background(theme[.panelHover].opacity(edge == .inside ? 1 : 0),
                            in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay {
                    if edge == .inside {
                        RoundedRectangle(cornerRadius: metrics.radius(.sm))
                            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1))
                            .allowsHitTesting(false)
                    }
                }
                .overlay(alignment: edge == .after ? .bottom : .top) {
                    if edge == .before || edge == .after {
                        Capsule().fill(theme[.accent]).frame(height: metrics.size(2))
                            .padding(.horizontal, metrics.size(5))
                            .offset(y: metrics.size(edge == .after ? 2 : -2))
                            .allowsHitTesting(false)
                    }
                }
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: SidebarDropHeight.self, value: geometry.size.height)
                })
                .onPreferenceChange(SidebarDropHeight.self) { height = $0 }
                .onDrop(of: SidebarDrag.webTypes, delegate: SidebarWebDropDelegate(
                    edge: $edge, target: target, height: height, actions: actions, scrollStep: metrics.size(8)))
        } else { content }
    }

    @State private var height: CGFloat = 0
}

private struct SidebarDropHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct SidebarWebDropDelegate: DropDelegate {
    @Binding var edge: SidebarDropEdge?
    let target: SidebarWebDropTarget
    let height: CGFloat
    let actions: SidebarActions
    let scrollStep: CGFloat

    func validateDrop(info: DropInfo) -> Bool {
        if let name = info.itemProviders(for: SidebarDrag.webTypes).first?.suggestedName,
           let source = SidebarDrag.parse(name) {
            let valid = MainActor.assumeIsolated {
                switch (source, target) {
                case (.project(let id), .project(let destination)): return id != destination
                case (.pane(let id), .project(let destination)):
                    return actions.workspace.document.pane(id)?.project.id != destination
                case (.group(let id), .groupHeader(let destination)),
                     (.group(let id), .groupBody(let destination)):
                    return !actions.workspace.document.isGroup(destination, inside: id)
                default: return true
                }
            }
            if !valid { return false }
        }
        return switch target {
        case .project: info.hasItemsConforming(to: [SidebarDrag.projectType, SidebarDrag.paneType, .fileURL])
        case .groupHeader: info.hasItemsConforming(to: [SidebarDrag.projectType, SidebarDrag.groupType, .fileURL])
        case .groupBody: info.hasItemsConforming(to: [SidebarDrag.groupType, .fileURL])
        case .ungrouped: info.hasItemsConforming(to: [SidebarDrag.projectType, SidebarDrag.groupType, .fileURL])
        }
    }

    func dropEntered(info: DropInfo) { edge = validateDrop(info: info) ? proposedEdge(info) : nil }
    func dropExited(info: DropInfo) { edge = nil }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard validateDrop(info: info) else {
            edge = nil
            return DropProposal(operation: .forbidden)
        }
        edge = proposedEdge(info)
        MainActor.assumeIsolated { scrollNearEdge() }
        return DropProposal(operation: info.hasItemsConforming(to: [.fileURL]) ? .copy : .move)
    }

    private func proposedEdge(_ info: DropInfo) -> SidebarDropEdge {
        if info.hasItemsConforming(to: [.fileURL, SidebarDrag.paneType]) { return .inside }
        switch target {
        case .project: return info.location.y < height / 2 ? .before : .after
        case .groupHeader:
            return info.hasItemsConforming(to: [SidebarDrag.groupType])
                ? (info.location.y < height / 2 ? .before : .after) : .inside
        case .groupBody, .ungrouped: return .inside
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        guard validateDrop(info: info) else { return false }
        let placement = proposedEdge(info)
        edge = nil
        MainActor.assumeIsolated {
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
        }
        return true
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
                if doc.location(of: id) != .ungrouped { doc.moveProject(id, to: .ungrouped, at: Int.max) }
            case (.group(let id), .ungrouped):
                if doc.group(id)?.parentID != nil { doc.moveGroup(id, toParent: nil, at: Int.max) }
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

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.onDrag { SidebarDrag.provider(payload) } preview: {
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

    var body: some View {
        Text("sidebar.drag.ungrouped")
            .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
            .frame(maxWidth: .infinity, minHeight: metrics.size(24))
            .modifier(SidebarWebDrop(target: .ungrouped, actions: actions))
            .listRowSeparator(.hidden)
            .listRowBackground(theme[.bg])
            .accessibilityIdentifier("sidebar.drop.ungrouped")
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
