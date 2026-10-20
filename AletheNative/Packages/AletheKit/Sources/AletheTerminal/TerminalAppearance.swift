import AletheDesign
import CoreGraphics
import GhosttyTerminal

/// Maps an Alethe theme onto Ghostty's terminal configuration.
public enum TerminalAppearance {
    public static let defaultFontSize: Float = 13

    /// User-chosen font family (web `terminalFontFamily`); nil uses the bundled terminal font.
    public nonisolated(unsafe) static var fontFamilyOverride: String?

    public static func configuration(for theme: Theme, fontSize: Float = defaultFontSize,
                                     metrics: Metrics? = nil) -> TerminalConfiguration {
        let palette = theme.terminal
        let web = metrics?.isWebInterface == true
        let size = metrics.map { $0.isWebInterface ? Float($0.size(14)) : fontSize } ?? fontSize
        var configuration = TerminalConfiguration()
            .fontFamily(fontFamilyOverride ?? AletheFonts.terminalFamily)
            .fontSize(size)
            // The wrapper's base config thickens glyphs; Ghostty.app does not by default.
            .fontThicken(false)
            .background(opaqueHex(palette.background, over: palette.background))
            .foreground(opaqueHex(palette.foreground, over: palette.background))
            .cursorColor(opaqueHex(palette.cursor, over: palette.background))
            // Ghostty takes opaque colors: blend the translucent selection over the background.
            .selectionBackground(opaqueHex(palette.selection, over: palette.background, maxAlpha: 0.3))
            // Web uses asymmetric 4/6/2/8 host padding, applied by TerminalPaneView.
            .windowPaddingX(web ? 0 : 8)
            .windowPaddingY(web ? 0 : 6)
            // ADR-10: no terminal-level shortcuts. Ghostty's defaults bind ⌘W, ⌘T, ⌘N, ⌘K, ⌘F, ⌘±…
            // and the view claims any bound chord in performKeyEquivalent, before the menu bar
            // sees it. App shortcuts live in the menus; copy/paste/select-all reach the view
            // through the responder chain (its copy:/paste:/selectAll: actions).
            .custom("keybind", "clear")
        // Custom regex links are not configurable in libghostty yet. Web detection is host-owned.
        if web {
            configuration = configuration.custom("link-url", "false").custom("link-osc8", "false")
        }
        for (index, color) in palette.ansi.enumerated() {
            configuration = configuration.palette(index, color: opaqueHex(color, over: palette.background))
        }
        return configuration
    }

    /// The Alethe theme as the controller's terminal theme. It must be the *theme* (not only the
    /// terminal configuration): the controller renders its theme after the configuration, and the
    /// wrapper's default theme would otherwise override every color. The same configuration serves
    /// both appearances because Alethe themes are not tied to the system light/dark mode.
    public static func terminalTheme(for theme: Theme, fontSize: Float = defaultFontSize,
                                     metrics: Metrics? = nil) -> TerminalTheme {
        let configuration = configuration(for: theme, fontSize: fontSize, metrics: metrics)
        return TerminalTheme(light: configuration, dark: configuration)
    }

    /// The web host padding (top/right/bottom/left = 4/6/2/8) is applied by the pane (`PaneView.layout`),
    /// so the surface fills its host.
    public static func surfaceFrame(in bounds: CGRect, metrics: Metrics?) -> CGRect { bounds }

    /// `#rrggbb` of `color` composited over `background`.
    static func opaqueHex(_ color: ThemeColor, over background: ThemeColor, maxAlpha: Double = 1) -> String {
        let alpha = min(color.alpha, maxAlpha)
        func channel(_ top: Double, _ bottom: Double) -> Int {
            Int(((top * alpha + bottom * (1 - alpha)) * 255).rounded())
        }
        let rgb = [
            channel(color.red, background.red),
            channel(color.green, background.green),
            channel(color.blue, background.blue),
        ]
        return "#" + rgb.map { String(format: "%02x", $0) }.joined()
    }
}
