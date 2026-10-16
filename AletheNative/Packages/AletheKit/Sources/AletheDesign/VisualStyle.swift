import Foundation

/// The app's look (upstream `preferences.visualStyle`): Normal is the production look with colored
/// selection chrome and rounded surfaces; Clean is flat and compact, with restrained borders.
public enum VisualStyle: String, Codable, CaseIterable, Sendable {
    case normal, clean
}

/// Which interface the app draws: `web` replicates the Windows/web app 1:1 (custom title bar,
/// sidebars and surfaces); `mac` keeps native chrome (toolbar, source-list sidebar, inspector).
public enum InterfaceStyle: String, Codable, CaseIterable, Sendable {
    case web, mac
}

extension Theme {
    /// The theme as a visual style shows it. Clean neutralizes the accent-colored selection chrome
    /// (semantic status colors stay) and drops shadows (upstream `[data-visual-style='clean']`).
    public func styled(_ style: VisualStyle) -> Theme {
        guard style == .clean else { return self }
        var colors = self.colors
        let neutral: [ThemeToken: ThemeToken] = [
            .accentSoft: .panelHover, .accentFaint: .panelHover, .accentBorder: .borderStrong,
            .accentBorderSoft: .border, .borderAccent: .border,
        ]
        for (token, source) in neutral { colors[token] = self.colors[source] }
        colors[.accentRing] = ThemeColor(hex: "#00000000")
        let flat = ThemeShadow(x: 0, y: 0, blur: 0, color: ThemeColor(hex: "#00000000")!)
        return Theme(id: id, isLight: isLight, swatch: swatch, colors: colors,
                     shadows: Dictionary(uniqueKeysWithValues: ShadowLevel.allCases.map { ($0, flat) }), terminal: terminal)
    }
}
