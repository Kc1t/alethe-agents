import SwiftUI

extension Image {
    /// Give web artwork explicit layout bounds without changing the native interface's image path.
    public func webProfileSized(_ size: CGFloat) -> some View {
        WebProfileImage(image: self, size: size)
    }
}

private struct WebProfileImage: View {
    let image: Image
    let size: CGFloat
    @Environment(\.metrics) private var metrics

    @ViewBuilder var body: some View {
        if metrics.isWebInterface {
            image.resizable().aspectRatio(contentMode: .fit)
                .frame(width: metrics.size(size), height: metrics.size(size))
        } else {
            image
        }
    }
}

/// Flat profile rows use the web menu's padding, hover fill and small radius.
public struct AletheProfileMenuStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        ProfileMenuRow(configuration: configuration)
    }
}

private struct ProfileMenuRow: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        configuration.label
            .font(metrics.font(size: metrics.style == .clean ? 12 : 13))
            .foregroundStyle(theme[.fg])
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, metrics.size(metrics.style == .clean ? 8 : 10))
            .padding(.vertical, metrics.size(metrics.style == .clean ? 0 : 7))
            .frame(minHeight: metrics.size(28))
            .contentShape(Rectangle())
            .background(theme[.panelHover].opacity(hovering || configuration.isPressed ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .onHover { hovering = $0 }
    }
}

/// SwiftUI's automatic label style reserves native icon spacing; web rows use an eight-point gap.
public struct AletheProfileMenuLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(8)) {
            configuration.icon
            configuration.title
        }
    }
}
