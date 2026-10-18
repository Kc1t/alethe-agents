import AletheModel
import AletheDesign
import AppKit
import SwiftUI

/// Title bar of a file pane (Markdown, image, video): icon, file name, the pane's own actions, Show in
/// Finder and Close. Dragging it reorders the pane, like a terminal's header.
struct ContentPaneHeader<Actions: View>: View {
    let symbol: String
    let url: URL
    let isFocused: Bool
    let onClose: () -> Void
    let onDrag: (CGSize?) -> Void
    @ViewBuilder let actions: () -> Actions
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.contentPaneID) private var paneID
    @State private var confirmingClose = false

    var body: some View {
        if metrics.isWebInterface {
            webHeader
        } else {
            nativeHeader
        }
    }

    private var nativeHeader: some View {
        HStack(spacing: metrics.space(.s)) {
            Image(systemName: symbol)
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textSecondary])
            Text(verbatim: url.lastPathComponent)
                .font(metrics.font(.footnote).weight(.medium))
                .foregroundStyle(theme[isFocused ? .textPrimary : .textSecondary])
                .lineLimit(1)
                .help(Text(verbatim: url.path))
            actions()
            ContentPaneButton(symbol: "folder", label: "markdown.revealInFinder", id: "pane.reveal") {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            ContentPaneButton(symbol: "xmark", label: "markdown.close", id: "pane.close", action: onClose)
        }
        .padding(.horizontal, metrics.space(.m))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .frame(height: metrics.size(metrics.isWebInterface ? 26 : 28))
        .background(theme[metrics.isWebInterface || isFocused ? .bgElevated : .bgSunken])
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 4, coordinateSpace: .global)
                .onChanged { onDrag($0.translation) }
                .onEnded { _ in onDrag(nil) }
        )
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.header.\(url.lastPathComponent)")
    }

    private var media: Bool { symbol == "photo" || symbol == "film" }
    private var diff: Bool { symbol == "plusminus" }
    private var graph: Bool { symbol == "point.3.connected.trianglepath.dotted" }
    private var inFocusMode: Bool { paneID != nil && environment.focusModePaneID == paneID }

    private var webHeader: some View {
        HStack(spacing: metrics.size(8)) {
            if !inFocusMode {
                Image(systemName: "line.3.horizontal.decrease")
                    .font(metrics.font(size: 12))
                    .foregroundStyle(theme[.fgMuted])
                    .frame(width: metrics.size(23), height: metrics.size(23))
                    .gesture(DragGesture(minimumDistance: 4, coordinateSpace: .global)
                        .onChanged { onDrag($0.translation) }.onEnded { _ in onDrag(nil) })
            }
            if !media {
                Image(systemName: symbol).font(metrics.font(size: 16))
                    .frame(width: metrics.size(18), height: metrics.size(18))
                    .foregroundStyle(theme[.fg])
            }
            Text(verbatim: url.lastPathComponent)
                .font(metrics.font(size: media ? 11 : diff || graph ? 13 : 12,
                                   weight: media || graph ? .semibold : .medium))
                .foregroundStyle(theme[diff ? .fgMuted : .fg])
                .lineLimit(1)
                .help(Text(verbatim: url.path))
            Text(verbatim: shortPath)
                .font(metrics.monoFont(size: media ? 10 : diff ? 11 : 10, weight: media ? .regular : .medium))
                .foregroundStyle(theme[.fgFaint])
                .lineLimit(1)
                .help(Text(verbatim: url.path))
                .padding(.horizontal, metrics.size(media ? 0 : 7))
                .padding(.vertical, metrics.size(media ? 0 : 1))
                .frame(maxWidth: media ? nil : metrics.size(240))
                .background(theme[.bgElevated], in: Capsule())
                .overlay { if !media { Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)) } }
            actions()
            ContentPaneButton(symbol: "folder", label: "markdown.revealInFinder", id: "pane.reveal", webSize: media ? 23 : 22) {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            if let paneID {
                ContentPaneButton(symbol: inFocusMode ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                  label: inFocusMode ? "focusMode.exit" : "paneGroup.focus", id: "pane.focus", webSize: media ? 23 : 22) {
                    environment.focusModePaneID = inFocusMode ? nil : paneID
                }
            }
            ContentPaneButton(symbol: "trash", label: "markdown.close", id: "pane.close", webSize: media ? 23 : 22) {
                confirmingClose = true
            }
        }
        .padding(.leading, metrics.size(media ? 5 : diff || graph ? 12 : 8))
        .padding(.trailing, metrics.size(media ? 7 : diff || graph ? 12 : 8))
        .frame(height: metrics.size(diff || graph ? 36 : 32))
        .background(theme[media ? .bgElevated : .shapeTabsLaneBg])
        .overlay(alignment: .bottom) { Rectangle().fill(theme[media ? .border : .shapeTabsLaneBorder]).frame(height: metrics.size(1)) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.header.\(url.lastPathComponent)")
        .alert("markdown.close", isPresented: $confirmingClose) {
            Button("editor.cancel", role: .cancel) {}
            Button("markdown.close", role: .destructive) {
                if inFocusMode { environment.focusModePaneID = nil }
                onClose()
            }
        } message: {
            Text(verbatim: format("paneGroup.confirmClose", url.lastPathComponent))
        }
    }

    private var shortPath: String {
        let parts = url.pathComponents
        return parts.count <= 2 ? url.path : "…/" + parts.suffix(2).joined(separator: "/")
    }

}

/// An icon button in a file pane's header.
struct ContentPaneButton: View {
    let symbol: String
    let label: LocalizedStringKey
    let id: String
    var webSize: CGFloat = 23
    var webIconSize: CGFloat = 12
    let action: () -> Void
    @State private var hovered = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(metrics.isWebInterface ? metrics.font(size: webIconSize) : metrics.font(.caption).weight(.semibold))
                .frame(width: metrics.size(metrics.isWebInterface ? webSize : 18), height: metrics.size(metrics.isWebInterface ? webSize : 18))
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(theme[metrics.isWebInterface ? (hovered ? (symbol == "trash" ? .statusOffline : .fg) : .fgMuted) : .textTertiary])
        .background {
            if metrics.isWebInterface && hovered {
                RoundedRectangle(cornerRadius: metrics.radius(.sm)).fill(theme[.panelHover])
            }
        }
        .onHover { hovered = $0 }
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }
}

private struct ContentPaneIDKey: EnvironmentKey {
    static let defaultValue: PaneID? = nil
}

extension EnvironmentValues {
    var contentPaneID: PaneID? {
        get { self[ContentPaneIDKey.self] }
        set { self[ContentPaneIDKey.self] = newValue }
    }
}
