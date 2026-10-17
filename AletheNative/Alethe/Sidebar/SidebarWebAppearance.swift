import AppKit
import AletheDesign
import SwiftUI

private extension EnvironmentValues {
    @Entry var sidebarGroupDepth = 0
}

struct SidebarListAppearance: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.listStyle(.plain)
                .listItemTint(.clear)
                .scrollContentBackground(.hidden)
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
    let item: SidebarItem
    private let expansion: Binding<Bool>?
    let content: Content
    let label: Label
    @State private var expanded = true
    @State private var nativeExpanded = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarGroupDepth) private var depth

    init(isGroup: Bool, item: SidebarItem, isExpanded: Binding<Bool>? = nil,
         @ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {
        self.isGroup = isGroup
        self.item = item
        expansion = isExpanded
        self.content = content()
        self.label = label()
    }

    private var binding: Binding<Bool> { expansion ?? (metrics.isWebInterface ? $expanded : $nativeExpanded) }

    @ViewBuilder var body: some View {
        if metrics.isWebInterface {
            label
                .tag(item)
                .itemProvider {
                    switch item {
                    case .group(let id): NSItemProvider(object: SidebarDrag.payload(id) as NSString)
                    case .project(let id): NSItemProvider(object: SidebarDrag.payload(id) as NSString)
                    case .tab: nil
                    }
                }
                .onTapGesture { if isGroup { binding.wrappedValue.toggle() } }
                .overlay(alignment: .bottomTrailing) {
                    Button { binding.wrappedValue.toggle() } label: {
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(binding.wrappedValue ? 0 : -90))
                            .font(metrics.font(size: isGroup ? 14 : 15))
                            .foregroundStyle(theme[isGroup ? .fgFaint : .fgMuted])
                            .frame(width: metrics.size(isGroup ? 18 : 20), height: metrics.size(isGroup ? 18 : 20))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("sidebar.disclosure"))
                    .padding(.trailing, metrics.size(isGroup ? 6 : 8))
                    .padding(.bottom, metrics.size(isGroup ? 5 : 4))
                }
                .listRowInsets(EdgeInsets(top: 0, leading: metrics.size(8 + CGFloat(depth) * 10),
                                          bottom: 0, trailing: metrics.size(8)))
                .listRowSeparator(.hidden)
                .listRowBackground(theme[.bg])
            if binding.wrappedValue {
                content.environment(\.sidebarGroupDepth, depth + (isGroup ? 1 : 0))
            }
        } else {
            DisclosureGroup(isExpanded: binding) { content } label: { label }
                .tag(item)
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
                        .font(metrics.font(size: iconSize == 20 ? 20 : 14))
                        .fixedSize()
                        .frame(minWidth: metrics.size(iconSize))
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
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.sidebarGroupDepth) private var depth

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content
                .padding(.leading, metrics.size(kind == .terminal ? 26 : 10))
                .padding(.trailing, metrics.size(kind == .group ? 32 : kind == .project ? 37 : 8))
                .frame(height: metrics.size(kind == .group ? 24 : 28))
                .aletheRowBackground(isSelected: false)
                .background {
                    if focused {
                        RoundedRectangle(cornerRadius: metrics.radius(.md))
                            .fill(theme[.panelHover].opacity(0.82))
                            .background(theme[.fg].opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    }
                }
                .padding(.top, metrics.size(kind == .group ? (first ? 12 : 22) : kind == .project ? 6 : 0))
                .padding(.bottom, metrics.size(kind == .group ? 2 : 0))
                .overlay(alignment: .leading) {
                    ForEach(0..<depth, id: \.self) { level in
                        Rectangle().fill(theme[.border].opacity(0.55))
                            .frame(width: metrics.size(1))
                            .offset(x: -metrics.size(7 + CGFloat(level) * 10))
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: metrics.size(8 + CGFloat(depth) * 10),
                                          bottom: 0, trailing: metrics.size(8)))
                .listRowSeparator(.hidden)
                .listRowBackground(theme[.bg])
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
            .padding(.vertical, metrics.size(7))
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                ForEach(0..<depth, id: \.self) { level in
                    Rectangle().fill(theme[.border].opacity(0.55))
                        .frame(width: metrics.size(1))
                        .offset(x: -metrics.size(7 + CGFloat(level) * 10))
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: metrics.size(8 + CGFloat(depth) * 10),
                                      bottom: 0, trailing: metrics.size(8)))
            .listRowSeparator(.hidden)
            .listRowBackground(theme[.bg])
    }
}
