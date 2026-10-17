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

extension View {
    func webTitleBarPopover<Content: View>(isPresented: Binding<Bool>, width: CGFloat, trailing: Bool = true,
                                          @ViewBuilder content: @escaping () -> Content) -> some View {
        anchorPreference(key: WebTitleBarPopoverKey.self, value: .bounds) { anchor in
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
                    menu.content
                        .frame(width: width)
                        .fixedSize(horizontal: false, vertical: true)
                        .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(15), y: metrics.size(7))
                        .onExitCommand(perform: menu.dismiss)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .offset(x: left, y: rect.maxY + metrics.size(7))
                }
            }
        }
    }
}
