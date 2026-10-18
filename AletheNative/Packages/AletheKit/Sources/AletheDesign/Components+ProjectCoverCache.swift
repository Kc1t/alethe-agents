import AppKit
import CryptoKit
import Foundation
import ImageIO

/// Immutable decoded pixels can cross from the decoding actor to the UI.
public final class ProjectCoverPixels: @unchecked Sendable {
    public let image: CGImage
    init(_ image: CGImage) { self.image = image }
}

/// Shared by sidebar rows, editor previews, Home cards and tabs. Originals remain untouched.
public actor ProjectCoverCache {
    public static let shared = ProjectCoverCache()
    private let cache = NSCache<NSString, ProjectCoverPixels>()
    private var loading: [String: Task<ProjectCoverPixels?, Never>] = [:]

    public init() {
        cache.countLimit = 128
        cache.totalCostLimit = 16 * 1024 * 1024
    }

    public func image(source: String, pixelSize: Int) async -> ProjectCoverPixels? {
        guard !source.isEmpty else { return nil }
        let pixels = max(1, min(pixelSize, 1024))
        // Avoid retaining multi-megabyte data URLs as cache keys for tiny thumbnails.
        let digest = SHA256.hash(data: Data(source.utf8))
        let key = "\(pixels):\(digest)"
        if let cached = cache.object(forKey: key as NSString) { return cached }
        if let task = loading[key] { return await task.value }
        let task = Task { await self.load(source: source, pixels: pixels) }
        loading[key] = task
        let result = await task.value
        loading[key] = nil
        if let result {
            cache.setObject(result, forKey: key as NSString,
                            cost: result.image.bytesPerRow * result.image.height)
        }
        return result
    }

    private func load(source: String, pixels: Int) async -> ProjectCoverPixels? {
        let data: Data
        if source.hasPrefix("data:"), let comma = source.firstIndex(of: ",") {
            let header = source[..<comma]
            let body = String(source[source.index(after: comma)...])
            let decoded = header.hasSuffix(";base64") ? Data(base64Encoded: body) :
                body.removingPercentEncoding?.data(using: .utf8)
            guard let decoded else { return nil }
            data = decoded
        } else if let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
            guard let (downloaded, response) = try? await URLSession.shared.data(from: url),
                  let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            data = downloaded
        } else { return nil }
        return Self.decode(data, pixelSize: pixels)
    }

    static func decode(_ data: Data, pixelSize: Int) -> ProjectCoverPixels? {
        let pixels = max(1, min(pixelSize, 1024))
        if let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
           let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceCreateThumbnailWithTransform: true,
               kCGImageSourceShouldCacheImmediately: true,
               kCGImageSourceThumbnailMaxPixelSize: pixels
           ] as CFDictionary) {
            return ProjectCoverPixels(image)
        }
        // AppKit also understands vector formats such as SVG. Rasterize only at the requested size.
        guard let image = NSImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
        let ratio = min(CGFloat(pixels) / image.size.width, CGFloat(pixels) / image.size.height)
        let width = max(1, Int(ceil(image.size.width * ratio)))
        let height = max(1, Int(ceil(image.size.height * ratio)))
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                           isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        image.draw(in: NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)),
                   from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.cgImage.map(ProjectCoverPixels.init)
    }
}
