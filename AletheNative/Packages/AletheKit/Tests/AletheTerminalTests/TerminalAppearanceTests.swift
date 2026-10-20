import AletheDesign
import CoreGraphics
import GhosttyTerminal
import Testing
@testable import AletheTerminal

@Suite struct TerminalAppearanceTests {
    @Test func webUsesFourteenPointFontAndAsymmetricHostPadding() {
        let metrics = Metrics(scale: 1.5)
        let rendered = TerminalAppearance.configuration(for: ThemeCatalog.builtin.defaultTheme,
                                                        metrics: metrics).rendered
        #expect(rendered.contains("font-size = 21"))
        #expect(rendered.contains("window-padding-x = 0"))
        #expect(rendered.contains("window-padding-y = 0"))
        // The host padding comes from the pane layout, so the surface fills its host.
        #expect(TerminalAppearance.surfaceFrame(in: CGRect(x: 0, y: 0, width: 200, height: 100), metrics: metrics)
                == CGRect(x: 0, y: 0, width: 200, height: 100))
        #expect(TerminalAppearance.surfaceFrame(in: .zero, metrics: metrics).size == .zero)
    }

    @Test func macKeepsItsExistingFontAndPadding() {
        let metrics = Metrics(scale: 1.5, interface: .mac)
        let rendered = TerminalAppearance.configuration(for: ThemeCatalog.builtin.defaultTheme,
                                                        fontSize: 19.5, metrics: metrics).rendered
        #expect(rendered.contains("font-size = 19.5"))
        #expect(rendered.contains("window-padding-x = 8"))
        #expect(rendered.contains("window-padding-y = 6"))
        let bounds = CGRect(x: 0, y: 0, width: 200, height: 100)
        #expect(TerminalAppearance.surfaceFrame(in: bounds, metrics: metrics) == bounds)
    }

    @Test func webOwnsLinkDetectionAndMacKeepsGhosttyDefaults() {
        let theme = ThemeCatalog.builtin.defaultTheme
        let web = TerminalAppearance.configuration(for: theme, metrics: Metrics()).rendered
        let mac = TerminalAppearance.configuration(for: theme, metrics: Metrics(interface: .mac)).rendered
        #expect(web.contains("link-url = false"))
        #expect(!mac.contains("link-url = false"))
        #expect(web.contains("link-osc8 = false"))
        #expect(!mac.contains("link-osc8 = false"))
    }

    @Test func blendsTranslucentColorsOverTheBackground() throws {
        let background = try #require(ThemeColor(hex: "#000000"))
        let halfWhite = try #require(ThemeColor(hex: "#ffffff80"))
        #expect(TerminalAppearance.opaqueHex(halfWhite, over: background) == "#808080")
        let opaque = try #require(ThemeColor(hex: "#12abef"))
        #expect(TerminalAppearance.opaqueHex(opaque, over: background) == "#12abef")
    }

    @Test func configurationCarriesFontAndFullPalette() {
        let rendered = TerminalAppearance.configuration(for: ThemeCatalog.builtin.defaultTheme).rendered
        #expect(rendered.contains("font-family = \(AletheFonts.terminalFamily)"))
        #expect(rendered.contains("palette = 15="))
        #expect(rendered.contains("background = #0c0c0c"))
    }

    /// Regression (ADR-10): Ghostty's default keybinds claimed ⌘W and other app shortcuts.
    @Test func clearsGhosttyKeybinds() {
        let rendered = TerminalAppearance.configuration(for: ThemeCatalog.builtin.defaultTheme).rendered
        #expect(rendered.contains("keybind = clear"))
    }

    /// Regression: the wrapper's default theme is rendered last and used to override our colors.
    @MainActor @Test func controllerRendersTheAletheThemeLast() throws {
        let controller = TerminalController(theme: TerminalAppearance.terminalTheme(for: ThemeCatalog.builtin.defaultTheme))
        let lastBackground = controller.renderedConfig
            .split(separator: "\n").last { $0.hasPrefix("background = ") }
        #expect(lastBackground == "background = #0c0c0c")
    }
}
