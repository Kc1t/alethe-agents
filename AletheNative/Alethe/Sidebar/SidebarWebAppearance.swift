import AppKit
import AletheDesign
import AletheModel
import SwiftUI

private extension EnvironmentValues {
    @Entry var sidebarGroupDepth = 0
    @Entry var sidebarFirstRootGroup = false
}

struct SidebarListAppearance: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.listStyle(.plain)
                .scrollBounceBehavior(.basedOnSize)
                .listItemTint(.clear)
                .contentMargins(.horizontal, 0, for: .scrollContent)
                .scrollContentBackground(.hidden)
                .webScrollStyle()
                .environment(\.defaultMinListRowHeight, 0)
                .contentMargins(.top, metrics.size(4), for: .scrollContent)
                .contentMargins(.bottom, metrics.size(10), for: .scrollContent)
                .background(theme[.bg])
        } else { content.listStyle(.sidebar) }
    }
}

/// A custom disclosure keeps List selection and insertion while removing system source-list chrome.
struct SidebarDisclosure<Content: View, Label: View>: View {
    let isGroup: Bool
    let firstRootGroup: Bool
    let item: SidebarItem
    private let expansion: Binding<Bool>?
    let content: Content
    let label: Label
    @State private var expanded = true
    @State private var nativeExpanded = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarGroupDepth) private var depth
    @Environment(\.sidebarFirstRootGroup) private var inheritedFirstRootGroup

    init(isGroup: Bool, item: SidebarItem, firstRootGroup: Bool = false, isExpanded: Binding<Bool>? = nil,
         @ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {
        self.isGroup = isGroup
        self.firstRootGroup = firstRootGroup
        self.item = item
        expansion = isExpanded
        self.content = content()
        self.label = label()
    }

    private var binding: Binding<Bool> { expansion ?? (metrics.isWebInterface ? $expanded : $nativeExpanded) }

    @ViewBuilder var body: some View {
        if metrics.isWebInterface {
            webDisclosure
                .animation(Motion.SidebarEffect.collapse.animation(reduceMotion: metrics.reducesMotion),
                           value: binding.wrappedValue)
        } else {
            DisclosureGroup(isExpanded: binding) { content } label: { label }
                .tag(item)
        }
    }

    private func toggle() {
        withAnimation(Motion.SidebarEffect.collapse.animation(reduceMotion: metrics.reducesMotion)) {
            binding.wrappedValue.toggle()
        }
    }

    private var webDisclosure: some View {
        Group {
            label
                .tag(item)
                .onTapGesture { if isGroup { toggle() } }
                .overlay(alignment: .bottomTrailing) {
                    Button { toggle() } label: {
                        Image(systemName: "chevron.down").webProfileSized(isGroup ? 14 : (metrics.style == .clean ? 13 : 15))
                            .rotationEffect(.degrees(binding.wrappedValue ? 0 : -90))
                            .animation(Motion.SidebarEffect.chevron.animation(reduceMotion: metrics.reducesMotion),
                                       value: binding.wrappedValue)
                            .font(metrics.font(size: isGroup ? 14 : (metrics.style == .clean ? 13 : 15)))
                            .foregroundStyle(theme[isGroup ? .fgFaint : .fgMuted])
                            .frame(width: metrics.size(isGroup ? 18 : 20), height: metrics.size(isGroup ? 18 : 20))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("sidebar.disclosure"))
                    .accessibilityValue(Text(binding.wrappedValue ? LocalizedStringKey("sidebar.web.expanded") : "sidebar.web.collapsed"))
                    .padding(.trailing, metrics.size(isGroup ? 6 : 8))
                    .padding(.bottom, metrics.size(isGroup ? 5 : 4))
                }
                .listRowInsets(EdgeInsets(top: 0, leading: metrics.size(8 + CGFloat(depth) * (metrics.style == .clean ? 11 : 10)),
                                          bottom: 0, trailing: metrics.size(8)))
                .listRowSeparator(.hidden)
                .listRowBackground(theme[.bg])
            if binding.wrappedValue {
                content.environment(\.sidebarGroupDepth, depth + (isGroup ? 1 : 0))
                    .environment(\.sidebarFirstRootGroup, inheritedFirstRootGroup || firstRootGroup)
                    .transition(metrics.reducesMotion ? .identity : .opacity.animation(
                        Motion.SidebarEffect.collapseOpacity.animation(reduceMotion: false)))
            }
        }
    }
}

struct SidebarLabelAppearance: ViewModifier {
    let isGroup: Bool
    var iconSize: CGFloat = 15
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content.labelStyle(SidebarLabelStyle(isGroup: isGroup, iconSize: iconSize)) }
        else { content }
    }
}

struct SidebarLabelStyle: LabelStyle {
    let isGroup: Bool
    var iconSize: CGFloat = 15
    @Environment(\.metrics) private var metrics

    @ViewBuilder func makeBody(configuration: Configuration) -> some View {
        if metrics.isWebInterface {
            HStack(spacing: metrics.size(isGroup ? 8 : 9)) {
                if !isGroup {
                    configuration.icon
                        .font(metrics.font(size: iconSize == 16 ? (metrics.style == .clean ? 15 : 16) : 14))
                        .fixedSize()
                        .frame(minWidth: metrics.size(15))
                        .frame(width: iconSize == 16 ? metrics.size(15) : nil)
                }
                configuration.title
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else { Label(configuration) }
    }
}

struct SidebarWebRow: ViewModifier {
    enum Kind { case group, project, terminal }
    let kind: Kind
    var first = false
    var focused = false
    /// The project a terminal row belongs to, so a drop on it counts as a drop on that project.
    var project: ProjectID?
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarGroupDepth) private var depth
    @Environment(\.sidebarFirstRootGroup) private var inheritedFirstRootGroup
    @Environment(\.sidebarWebDrag) private var drag
    @State private var hovering = false

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .padding(.leading, metrics.size(kind == .terminal ? 26 : 10))
                .padding(.trailing, metrics.size(kind == .group ? 32 : kind == .project ? 37 : 8))
                .frame(height: metrics.size(kind == .group ? 24 : 28))
                .background(theme[.panelHover].opacity(hovering && !focused && drag?.isDragging != true ? 1 : 0),
                            in: RoundedRectangle(cornerRadius: kind == .group ? metrics.size(6) : metrics.radius(.md)))
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .background {
                    if focused {
                        RoundedRectangle(cornerRadius: metrics.radius(.md))
                            .fill(theme[.panelHover].opacity(0.82))
                            .background(theme[.fg].opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    }
                }
                .padding(.top, metrics.size(kind == .group ? ((first || (metrics.style == .normal && inheritedFirstRootGroup)) ? 12 : 22) : kind == .project ? 6 : 0))
                .padding(.bottom, metrics.size(kind == .group ? 2 : 0))
                .overlay(alignment: .leading) {
                    ForEach(0..<depth, id: \.self) { level in
                        Rectangle().fill(theme[.border].opacity(0.55))
                            .frame(width: metrics.size(1))
                            .offset(x: -metrics.size((metrics.style == .clean ? 8 : 7) + CGFloat(level) * (metrics.style == .clean ? 11 : 10)))
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: metrics.size(8 + CGFloat(depth) * (metrics.style == .clean ? 11 : 10)),
                                          bottom: 0, trailing: metrics.size(8)))
                .listRowSeparator(.hidden)
                .listRowBackground(theme[.bg])
                .modifier(SidebarWebTerminalBodyDrop(enabled: kind == .terminal, project: project))
        } else { content }
    }
}

/// Native disclosures own their descendants; web disclosures expose separate List rows.
struct SidebarNativeDragSource: ViewModifier {
    let payload: String
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content }
        else { content.itemProvider { NSItemProvider(object: payload as NSString) } }
    }
}

struct SidebarWebGroupEmpty: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarGroupDepth) private var depth

    var body: some View {
        Text("sidebar.group.empty")
            .font(metrics.font(size: 11))
            .foregroundStyle(theme[.fgFaint])
            .padding(.horizontal, metrics.size(10))
            .padding(.vertical, metrics.size(metrics.style == .clean ? 4 : 7))
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                ForEach(0..<depth, id: \.self) { level in
                    Rectangle().fill(theme[.border].opacity(0.55))
                        .frame(width: metrics.size(1))
                        .offset(x: -metrics.size((metrics.style == .clean ? 8 : 7) + CGFloat(level) * (metrics.style == .clean ? 11 : 10)))
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: metrics.size(8 + CGFloat(depth) * (metrics.style == .clean ? 11 : 10)),
                                      bottom: 0, trailing: metrics.size(8)))
            .listRowSeparator(.hidden)
            .listRowBackground(theme[.bg])
    }
}
