import AletheDesign
import AletheDocuments
import AppKit
import SwiftUI

/// Lays out parsed Markdown with the theme's tokens. Text is selectable; links open through the
/// environment's `openURL` (browser, or the default app for local files).
struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        switch block {
        case .heading(let level, let text):
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                Text(text)
                    .font(headingFont(level))
                    .foregroundStyle(theme[.textPrimary])
                if level <= 2 { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
            }
            .padding(.top, level <= 2 ? metrics.space(.s) : 0)
            .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(text)
                .font(metrics.isWebInterface ? metrics.font(size: 14) : metrics.font(.body))
                .foregroundStyle(theme[.textPrimary])
                .lineSpacing(metrics.isWebInterface ? metrics.size(9.1) : metrics.space(.xxs))
                .fixedSize(horizontal: false, vertical: true)
        case .image(let source, let alt):
            MarkdownImage(source: source, alt: alt)
        case .code(_, let code):
            ScrollView(.horizontal) {
                Text(verbatim: code)
                    .font(metrics.font(.body).monospaced())
                    .foregroundStyle(theme[.textPrimary])
                    .padding(metrics.space(.m))
            }
            .webScrollStyle()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.borderSubtle]))
        case .html(let html):
            Text(verbatim: html)
                .font(metrics.font(.body).monospaced())
                .foregroundStyle(theme[.textSecondary])
        case .quote(let blocks):
            HStack(alignment: .top, spacing: metrics.space(.m)) {
                Rectangle().fill(theme[.borderStrong]).frame(width: metrics.size(3))
                MarkdownBlocksView(blocks: blocks)
                    .foregroundStyle(theme[.textSecondary])
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: metrics.space(.s)) {
                        marker(ordered: ordered, number: start + index, checkbox: item.checkbox)
                        MarkdownBlocksView(blocks: item.blocks)
                    }
                }
            }
        case .table(let header, let alignments, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                            tableCell(cell, alignment: alignments[column], header: true)
                        }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                                tableCell(cell, alignment: alignments[column], header: false)
                            }
                        }
                    }
                }
                .overlay(Rectangle().strokeBorder(theme[.border]))
            }
            .webScrollStyle()
        case .rule:
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
        }
    }

    private func headingFont(_ level: Int) -> Font {
        if metrics.isWebInterface {
            let multiplier: CGFloat = level == 1 ? 1.7 : level == 2 ? 1.4 : level == 3 ? 1.18 : 1
            return metrics.font(size: 14 * multiplier, weight: .semibold)
        }
        return switch level {
        case 1: metrics.font(.title1)
        case 2: metrics.font(.title2)
        case 3: metrics.font(.title3)
        default: metrics.font(.headline)
        }
    }

    @ViewBuilder
    private func marker(ordered: Bool, number: Int, checkbox: Bool?) -> some View {
        if let checkbox {
            Image(systemName: checkbox ? "checkmark.square.fill" : "square")
                .foregroundStyle(theme[checkbox ? .accent : .textTertiary])
                .accessibilityLabel(Text(checkbox ? LocalizedStringKey("markdown.task.done") : "markdown.task.open"))
        } else if ordered {
            Text(verbatim: "\(number).")
                .font(metrics.font(.body).monospacedDigit())
                .foregroundStyle(theme[.textSecondary])
        } else {
            Text(verbatim: "•").foregroundStyle(theme[.textSecondary])
        }
    }

    private func tableCell(_ text: AttributedString, alignment: MarkdownColumnAlignment, header: Bool) -> some View {
        Text(text)
            .font(header ? metrics.font(.body).weight(.semibold) : metrics.font(.body))
            .foregroundStyle(theme[.textPrimary])
            .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .padding(.horizontal, metrics.space(.m))
            .padding(.vertical, metrics.space(.s))
            .frame(maxWidth: .infinity, alignment: alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .background(header ? theme[.bgElevated] : Color.clear)
            .overlay(Rectangle().strokeBorder(theme[.borderSubtle]))
    }
}

/// A local image loaded from disk, a remote one fetched; the description when it cannot be shown.
private struct MarkdownImage: View {
    let source: URL?
    let alt: String
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if let source, source.isFileURL, let image = NSImage(contentsOf: source) {
                Image(nsImage: image).resizable().scaledToFit()
                    .frame(maxWidth: image.size.width)
            } else if let source, !source.isFileURL {
                AsyncImage(url: source) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .accessibilityLabel(Text(verbatim: alt))
    }

    private var placeholder: some View {
        Label { Text(verbatim: alt.isEmpty ? (source?.lastPathComponent ?? "") : alt) } icon: {
            Image(systemName: "photo")
        }
        .font(metrics.font(.footnote))
        .foregroundStyle(theme[.textTertiary])
    }
}
