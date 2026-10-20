import AletheDesign
import AletheDocuments
import AletheModel
import AppKit
import SwiftUI

/// A Markdown pane (upstream `MarkdownPane`): the file rendered, reloaded when it changes on disk,
/// with refresh, copy source and edit / save / cancel added to the shared file-pane header.
struct MarkdownPaneView: View {
    let file: MarkdownFile
    let isFocused: Bool
    let onClose: () -> Void
    let onDrag: (CGSize?) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            ContentPaneHeader(symbol: "doc.richtext", url: file.url, isFocused: isFocused,
                              onClose: onClose, onDrag: onDrag) { actions }
            MarkdownFileContent(file: file)
        }
        .background(theme[.bg])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("markdown.pane")
    }

    // MARK: - Header actions

    @ViewBuilder
    private var actions: some View {
        if file.hasUnsavedChanges {
            Circle().fill(theme[.statusWaiting]).frame(width: metrics.size(6), height: metrics.size(6))
                .accessibilityLabel(Text("markdown.unsaved"))
        }
        Spacer(minLength: 0)
        if file.isEditing {
            ContentPaneButton(symbol: "checkmark", label: "markdown.save", id: "markdown.save", webSize: 22) { file.save() }
                .keyboardShortcut("s", modifiers: .command)
            ContentPaneButton(symbol: "xmark.circle", label: "markdown.cancelEdit", id: "markdown.cancelEdit", webSize: 22) {
                file.cancelEditing()
            }
        } else {
            ContentPaneButton(symbol: "arrow.clockwise", label: "markdown.refresh", id: "markdown.refresh", webSize: 22) { file.reload() }
            ContentPaneButton(symbol: copied ? "checkmark" : "doc.on.doc",
                              label: copied ? "markdown.copied" : "markdown.copySource", id: "markdown.copy", webSize: 22) { copySource() }
            ContentPaneButton(symbol: "pencil", label: "markdown.edit", id: "markdown.edit", webSize: 22) { file.beginEditing() }
                .disabled(file.loadError != nil)
        }
    }

    private func copySource() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(file.source, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// Shared file rendering and editing, used by panes and the Markdown inspector.
struct MarkdownFileContent: View {
    let file: MarkdownFile
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    // MARK: - Content

    @ViewBuilder
    var body: some View {
        if file.isEditing {
            VStack(spacing: 0) {
                if let error = file.saveError {
                    Text(verbatim: format("markdown.saveError", error))
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.statusStopped])
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(metrics.space(.s))
                }
                TextEditor(text: Bindable(file).draft)
                    .font(metrics.isWebInterface ? metrics.monoFont(size: 13) : metrics.font(.body).monospaced())
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, metrics.isWebInterface ? metrics.size(22) : metrics.space(.s))
                    .padding(.vertical, metrics.isWebInterface ? metrics.size(18) : metrics.space(.s))
                    .accessibilityIdentifier("markdown.editor")
            }
        } else if let error = file.loadError {
            VStack(spacing: metrics.space(.m)) {
                Text(verbatim: format("markdown.loadError", file.path))
                    .foregroundStyle(theme[.textPrimary])
                Text(verbatim: error)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                Button("markdown.refresh") { file.reload() }
            }
            .multilineTextAlignment(.center)
            .padding(metrics.space(.xl))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("markdown.error")
        } else {
            ScrollView {
                MarkdownBlocksView(blocks: file.blocks)
                    .padding(.horizontal, metrics.isWebInterface ? metrics.size(24) : metrics.space(.xl))
                    .padding(.vertical, metrics.isWebInterface ? metrics.size(20) : metrics.space(.xl))
                    .frame(maxWidth: metrics.isWebInterface ? .infinity : metrics.size(820), alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .webScrollStyle()
            .accessibilityIdentifier("markdown.rendered")
        }
    }

}
