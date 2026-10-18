import AletheDesign
import AppKit
import SwiftUI

/// Bounded object-fit: cover image with the same fallback during loading and on failure.
struct SidebarCoverImage<Fallback: View>: View {
    let source: String
    let side: CGFloat
    var cornerRadius: CGFloat? = nil
    @ViewBuilder let fallback: () -> Fallback
    @Environment(\.metrics) private var metrics
    @Environment(\.displayScale) private var displayScale
    @State private var loaded: NSImage?
    @State private var loadedSource: String?

    private struct Request: Equatable {
        let source: String
        let pixels: Int
    }

    var body: some View {
        Group {
            if loadedSource == source, let loaded {
                Image(nsImage: loaded).resizable().aspectRatio(contentMode: .fill)
            } else {
                fallback()
            }
        }
        .frame(width: metrics.size(side), height: metrics.size(side))
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius.map { metrics.size($0) } ?? metrics.radius(.sm)))
        .accessibilityHidden(true)
        .task(id: Request(source: source, pixels: Int(ceil(metrics.size(side) * displayScale)))) {
            loaded = nil
            loadedSource = nil
            if source.hasPrefix("http://") || source.hasPrefix("https://") {
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else { return }
            }
            let decoded = await ProjectCoverCache.shared.image(
                source: source, pixelSize: Int(ceil(metrics.size(side) * displayScale)))
            guard !Task.isCancelled else { return }
            loaded = decoded.map { NSImage(cgImage: $0.image, size: .zero) }
            loadedSource = source
        }
    }
}
