import AletheDesign
import AletheModel
import SwiftUI

/// `TitleBar/index.tsx` and `TitleBar.module.css`, with the system traffic lights retained.
struct WebTitleBar: View {
    @Binding var sidebarVisible: Bool
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.openSettings) private var openSettings
    @State private var showsNews = false
    @State private var accessoryWidth: CGFloat = 0

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: metrics.size(4)) {
                // The standard AppKit buttons are hosted above this reserved region.
                Color.clear.frame(width: metrics.size(72))
                Menu {
                    Button { environment.editorRequest = .newProject(.ungrouped) } label: { Label("menu.file.newProject", systemImage: "folder.badge.plus") }
                    Button { environment.editorRequest = .newGroup(parent: nil) } label: { Label("menu.file.newGroup", systemImage: "square.3.layers.3d") }
                    Button { environment.editorRequest = .newTerminal(nil) } label: { Label("menu.file.newTerminal", systemImage: "terminal") }
                    Divider()
                    Button { environment.showingHome = true } label: { Label("menu.view.showHome", systemImage: "house") }
                    Button { openSettings() } label: { Label("leftSidebar.preferences", systemImage: "gearshape") }
                } label: {
                    Image(systemName: "line.3.horizontal")
                        .resizable().scaledToFit()
                        .frame(width: metrics.size(14), height: metrics.size(14))
                }
                .buttonStyle(AletheIconButtonStyle(side: 28))
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: metrics.size(28), height: metrics.size(28))
                .accessibilityLabel(Text("chrome.mainMenu"))
                .accessibilityIdentifier("chrome.mainMenu")
                icon("sidebar.left", label: "chrome.toggleSidebar", id: "chrome.toggleSidebar", isOn: sidebarVisible, side: 32) {
                    sidebarVisible.toggle()
                }

            }
            .padding(.leading, metrics.size(6))
            .padding(.trailing, metrics.size(8))
            .fixedSize(horizontal: true, vertical: false)
            .overlay(alignment: .trailing) { theme[.border].frame(width: metrics.size(1)) }
            if let workspace = environment.workspace, !workspace.document.workspace.tabs.isEmpty {
                WorkspaceTabBar(workspace: workspace)
                    .layoutPriority(-1)
            } else {
                Spacer(minLength: metrics.size(12))
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: metrics.size(7)) {
                    HStack(spacing: metrics.size(4)) {
                        icon("newspaper", label: "chrome.whatsNew", id: "chrome.whatsNew", size: 13) { showsNews.toggle() }
                            .popover(isPresented: $showsNews) {
                            VStack(alignment: .leading, spacing: metrics.size(8)) {
                                Text("chrome.whatsNew").font(metrics.font(size: 13, weight: .semibold))
                                Text("chrome.news.chrome").font(metrics.font(size: 12))
                            }
                            .foregroundStyle(theme[.fg])
                            .padding(metrics.size(16))
                            .frame(width: metrics.size(300))
                        }
                        if shown(.sync) {
                            SyncToolbarItem()
                                .labelStyle(.iconOnly)
                                .font(metrics.font(size: 12))
                                .buttonStyle(AletheTitleBarPillStyle(iconOnly: true))
                        }
                        PomodoroToolbarPill()
                        if shown(.profile) {
                            ProfileToolbarMenu()
                                .labelStyle(.titleAndIcon)
                                .font(metrics.monoFont(size: 11, weight: .regular))
                                .padding(.horizontal, metrics.size(8))
                                .frame(maxWidth: metrics.size(180), minHeight: metrics.size(22))
                                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.size(8)))
                        }
                    }
                    HStack(spacing: metrics.size(4)) {
                        if shown(.usageClaude) { UsagePill(provider: .claude) }
                        if shown(.usageCodex) { UsagePill(provider: .codex) }
                        if shown(.usageAntigravity) { UsagePill(provider: .antigravity) }
                        if shown(.memory) { MemoryIndicator(webTitleBar: true) }

                        if shown(.router9) { Router9ToolbarItem() }
                    }
                    .buttonStyle(AletheTitleBarPillStyle())
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
            .padding(.leading, metrics.size(2))
            .padding(.trailing, metrics.size(6))
        }
        .foregroundStyle(theme[.fgMuted])
        .frame(height: metrics.size(40))
        .background(WindowDragRegion())
        .background(theme[.bgElevated])
        .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
        .accessibilityIdentifier("chrome.titleBar")
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

/// A one-point divider with the web's 19-point hit region and centered hover grip.
struct WebShellSeparator: View {
    @Binding var width: Double
    let limits: ClosedRange<Double>
    var trailing = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false
    @State private var initialWidth: Double?

    var body: some View {
        theme[hovering || initialWidth != nil ? .borderStrong : .border]
            .frame(width: metrics.size(1))
            .overlay {
                RoundedRectangle(cornerRadius: metrics.size(999))
                    .fill(theme[.borderStrong])
                    .frame(width: metrics.size(3), height: metrics.size(30))
                    .opacity(hovering || initialWidth != nil ? 1 : 0)
            }
            .overlay {
                Color.clear
                    .frame(width: metrics.size(19))
                    .contentShape(Rectangle())
                    .onHover { inside in
                        hovering = inside
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if initialWidth == nil { initialWidth = width }
                            let delta = value.translation.width / metrics.scale * (trailing ? -1 : 1)
                            width = min(limits.upperBound, max(limits.lowerBound, (initialWidth ?? width) + delta))
                        }
                        .onEnded { _ in initialWidth = nil })
            }
            .accessibilityLabel(Text(trailing ? "chrome.resizeRightSidebar" : "chrome.resizeLeftSidebar"))
            .accessibilityAdjustableAction { direction in
                width = min(limits.upperBound, max(limits.lowerBound, width + (direction == .increment ? 10 : -10)))
            }
    }
}
