import AletheDesign
import AletheDocuments
import AppKit
import SwiftUI

/// MarkdownRenderer.tsx uses MarkdownPane.module.css even inside the right sidebar.
struct MarkdownSidebarBody: View {
    let blocks: [MarkdownBlock]
    var nested = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownSidebarBlock(block: block, first: index == 0)
            }
        }
        .font(metrics.font(size: 14)).foregroundStyle(theme[.fg]).tint(theme[.accent])
        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, nested ? 0 : metrics.size(24))
        .padding(.vertical, nested ? 0 : metrics.size(20))
    }
}

private struct MarkdownSidebarBlock: View {
    let block: MarkdownBlock
    let first: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        switch block {
        case .heading(let level, let text):
            let size: CGFloat = level == 1 ? 23.8 : level == 2 ? 19.6 : level == 3 ? 16.52 : 14
            Text(text).font(metrics.font(size: size, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, level <= 2 ? metrics.size(size * 0.3) : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) {
                    if level <= 2 { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
                }
                .padding(.top, first ? 0 : metrics.size(size * 1.4))
                .padding(.bottom, metrics.size(size * 0.6))
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(inline(text)).font(metrics.font(size: 14)).lineSpacing(metrics.size(5))
                .fixedSize(horizontal: false, vertical: true).padding(.bottom, metrics.size(14))
        case .code(_, let source):
            ScrollView(.horizontal) {
                Text(verbatim: source).font(metrics.monoFont(size: 12)).lineSpacing(metrics.size(3))
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.vertical, metrics.size(12)).padding(.horizontal, metrics.size(14))
            }
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .padding(.bottom, metrics.size(14))
        case .quote(let blocks):
            MarkdownSidebarBody(blocks: blocks, nested: true)
                .foregroundStyle(theme[.fgMuted]).padding(.leading, metrics.size(14))
                .padding(.vertical, metrics.size(2.8))
                .overlay(alignment: .leading) { Rectangle().fill(theme[.borderStrong]).frame(width: metrics.size(3)) }
                .padding(.bottom, metrics.size(14))
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: metrics.size(3.5)) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: metrics.size(6)) {
                        if let checked = item.checkbox {
                            Image(systemName: checked ? "checkmark.square.fill" : "square")
                                .font(metrics.font(size: 14)).foregroundStyle(theme[checked ? .accent : .fgMuted])
                                .accessibilityLabel(Text((checked ? "markdown.task.done" : "markdown.task.open") as LocalizedStringKey))
                        } else {
                            Text(verbatim: ordered ? "\(start + index)." : "•").font(metrics.font(size: 14))
                        }
                        MarkdownSidebarBody(blocks: item.blocks, nested: true)
                    }
                }
            }.padding(.leading, metrics.size(22.4)).padding(.bottom, metrics.size(14))
        case .table(let header, _, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in tableCell(cell, header: true) }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in tableCell(cell, header: false) }
                        }
                    }
                }
            }.padding(.bottom, metrics.size(14))
        case .image(let source, let alt):
            Group {
                if let source, source.isFileURL, let image = NSImage(contentsOf: source) {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: metrics.size(image.size.width))
                } else if let source {
                    AsyncImage(url: source) { image in image.resizable().scaledToFit() } placeholder: {
                        Text(verbatim: alt).font(metrics.font(size: 14))
                    }
                } else { Text(verbatim: alt).font(metrics.font(size: 14)) }
            }
            .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .accessibilityLabel(Text(verbatim: alt)).padding(.bottom, metrics.size(14))
        case .rule:
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1)).padding(.vertical, metrics.size(22.4))
        case .html:
            EmptyView()
        }
    }

    private func inline(_ text: AttributedString) -> AttributedString {
        var result = text
        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
            result[run.range].font = metrics.monoFont(size: 12.32)
            result[run.range].backgroundColor = theme[.bgElevated]
        }
        return result
    }

    private func tableCell(_ text: AttributedString, header: Bool) -> some View {
        Text(inline(text)).font(metrics.font(size: 14, weight: header ? .semibold : .regular))
            .padding(.vertical, metrics.size(6)).padding(.horizontal, metrics.size(12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[.bgElevated].opacity(header ? 1 : 0))
            .overlay(Rectangle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}
