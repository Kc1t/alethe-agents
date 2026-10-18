import SwiftUI

/// agentActions.module.css `.installBtn` / `.linkBtn` / `.dangerBtn` / `.quietBtn`: the 28-point
/// action row used inside the install modals. Only colour tells the kinds apart.
public struct AletheInstallActionStyle: ButtonStyle {
    public enum Kind: Sendable { case primary, link, danger, quiet }
    let kind: Kind

    public init(_ kind: Kind = .link) { self.kind = kind }

    public func makeBody(configuration: Configuration) -> some View {
        InstallActionBody(configuration: configuration, kind: kind)
    }

    private struct InstallActionBody: View {
        let configuration: ButtonStyleConfiguration
        let kind: Kind
        @Environment(\.theme) private var theme
        @Environment(\.metrics) private var metrics
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            let hot = hovering && isEnabled
            let radius = metrics.radius(.sm)
            configuration.label
                .font(metrics.font(size: 12))
                .lineLimit(1)
                .foregroundStyle(foreground(hot))
                .padding(.horizontal, metrics.size(10))
                .frame(minWidth: metrics.size(96), minHeight: metrics.size(28))
                .background(background(hot), in: RoundedRectangle(cornerRadius: radius))
                .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(border(hot), lineWidth: metrics.size(1)))
                .contentShape(RoundedRectangle(cornerRadius: radius))
                .opacity(isEnabled ? 1 : 0.6)
                .onHover { hovering = $0 }
        }

        private func foreground(_ hot: Bool) -> Color {
            switch kind {
            case .primary: theme[.accentOn]
            case .link: theme[hot ? .fg : .fgMuted]
            case .danger: theme[hot ? .statusOffline : .fgMuted]
            case .quiet: theme[hot ? .fg : .fgMuted]
            }
        }

        private func background(_ hot: Bool) -> Color {
            switch kind {
            case .primary: theme[.accent]
            case .quiet: hot ? theme[.bgElevated] : .clear
            default: theme[.bg]
            }
        }

        private func border(_ hot: Bool) -> Color {
            switch kind {
            case .primary: theme[.accent]
            case .link: theme[hot ? .accent : .border]
            case .danger: theme[hot ? .statusOffline : .border]
            case .quiet: hot ? theme[.border] : .clear
            }
        }
    }
}
