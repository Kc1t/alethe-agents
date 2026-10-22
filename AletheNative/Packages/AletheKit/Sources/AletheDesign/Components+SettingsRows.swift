import SwiftUI

/// Section bodies are unframed; only rows with a corresponding web card opt in.
public enum AletheSettingsRowSurface: Equatable, Sendable {
    case standalone, option, remote, plugin, version, metric, task, agent, empty, toolbar

    var horizontal: CGFloat {
        switch self { case .empty: 18; case .toolbar: 10; case .version: 14; case .metric, .task: 10; default: 12 }
    }
    var vertical: CGFloat {
        switch self { case .empty: 18; case .toolbar: 8; case .remote, .plugin, .version: 12; case .metric, .task: 8; default: 10 }
    }
}

extension ContainerValues {
    @Entry public var settingsRowSurface: AletheSettingsRowSurface = .standalone
}

extension View {
    public func settingsRowSurface(_ surface: AletheSettingsRowSurface) -> some View {
        containerValue(\.settingsRowSurface, surface)
    }
}

/// Shared by both form implementations; the macOS Form never applies this modifier.
public struct AletheSettingsRowSurfaceModifier: ViewModifier {
    let surface: AletheSettingsRowSurface
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    public init(_ surface: AletheSettingsRowSurface) { self.surface = surface }

    public func body(content: Content) -> some View {
        if metrics.isWebInterface, surface != .standalone {
            content
                .padding(.horizontal, metrics.size(surface.horizontal))
                .padding(.vertical, metrics.size(surface.vertical))
                .background(theme[surface == .toolbar ? .panel : .bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(surface == .metric || surface == .task ? .sm : .md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(surface == .metric || surface == .task ? .sm : .md))
                    .strokeBorder(theme[.border], style: StrokeStyle(lineWidth: metrics.size(1), dash: surface == .empty ? [metrics.size(3)] : [])))
        } else { content }
    }
}
