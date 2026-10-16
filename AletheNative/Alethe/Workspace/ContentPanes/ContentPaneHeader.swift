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

    var body: some View {
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
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.borderSubtle]).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.header.\(url.lastPathComponent)")
    }
}

/// An icon button in a file pane's header.
struct ContentPaneButton: View {
    let symbol: String
    let label: LocalizedStringKey
    let id: String
    let action: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(metrics.font(.caption).weight(.semibold))
                .frame(width: metrics.size(metrics.isWebInterface ? 20 : 18), height: metrics.size(metrics.isWebInterface ? 20 : 18))
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(theme[.textTertiary])
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }
}
