import AletheDesign
import AletheTerminal
import SwiftUI

/// Find bar over a terminal's top trailing corner (⌘F): search as you type, match position, previous
/// and next (↩ / ⇧↩, ⌘G / ⇧⌘G), Esc to close. Ghostty matches case-insensitively and highlights every
/// match; this bar only drives it.
struct TerminalFindBar: View {
    let terminal: TerminalPaneView
    @State private var text = ""
    @FocusState private var fieldFocused: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var search: TerminalSearch { terminal.search }

    var body: some View {
        HStack(spacing: metrics.space(.xs)) {
            Image(systemName: "magnifyingglass").webProfileSized(14)
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
            TextField(text: $text) { Text("find.placeholder") }
                .textFieldStyle(.plain)
                .font(metrics.font(.body))
                .focused($fieldFocused)
                .frame(minWidth: metrics.size(120))
                .onSubmit { terminal.searchNext() }
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.shift) else { return .ignored }
                    terminal.searchPrevious()
                    return .handled
                }
                .onKeyPress(.escape) {
                    terminal.closeSearch()
                    return .handled
                }
                .onChange(of: text) { _, value in
                    if value != search.needle { terminal.updateSearch(value, resetProgress: metrics.isWebInterface) }
                }
                .accessibilityIdentifier("find.field")
            Text(verbatim: statusText)
                .font(metrics.font(.caption).monospacedDigit())
                .foregroundStyle(search.status == .noResults ? theme[.statusStopped] : theme[.textSecondary])
                .lineLimit(1)
                .fixedSize()
                .id(statusText)
                .accessibilityIdentifier("find.status")
            button("chevron.up", label: "find.previous", id: "find.previous") { terminal.searchPrevious() }
            button("chevron.down", label: "find.next", id: "find.next") { terminal.searchNext() }
            button("xmark", label: "find.close", id: "find.close") { terminal.closeSearch() }
        }
        .padding(.horizontal, metrics.space(.m))
        .padding(.vertical, metrics.space(.xs))
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border]))
        .shadow(color: metrics.isWebInterface
                ? (metrics.style == .clean ? .clear : theme.shadow(.md).color.color) : .black.opacity(0.18),
                radius: metrics.isWebInterface ? metrics.size(8) : 8,
                y: metrics.isWebInterface ? metrics.size(2) : 2)
        .onAppear {
            text = search.needle
            fieldFocused = true
        }
        .onChange(of: search.focusRequest) { _, _ in fieldFocused = true }
        // A search started by Ghostty (⌘E, search selection) fills the field.
        .onChange(of: search.needle) { _, needle in if needle != text { text = needle } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("find.bar")
    }

    private var statusText: String {
        switch search.status {
        case .none: ""
        case .noResults: String(localized: "find.noResults")
        case .match(let position, let total): format("find.position", position, total)
        case .count(let total): format("find.count", total)
        }
    }

    private func button(_ symbol: String, label: LocalizedStringKey, id: String,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).webProfileSized(20)
                .font(metrics.font(.caption).weight(.semibold))
                .frame(width: metrics.size(20), height: metrics.size(20))
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(theme[.textSecondary])
        .disabled(id != "find.close" && (search.total ?? 0) == 0)
        .help(Text(label))
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }
}
