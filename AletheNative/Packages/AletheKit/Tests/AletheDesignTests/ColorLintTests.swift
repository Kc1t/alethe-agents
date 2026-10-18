import Foundation
import Testing

/// Design-system lint (ADR-5): colors come only from theme tokens, and there are no gradients.
@Suite struct ColorLintTests {
    /// AletheNative/ (this file lives in AletheNative/Packages/AletheKit/Tests/AletheDesignTests/).
    static let root = URL(filePath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()

    static let colorConstructors = [
        "Color(red", "Color(.sRGB", "Color(hex", "#colorLiteral", "NSColor(red", "NSColor(srgbRed",
        "NSColor(calibratedRed", "NSColor(deviceRed", "CGColor(red", "CGColor(srgbRed",
    ]
    static let gradients = [
        "LinearGradient", "RadialGradient", "AngularGradient", "EllipticalGradient", "MeshGradient",
        ".gradient", "CAGradientLayer", "NSGradient",
    ]

    private static let colorConstructorPattern = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_])(?:"#
            + colorConstructors.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|") + ")")

    static func swiftSources() -> [URL] {
        let dirs = ["Alethe", "Packages/AletheKit/Sources"].map { root.appending(path: $0) }
        return dirs.flatMap { dir -> [URL] in
            let enumerator = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
            return (enumerator?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }
        }
    }

    @Test func sourcesAreFound() {
        #expect(Self.swiftSources().count > 3)
    }

    @Test func noColorLiteralsOutsideDesignModule() throws {
        let offenders = try Self.swiftSources()
            .filter { !$0.path.contains("/Sources/AletheDesign/") }
            .flatMap { url in
                try String(contentsOf: url, encoding: .utf8).split(separator: "\n").enumerated()
                    .filter { _, line in
                        let source = String(line)
                        return Self.colorConstructorPattern.firstMatch(in: source,
                            range: NSRange(source.startIndex..., in: source)) != nil
                    }
                    .map { "\(url.lastPathComponent):\($0.offset + 1)" }
            }
        #expect(offenders.isEmpty, "Color literals outside AletheDesign: \(offenders)")
    }

    @Test func noGradientsAnywhere() throws {
        let offenders = try Self.swiftSources().flatMap { url in
            try String(contentsOf: url, encoding: .utf8).split(separator: "\n").enumerated()
                .filter { _, line in Self.gradients.contains { line.contains($0) } }
                .map { "\(url.lastPathComponent):\($0.offset + 1)" }
        }
        #expect(offenders.isEmpty, "Gradients are not allowed: \(offenders)")
    }
}
