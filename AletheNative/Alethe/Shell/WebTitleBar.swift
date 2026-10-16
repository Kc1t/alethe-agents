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

    var body: some View {
        HStack(spacing: 0) {
            // AppKit owns the traffic lights; reserve their hit region.
            Color.clear.frame(width: metrics.size(72))
            HStack(spacing: metrics.size(4)) {
                Menu {
                    Button("menu.file.newProject") { environment.editorRequest = .newProject(.ungrouped) }
                    Button("menu.file.newGroup") { environment.editorRequest = .newGroup(parent: nil) }
                    Button("menu.file.newTerminal") { environment.editorRequest = .newTerminal(nil) }
                    Divider()
                    Button("menu.view.showHome") { environment.showingHome = true }
                    Button("leftSidebar.preferences") { openSettings() }
                } label: {
                    Image(systemName: "line.3.horizontal").font(metrics.font(size: 14))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: metrics.size(28), height: metrics.size(28))
                .accessibilityLabel(Text("chrome.mainMenu"))
                .accessibilityIdentifier("chrome.mainMenu")
                icon("sidebar.left", label: "chrome.toggleSidebar", id: "chrome.toggleSidebar", isOn: sidebarVisible) {
                    sidebarVisible.toggle()
                }
                icon("newspaper", label: "chrome.whatsNew", id: "chrome.whatsNew") { showsNews.toggle() }
                    .popover(isPresented: $showsNews) {
                        VStack(alignment: .leading, spacing: metrics.size(8)) {
                            Text("chrome.whatsNew").font(metrics.font(size: 13, weight: .semibold))
                            Text("chrome.news.chrome").font(metrics.font(size: 12))
                        }
                        .foregroundStyle(theme[.fg])
                        .padding(metrics.size(16))
                        .frame(width: metrics.size(300))
                    }
                HStack(spacing: metrics.size(5)) {
                    Text(verbatim: "A")
                        .font(metrics.font(size: 10, weight: .heavy))
                        .foregroundStyle(theme[.accent])
                        .frame(width: metrics.size(17), height: metrics.size(17))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(5))
                            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
                    Text(verbatim: "Alethe")
                        .font(metrics.font(size: 12, weight: .semibold))
                        .tracking(metrics.size(0.24))
                }
                .foregroundStyle(theme[.fg])
                .padding(.leading, metrics.size(6))
            }
            .padding(.trailing, metrics.size(8))
            .overlay(alignment: .trailing) { theme[.border].frame(width: metrics.size(1)) }
            if let workspace = environment.workspace {
                WorkspaceTabBar(workspace: workspace)
                    .padding(.leading, metrics.size(2))
                    .layoutPriority(-1)
            } else {
                Spacer(minLength: metrics.size(12))
            }
            HStack(spacing: metrics.size(7)) {
                HStack(spacing: metrics.size(4)) {
                    if shown(.sync) {
                        SyncToolbarItem()
                            .labelStyle(.iconOnly)
                            .buttonStyle(AletheTitleBarPillStyle(iconOnly: true))
                    }
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
                    if shown(.memory) { MemoryIndicator() }
                    if shown(.pomodoro) { PomodoroToolbarPill() }
                    if shown(.notifications) {
                        NotificationsButton().buttonStyle(AletheIconButtonStyle(side: 28))
                    }
                    if shown(.remote) { RemoteToolbarItem() }
                    if shown(.router9) { Router9ToolbarItem() }
                    if shown(.aiUsage) { AIUsageButton().labelStyle(.iconOnly) }
                }
                .buttonStyle(AletheTitleBarPillStyle())
                .padding(.leading, metrics.size(8))
                .overlay(alignment: .leading) { theme[.border].frame(width: metrics.size(1), height: metrics.size(24)) }
            }
            .fixedSize(horizontal: true, vertical: false)
            icon("sidebar.right", label: "menu.view.showRightSidebar", id: "chrome.toggleRightSidebar", isOn: environment.rightSidebarVisible) {
                environment.rightSidebarVisible.toggle()
            }
            .padding(.leading, metrics.size(2))
        }
        .foregroundStyle(theme[.fgMuted])
        .padding(.horizontal, metrics.size(6))
        .frame(height: metrics.size(32))
        .background(theme[.bgElevated])
        .background(WindowDragRegion())
        .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
        .accessibilityIdentifier("chrome.titleBar")
    }

    private func shown(_ item: ToolbarItemKind) -> Bool {
        (environment.preferences?.document ?? PreferencesDocument()).showsToolbarItem(item)
    }

    private func icon(_ symbol: String, label: LocalizedStringKey, id: String, isOn: Bool = false,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(metrics.font(size: 14)) }
            .buttonStyle(AletheIconButtonStyle(side: 28, isOn: isOn))
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
