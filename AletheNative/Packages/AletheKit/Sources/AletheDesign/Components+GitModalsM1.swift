import SwiftUI

/// SidebarMergePanel.module.css actionBtn and its semantic action colors.
public struct AletheGitMergeActionStyle: ButtonStyle {
    let foreground: ThemeToken
    let background: ThemeToken
    let border: ThemeToken

    public init(foreground: ThemeToken = .accent, background: ThemeToken = .accentFaint,
                border: ThemeToken = .accentBorder) {
        self.foreground = foreground
        self.background = background
        self.border = border
    }

    public func makeBody(configuration: Configuration) -> some View {
        Action(configuration: configuration, foreground: foreground, background: background, border: border)
    }

    private struct Action: View {
        let configuration: ButtonStyleConfiguration
        let foreground: ThemeToken
        let background: ThemeToken
        let border: ThemeToken
        @Environment(\.metrics) private var metrics
        @Environment(\.theme) private var theme
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false
        var body: some View {
            configuration.label
                .font(metrics.font(size: 11, weight: .semibold)).lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(5))
                .foregroundStyle(theme[hovered ? .bg : foreground])
                .background(theme[hovered ? foreground : background], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[border], lineWidth: metrics.size(1)))
                .contentShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .opacity(enabled ? 1 : 0.45)
                .onHover { hovered = $0 && enabled }
                .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: hovered)
        }
    }
}
