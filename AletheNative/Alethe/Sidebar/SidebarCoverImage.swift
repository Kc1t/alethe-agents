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
    @State private var loaded: NSImage?
    @State private var loadedSource: String?

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
        .task(id: source) {
            loaded = nil
            loadedSource = nil
            let data: Data?
            if source.hasPrefix("data:"), let comma = source.firstIndex(of: ",") {
                let header = source[..<comma]
                let body = String(source[source.index(after: comma)...])
                data = header.hasSuffix(";base64") ? Data(base64Encoded: body) :
                    body.removingPercentEncoding?.data(using: .utf8)
            } else if let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                data = try? await URLSession.shared.data(from: url).0
            } else {
                data = nil
            }
            guard !Task.isCancelled else { return }
            loaded = data.flatMap(NSImage.init(data:))
            loadedSource = source
        }
    }
}
