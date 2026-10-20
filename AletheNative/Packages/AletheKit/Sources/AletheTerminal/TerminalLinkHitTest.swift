import AletheDesign
import AppKit

/// Web link hit testing against the renderer's visible rows. The wrapper exposes row text but
/// not soft-wrap flags; full-width rows are joined until the first short row.
@MainActor
final class TerminalLinkHighlightView: NSView {
    var rectangles: [CGRect] = []
    var color: NSColor = .clear
    var thickness: CGFloat = 1

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func resetCursorRects() {
        for rect in rectangles { addCursorRect(rect, cursor: .pointingHand) }
    }

    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        for rect in rectangles {
            CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: thickness).fill()
        }
    }
}

extension TerminalPaneView {
    /// Pointer in window coordinates. Reading on demand also handles scrolled-back output.
    public func webLink(at point: CGPoint) -> (link: DetectedTerminalLink, rects: [CGRect])? {
        guard Self.inputMetrics()?.isWebInterface == true,
              let text = viewportText(), gridSize.columns > 0, gridSize.rows > 0 else { return nil }
        let local = terminalView.convert(point, from: nil)
        guard terminalView.bounds.contains(local) else { return nil }
        let columns = Int(gridSize.columns)
        let rows = text.components(separatedBy: "\n")
        let scale = window?.backingScaleFactor ?? 1
        let cellWidth = linkGrid.map { CGFloat($0.cellWidthPixels) / scale }
            ?? terminalView.bounds.width / CGFloat(columns)
        let cellHeight = linkGrid.map { CGFloat($0.cellHeightPixels) / scale }
            ?? terminalView.bounds.height / CGFloat(gridSize.rows)
        guard cellWidth > 0, cellHeight > 0 else { return nil }
        let topY = terminalView.isFlipped ? local.y : terminalView.bounds.height - local.y
        let row = Int(topY / cellHeight)
        guard rows.indices.contains(row) else { return nil }
        let buffer = rows.enumerated().map { index, text in
            TerminalLinks.Row(text, isWrapped: index > 0 && Self.cellWidth(of: rows[index - 1]) == columns)
        }
        guard let line = TerminalLinks.logicalLine(buffer, lineNumber: row + 1) else { return nil }
        let start = line.startLine - 1
        let logical = line.text
        // UTF-16 offsets are converted to display cells before comparing with pointer positions.
        let hitCell = (row - start) * columns + Int(local.x / cellWidth)
        for link in TerminalLinks.detect(logical) {
            let string = logical as NSString
            let before = string.substring(to: link.index)
            let display = string.substring(with: NSRange(location: link.index, length: link.displayLength))
            let first = Self.cellWidth(of: before)
            let last = first + Self.cellWidth(of: display)
            guard hitCell >= first, hitCell < last else { continue }
            var rectangles: [CGRect] = []
            for offset in (first / columns)...((last - 1) / columns) {
                let left = max(first, offset * columns) - offset * columns
                let right = min(last, (offset + 1) * columns) - offset * columns
                let y = terminalView.isFlipped ? CGFloat(start + offset) * cellHeight
                    : terminalView.bounds.height - CGFloat(start + offset + 1) * cellHeight
                let rect = CGRect(x: CGFloat(left) * cellWidth, y: y,
                                  width: CGFloat(right - left) * cellWidth, height: cellHeight)
                rectangles.append(convert(rect, from: terminalView))
            }
            return (link, rectangles)
        }
        return nil
    }

    private static func cellWidth(of text: String) -> Int {
        text.reduce(0) { width, character in
            let scalar = character.unicodeScalars.first?.value ?? 0
            let wide = character.unicodeScalars.contains { $0.properties.isEmojiPresentation }
                || (0x1100...0x115f).contains(scalar) || (0x2e80...0xa4cf).contains(scalar)
                || (0xac00...0xd7a3).contains(scalar) || (0xf900...0xfaff).contains(scalar)
                || (0xff01...0xff60).contains(scalar) || (0x20000...0x3ffff).contains(scalar)
            return width + (wide ? 2 : 1)
        }
    }

    public func highlightWebLink(at point: CGPoint?) {
        guard Self.inputMetrics()?.isWebInterface == true else {
            linkHighlight.rectangles = []
            linkHighlight.needsDisplay = true
            return
        }
        let hit = point.flatMap { webLink(at: $0) }
        hoveredLink = hit?.link.target
        linkHighlight.frame = bounds
        linkHighlight.rectangles = hit?.rects ?? []
        linkHighlight.needsDisplay = true
        window?.invalidateCursorRects(for: linkHighlight)
    }
}
