import AletheDesign
import SwiftUI

/// Changes to a mounted panel animate; restoring a window never animates its initial layout.
struct SidebarPanelMotion: ViewModifier {
    let identity: String
    @Environment(\.metrics) private var metrics
    @State private var initialIdentity: String?

    func body(content: Content) -> some View {
        content
            .id(identity)
            .transition(.asymmetric(
                insertion: .offset(y: metrics.size(5)).combined(with: .opacity),
                removal: .opacity
            ))
            .animation(initialIdentity == nil ? nil : Motion.SidebarEffect.panel.animation(
                reduceMotion: metrics.reducesMotion), value: identity)
            .onAppear { initialIdentity = identity }
    }
}

/// Status and menu share a grid cell, as in `.rowEndSlot`; hover never removes the status view.
struct SidebarRowEndSlot<Status: View, Action: View>: View {
    let active: Bool
    let hovering: Bool
    let status: Status
    let action: Action
    @Environment(\.metrics) private var metrics

    init(active: Bool, hovering: Bool, @ViewBuilder status: () -> Status,
         @ViewBuilder action: () -> Action) {
        self.active = active
        self.hovering = hovering
        self.status = status()
        self.action = action()
    }

    var body: some View {
        ZStack {
            status
                .opacity(hovering ? 0 : 1)
                .animation(Motion.SidebarEffect.status.animation(reduceMotion: metrics.reducesMotion), value: hovering)
                .allowsHitTesting(!hovering)
                .accessibilityHidden(hovering)
            action
                .opacity(hovering ? 1 : 0)
                .animation(nil, value: hovering)
                .allowsHitTesting(hovering)
                .accessibilityHidden(!hovering)
        }
        .frame(width: metrics.size(hovering ? 20 : active ? 16 : 0), height: metrics.size(20))
        .animation(Motion.SidebarEffect.rowSlot.animation(reduceMotion: metrics.reducesMotion), value: hovering)
        .animation(Motion.SidebarEffect.rowSlot.animation(reduceMotion: metrics.reducesMotion), value: active)
    }
}

/// UserProfile.module.css `pop` / visual-clean.css `cleanPopoverIn`, without zoom transforms.
struct SidebarProfilePopoverMotion: ViewModifier {
    @Environment(\.metrics) private var metrics
    @State private var appeared = false

    func body(content: Content) -> some View {
        content
            .opacity(appeared || metrics.reducesMotion ? 1 : 0)
            .offset(y: metrics.size(appeared || metrics.reducesMotion ? 0 : 4))
            .onAppear {
                withAnimation((metrics.style == .clean ? Motion.SidebarEffect.cleanPopover : .profilePopover)
                    .animation(reduceMotion: metrics.reducesMotion)) { appeared = true }
            }
    }
}

struct SidebarQuickNavigationMotion: ViewModifier {
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .animation(Motion.SidebarEffect.quickNavigation.animation(
                reduceMotion: metrics.reducesMotion, clean: metrics.style == .clean), value: hovering)
            .onHover { hovering = $0 }
    }
}
