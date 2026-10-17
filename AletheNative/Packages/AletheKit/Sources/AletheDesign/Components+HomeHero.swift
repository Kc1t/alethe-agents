import SwiftUI

/// HomeView.module.css quick fields; the Agent summary uses the inherited sans font.
public struct HomeQuickFieldStyle: ButtonStyle {
    private let sans: Bool
    public init(sans: Bool = false) { self.sans = sans }
    public func makeBody(configuration: Configuration) -> some View {
        HomeHeroControl(configuration: configuration, kind: sans ? .agent : .field)
    }
}

public struct HomeHeroActionStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        HomeHeroControl(configuration: configuration, kind: .action)
    }
}

public struct HomeQuickSendStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        HomeHeroControl(configuration: configuration, kind: .send)
    }
}

private struct HomeHeroControl: View {
    enum Kind { case agent, field, action, send }
    let configuration: ButtonStyleConfiguration
    let kind: Kind
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    private var active: Bool { enabled && (hovering || configuration.isPressed) }
    private var background: ThemeToken {
        switch kind {
        case .send: active ? .accentStrong : .accent
        case .action: active ? .bgElevated : .bg
        default: active ? .panelHover : .bgSunken
        }
    }
    private var opacity: Double {
        if active || kind == .send { return 1 }
        return kind == .action ? 0.48 : 0.72
    }
    var body: some View {
        configuration.label
            .labelStyle(HomeHeroLabelStyle())
            .font(kind == .agent ? metrics.font(size: 10) : metrics.monoFont(size: kind == .action ? 11 : 10))
            .foregroundStyle(theme[kind == .send ? .accentOn : (kind == .action && active ? .fg : .fgMuted)])
            .padding(.horizontal, metrics.size(kind == .action ? 10 : kind == .send ? 0 : 8))
            .padding(.vertical, metrics.size(kind == .action ? 7 : 0))
            .frame(width: kind == .send ? metrics.size(38) : nil,
                   height: kind == .action ? nil : metrics.size(30))
            .frame(maxWidth: kind == .field || kind == .agent ? .infinity : nil, alignment: kind == .send ? .center : .leading)
            .background(theme[background].opacity(opacity), in: RoundedRectangle(cornerRadius: metrics.radius(kind == .action ? .sm : .md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(kind == .action ? .sm : .md))
                .strokeBorder(theme[kind == .send || (active && kind != .action) ? .accentBorder : .border], lineWidth: metrics.size(1)))
            .opacity(enabled ? 1 : 0.45)
            .onHover { hovering = $0 }
            .animation(metrics.reducesMotion ? nil : Motion.quick.animation, value: active)
    }
}

private struct HomeHeroLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(7)) {
            configuration.icon
            configuration.title
        }
    }
}
