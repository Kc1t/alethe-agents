import AletheDesign
import AletheModel
import SwiftUI

/// `TitleBar/index.tsx` and `TitleBar.module.css`, with the system traffic lights retained.
struct WebTitleBar: View {
    @Binding var sidebarVisible: Bool
    /// AppKit coordinates are already in points; only the web gap scales with UI zoom.
    let trafficLightTrailingEdge: CGFloat
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var showsNews = false
    @State private var showsMenu = false
    @State private var statusHovered = false
    @State private var accessoryWidth: CGFloat = 0

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: metrics.size(4)) {
                Button { showsMenu.toggle() } label: {
                    Image(systemName: "line.3.horizontal")
                        .resizable().scaledToFit()
                        .frame(width: metrics.size(14), height: metrics.size(14))
                }
                .buttonStyle(AletheIconButtonStyle(side: 28, isOn: showsMenu))
                .help(Text("chrome.mainMenu"))
                .accessibilityLabel(Text("chrome.mainMenu"))
                .accessibilityIdentifier("chrome.mainMenu")
                .webTitleBarPopover(isPresented: $showsMenu, width: 220, trailing: false) {
                    WebWindowMenu { showsMenu = false }
                }
                icon("sidebar.left", label: "chrome.toggleSidebar", id: "chrome.toggleSidebar", isOn: sidebarVisible, side: 28) {
                    sidebarVisible.toggle()
                }
                .help(Text(sidebarVisible ? "titlebar.sidebar.close" : "titlebar.sidebar.open"))

            }
            .padding(.leading, trafficLightTrailingEdge + metrics.size(6))
            .padding(.trailing, metrics.size(8))
            .fixedSize(horizontal: true, vertical: false)
            .overlay(alignment: .trailing) { theme[.border].frame(width: metrics.size(1)) }
            if let workspace = environment.workspace, !workspace.document.workspace.tabs.isEmpty {
                WorkspaceTabBar(workspace: workspace)
                    .layoutPriority(-1)
            }
            Spacer(minLength: metrics.size(12))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: metrics.size(7)) {
                    HStack(spacing: metrics.size(4)) {
                        icon("newspaper", label: "chrome.whatsNew", id: "chrome.whatsNew", size: 13) { showsNews.toggle() }
                        if shown(.sync) {
                            SyncToolbarItem()
                                .labelStyle(.iconOnly)
                                .font(metrics.font(size: 12))
                                .frame(width: metrics.size(26), height: metrics.size(22))
                                .buttonStyle(AletheTitleBarPillStyle(iconOnly: true))
                        }
                        if shown(.profile) {
                            ProfileToolbarMenu()
                                .labelStyle(.titleAndIcon)
                                .buttonStyle(AletheTitleBarPillStyle())
                                .frame(maxWidth: metrics.size(180))
                        }
                    }
                    HStack(spacing: metrics.size(4)) {
                        if shown(.usageClaude) { WebTitleBarUsagePill(provider: .claude) }
                        if shown(.usageCodex) { WebTitleBarUsagePill(provider: .codex) }
                        if shown(.usageAntigravity) { WebTitleBarUsagePill(provider: .antigravity) }
                        if shown(.memory) { WebTitleBarMemoryPill() }

                        if shown(.router9) { Router9ToolbarItem() }
                        Button { NotificationCenter.default.post(name: .aletheCustomizeTitleBar, object: nil) } label: {
                            Image(systemName: "pencil").resizable().scaledToFit()
                                .frame(width: metrics.size(12), height: metrics.size(12))
                        }
                        .buttonStyle(AletheIconButtonStyle(side: 24))
                        .frame(width: statusHovered ? metrics.size(24) : 0)
                        .opacity(statusHovered ? 1 : 0).clipped()
                        .help(Text("settings.toolbar"))
                        .accessibilityLabel(Text("settings.toolbar"))
                        .accessibilityIdentifier("chrome.customizeToolbar")
                    }
                    .buttonStyle(AletheTitleBarPillStyle())
                    .onHover { statusHovered = $0 }
                    .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: statusHovered)
                    .padding(.leading, metrics.size(8))
                    .overlay(alignment: .leading) { theme[.border].frame(width: metrics.size(1), height: metrics.size(24)) }
                }
                .fixedSize(horizontal: true, vertical: false)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { accessoryWidth = $0 }
            }
            .defaultScrollAnchor(.trailing)
            .frame(maxWidth: accessoryWidth > 0 ? accessoryWidth : nil)
            .layoutPriority(1)
            icon("sidebar.right", label: "menu.view.showRightSidebar", id: "chrome.toggleRightSidebar", isOn: environment.rightSidebarVisible) {
                environment.rightSidebarVisible.toggle()
            }
            .help(Text(environment.rightSidebarVisible ? "titlebar.right.close" : "titlebar.right.open"))
            .padding(.leading, metrics.size(8))
            .padding(.trailing, metrics.size(6))
        }
        .foregroundStyle(theme[.fgMuted])
        .frame(height: metrics.size(40))
        .background(WindowDragRegion())
        .background(theme[.bgElevated])
        .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
        .accessibilityIdentifier("chrome.titleBar")
        .preference(key: WebTitleBarNewsKey.self, value: showsNews)
        .onReceive(NotificationCenter.default.publisher(for: .aletheCloseTitleBarNews)) { _ in showsNews = false }
    }

    private func shown(_ item: ToolbarItemKind) -> Bool {
        (environment.preferences?.document ?? PreferencesDocument()).showsToolbarItem(item)
    }

    private func icon(_ symbol: String, label: LocalizedStringKey, id: String, isOn: Bool = false, size: CGFloat = 14, side: CGFloat = 28,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .resizable().scaledToFit()
                .frame(width: metrics.size(size), height: metrics.size(size))
        }
            .buttonStyle(AletheIconButtonStyle(side: side, isOn: isOn))
            .fixedSize()
            .help(Text(label))
            .accessibilityLabel(Text(label))
            .accessibilityIdentifier(id)
    }
}
