import AppKit
import ImageIO
import Testing
@testable import AletheDesign

@Suite struct ProjectCoverCacheTests {
    private func png() throws -> Data {
        let context = try #require(CGContext(data: nil, width: 512, height: 256, bitsPerComponent: 8,
                                            bytesPerRow: 512 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try #require(context.makeImage())
        let bytes = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return bytes as Data
    }

    @Test func thumbnailsAreDownsampledAndKeepTheirAspectRatio() throws {
        let decoded = try #require(ProjectCoverCache.decode(png(), pixelSize: 64))
        #expect(decoded.image.width == 64)
        #expect(decoded.image.height == 32)
    }

    @Test func repeatedRequestsShareDecodedPixels() async throws {
        let source = "data:image/png;base64,\(try png().base64EncodedString())"
        let cache = ProjectCoverCache()
        async let first = cache.image(source: source, pixelSize: 32)
        async let second = cache.image(source: source, pixelSize: 32)
        let (one, two) = await (first, second)
        let image = try #require(one)
        #expect(image === two)
        let larger = try #require(await cache.image(source: source, pixelSize: 64))
        #expect(larger.image.width == 64)
    }

    @Test func invalidImagesUseTheFallback() async {
        let cache = ProjectCoverCache()
        #expect(await cache.image(source: "", pixelSize: 44) == nil)
        #expect(await cache.image(source: "data:image/png;base64,broken!", pixelSize: 44) == nil)
        #expect(ProjectCoverCache.decode(Data("not an image".utf8), pixelSize: 44) == nil)
    }
}
