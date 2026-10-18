import SwiftUI

/// CustomAgentsSection.module.css: fixed 28-point row actions and 32-point form actions.
public struct AletheCustomAgentButtonStyle: ButtonStyle {
    private let compact: Bool
    private let primary: Bool
    public init(compact: Bool = false, primary: Bool = false) { self.compact = compact; self.primary = primary }
    public func makeBody(configuration: Configuration) -> some View {
        CustomAgentButtonBody(configuration: configuration, compact: compact, primary: primary)
    }
}

private struct CustomAgentButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let compact: Bool
    let primary: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false
    var body: some View {
        configuration.label.font(metrics.font(size: compact ? 11 : 12))
            .foregroundStyle(theme[primary ? .accentOn : hovering ? .fg : .fgMuted])
            .padding(.horizontal, metrics.size(compact ? 10 : 14))
            .frame(height: metrics.size(compact ? 28 : 32))
            .background(theme[primary ? .accent : .panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[primary ? .accent : hovering ? .borderStrong : .border], lineWidth: metrics.size(1)))
            .opacity(enabled ? 1 : 0.6).onHover { hovering = $0 && enabled }
    }
}
