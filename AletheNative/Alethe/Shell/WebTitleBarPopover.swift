import AletheDesign
import SwiftUI

/// The web's absolutely positioned dropdowns, lifted above the workspace rather than AppKit bubbles.
struct WebTitleBarPopover {
    let anchor: Anchor<CGRect>
    let content: AnyView
    let width: CGFloat
    let trailing: Bool
    let dismiss: () -> Void
}

struct WebTitleBarPopoverKey: PreferenceKey {
    static var defaultValue: [WebTitleBarPopover] { [] }
    static func reduce(value: inout [WebTitleBarPopover], nextValue: () -> [WebTitleBarPopover]) {
        value.append(contentsOf: nextValue())
    }
}

/// True while any title-bar popover is open: the panels below stop reacting to hover (their AppKit-backed
/// rows keep tracking the pointer even under the popover layer).
struct WebTitleBarPopoverOpenKey: PreferenceKey {
    static var defaultValue: Bool { false }
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

extension View {
    func webTitleBarPopover<Content: View>(isPresented: Binding<Bool>, width: CGFloat, trailing: Bool = true,
                                          @ViewBuilder content: @escaping () -> Content) -> some View {
        preference(key: WebTitleBarPopoverOpenKey.self, value: isPresented.wrappedValue)
        .anchorPreference(key: WebTitleBarPopoverKey.self, value: .bounds) { anchor in
            isPresented.wrappedValue ? [WebTitleBarPopover(anchor: anchor, content: AnyView(content()), width: width,
                                                          trailing: trailing, dismiss: { isPresented.wrappedValue = false })] : []
        }
    }
}

struct WebTitleBarPopoverLayer: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content.overlayPreferenceValue(WebTitleBarPopoverKey.self) { menus in
            GeometryReader { geometry in
                ForEach(Array(menus.enumerated()), id: \.offset) { _, menu in
                    let rect = geometry[menu.anchor]
                    let width = min(metrics.size(menu.width), max(0, geometry.size.width - metrics.size(8)))
                    let left = min(max(metrics.size(4), menu.trailing ? rect.maxX - width : rect.minX),
                                   max(metrics.size(4), geometry.size.width - width - metrics.size(4)))
                    let outsideTrigger = Path { path in
                        path.addRect(CGRect(origin: .zero, size: geometry.size))
                        path.addRect(rect)
                    }
                    outsideTrigger.fill(.clear, style: FillStyle(eoFill: true))
                        .contentShape(outsideTrigger, eoFill: true)
                        .onTapGesture(perform: menu.dismiss)
                        .accessibilityHidden(true)
                    WebPositionedMenu(menu: menu, rect: rect, width: width, left: left, viewport: geometry.size)
                }
            }
        }
    }
}

/// Fit menus above or below their trigger and scroll when interface zoom exceeds the window.
private struct WebPositionedMenu: View {
    let menu: WebTitleBarPopover
    let rect: CGRect
    let width: CGFloat
    let left: CGFloat
    let viewport: CGSize
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        let margin = metrics.size(4)
        let gap = metrics.size(7)
        let below = max(0, viewport.height - rect.maxY - gap - margin)
        let above = max(0, rect.minY - gap - margin)
        let opensBelow = contentHeight <= below || below >= above
        let height = min(contentHeight, opensBelow ? below : above)
        ScrollView {
            menu.content
                .frame(width: width)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .webScrollStyle()
        .frame(width: width, height: height)
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(15), y: metrics.size(7))
        .accessibilityIdentifier("chrome.web.popover")
        .onExitCommand(perform: menu.dismiss)
        .position(x: left + width / 2,
                  y: opensBelow ? rect.maxY + gap + height / 2 : rect.minY - gap - height / 2)
    }
}
