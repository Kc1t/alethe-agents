// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "AletheSpeech",
    platforms: [.macOS(.v10_15)],
    products: [
        .library(name: "AletheSpeech", type: .static, targets: ["AletheSpeech"]),
    ],
    targets: [
        .target(
            name: "AletheSpeech",
            linkerSettings: [.linkedFramework("Speech"), .linkedFramework("AVFoundation")]
        ),
        .testTarget(name: "AletheSpeechTests", dependencies: ["AletheSpeech"]),
    ],
    swiftLanguageModes: [.v5]
)
