import AletheDesign
import SwiftUI

/// TodoSidebar.module.css: projectInputWrap and projectLink hover/focus surfaces.
struct WebTodoChoiceSurface: ViewModifier {
    let compact: Bool
    let state: WebDropdownTriggerState
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        let active = state.hovering || state.focused
        let radius = metrics.style == .clean ? metrics.size(4) : metrics.radius(.sm)
        content
            .background(theme[.bgSunken].opacity(metrics.style == .clean ? 0 : compact && !active ? 0.72 : 1),
                        in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius)
                .strokeBorder(theme[!compact && state.focused ? .borderStrong : .border]
                    .opacity(compact && !active ? 0 : 1), lineWidth: metrics.size(1)))
            .overlay {
                if !compact && state.focused && metrics.style != .clean {
                    RoundedRectangle(cornerRadius: radius + metrics.size(2))
                        .strokeBorder(theme[.accentRing], lineWidth: metrics.size(2)).padding(-metrics.size(2))
                }
            }
    }
}
