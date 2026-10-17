import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// Menu labels need their own style: AppKit menus do not inherit an icon button's label style.
struct SidebarMenuAppearance: ViewModifier {
    var size: CGFloat = 14
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.labelStyle(.iconOnly)
                .font(metrics.font(size: size))
                .clipped()
        } else { content }
    }
}

/// Keep the macOS interface's text menus while giving the web interface Lucide-equivalent icons.
struct SidebarMenuButton: View {
    let title: LocalizedStringKey
    let symbol: String
    let role: ButtonRole?
    let action: () -> Void
    @Environment(\.metrics) private var metrics

    init(_ title: LocalizedStringKey, symbol: String, role: ButtonRole? = nil,
         action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.role = role
        self.action = action
    }

    @ViewBuilder var body: some View {
        if metrics.isWebInterface {
            Button(role: role, action: action) {
                if symbol == "chevron.left.forwardslash.chevron.right" {
                    Label { Text(title) } icon: {
                        if let image = AgentLogo.menuImage(named: "BrandLogo-vscode", side: metrics.size(14)) {
                            Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                                .frame(width: metrics.size(14), height: metrics.size(14))
                        } else {
                            Image(systemName: symbol).webProfileSized(14)
                        }
                    }
                } else {
                    Label { Text(title) } icon: {
                        Image(systemName: symbol).webProfileSized(14)
                    }
                }
            }
        } else {
            Button(title, role: role, action: action)
        }
    }
}

/// Compact web empty state, without a surrounding card in the sidebar.
struct SidebarWebEmptyState: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: metrics.size(10)) {
            Image(systemName: "folder.badge.plus").webProfileSized(18)
                .font(metrics.font(size: 18))
                .foregroundStyle(theme[.accent])
                .frame(width: metrics.size(56), height: metrics.size(56))
                .background(theme[.accentSoft], in: RoundedRectangle(cornerRadius: iconRadius))
                .overlay(RoundedRectangle(cornerRadius: iconRadius)
                    .strokeBorder(theme[.accentBorder], lineWidth: metrics.size(1)))
                .accessibilityHidden(true)
            VStack(spacing: metrics.size(6)) {
                Text("leftSidebar.emptyTitle")
                    .font(metrics.font(size: 15, weight: .semibold))
                    .tracking(metrics.size(-0.3))
                    .foregroundStyle(theme[.fg])
                Text("leftSidebar.emptyDescription")
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .lineSpacing(metrics.size(6.6))
            }
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.center)
            Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                Text("leftSidebar.emptyAction")
                    .font(metrics.font(size: 13, weight: .semibold))
                    .padding(.horizontal, metrics.size(14))
                    .frame(minHeight: metrics.size(metrics.style == .clean ? 30 : 36))
                    .foregroundStyle(theme[.accentOn])
                    .background(theme[.accent], in: RoundedRectangle(cornerRadius: buttonRadius))
            }
            .buttonStyle(.plain)
            .disabled(environment.workspace == nil)
        }
        .padding(.horizontal, metrics.size(18))
        .padding(.vertical, metrics.size(20))
        .frame(maxWidth: .infinity)
        .padding(metrics.size(14))
        .accessibilityIdentifier("sidebar.empty")
    }

    private var iconRadius: CGFloat { metrics.size(metrics.style == .clean ? 4 : 18) }
    private var buttonRadius: CGFloat { metrics.size(metrics.style == .clean ? 4 : 12) }
}

struct SidebarDropAppearance: ViewModifier {
    let targeted: Bool
    var insertion = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.background(theme[.panelHover].opacity(targeted && !insertion ? 1 : 0),
                               in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.borderStrong].opacity(targeted && !insertion ? 1 : 0),
                                  lineWidth: metrics.size(1)))
                .overlay(alignment: .top) {
                    if insertion && targeted {
                        Capsule().fill(theme[.accent])
                            .frame(height: metrics.size(2))
                            .padding(.horizontal, metrics.size(5))
                            .offset(y: -metrics.size(2))
                            .allowsHitTesting(false)
                    }
                }
        } else { content }
    }
}

struct SidebarSymbolAppearance: ViewModifier {
    let size: CGFloat
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content.font(metrics.font(size: size)) }
        else { content }
    }
}

/// Keep native tooltips intact when supplying web row titles.
struct SidebarWebHelp: ViewModifier {
    let text: String
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface { content.help(Text(verbatim: text)) }
        else { content }
    }
}

/// A double click opens only this group, matching NormalGroupNode's header gesture.
struct SidebarWebGroupOpen: ViewModifier {
    let open: () -> Void
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface && metrics.style != .clean {
            content
                .highPriorityGesture(TapGesture(count: 2).onEnded { open() })
                .help(Text("sidebar.openOnlyGroup"))
        } else { content }
    }
}

/// Explicit web gestures handle repeated selections and ignore row modifier keys.
struct SidebarWebClick: ViewModifier {
    let single: () -> Void
    var double: (() -> Void)? = nil
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface {
            if let double {
                content.onTapGesture(count: 2, perform: double)
                    .onTapGesture(perform: single)
            } else { content.onTapGesture(perform: single) }
        } else { content }
    }
}

struct SidebarWebPaneDrag: ViewModifier {
    let pane: PaneID?
    @Environment(\.metrics) private var metrics

    @ViewBuilder func body(content: Content) -> some View {
        if metrics.isWebInterface, let pane {
            content.itemProvider {
                let provider = NSItemProvider()
                let data = Data(SidebarDrag.payload(pane).utf8)
                provider.registerDataRepresentation(forTypeIdentifier: SidebarDrag.paneType.identifier,
                    visibility: .ownProcess) { completion in
                    completion(data, nil)
                    return nil
                }
                return provider
            }
        } else { content }
    }
}
