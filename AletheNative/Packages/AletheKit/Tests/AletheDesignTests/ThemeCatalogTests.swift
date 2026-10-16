import Foundation
import Testing
@testable import AletheDesign

@Suite struct ThemeCatalogTests {
    @Test func loadsEveryBuiltinThemeInPickerOrder() throws {
        let catalog = try ThemeCatalog(bundle: .module)
        #expect(catalog.themes.map(\.id) == ThemeCatalog.builtinOrder)
        #expect(catalog.themes.count == 16)
    }

    @Test(arguments: ThemeCatalog.builtinOrder)
    func themeIsComplete(id: String) throws {
        let theme = try #require(ThemeCatalog.builtin.theme(id: id))
        #expect(theme.validationErrors.isEmpty, "\(id): \(theme.validationErrors)")
    }

    /// The converted token set includes the Kimi, Grok and Codewhale colors from `origin/main`.
    @Test func tokenSetMatchesUpstreamConversion() {
        #expect(ThemeToken.allCases.count == 77)
    }

    @Test func defaultAndFallbackMatchUpstream() {
        #expect(ThemeCatalog.builtin.defaultTheme.id == "elite-indigo")
        #expect(ThemeCatalog.builtin.resolved(id: "plugin-theme-not-installed").id == "dark")
    }

    @Test func lightThemesAreDetected() {
        let light = Set(ThemeCatalog.builtin.themes.filter(\.isLight).map(\.id))
        #expect(light == ["elite-original", "elite-blush", "light", "min-light"])
    }

    /// Primary text must stay readable on the app background in every theme (WCAG AA, 4.5:1).
    @Test(arguments: ThemeCatalog.builtinOrder)
    func primaryTextContrast(id: String) throws {
        let theme = try #require(ThemeCatalog.builtin.theme(id: id))
        let fg = try #require(theme.colors[.textPrimary])
        let bg = try #require(theme.colors[.bg])
        #expect(fg.contrastRatio(against: bg) >= 4.5, "\(id): \(fg.contrastRatio(against: bg))")
    }

    @Test func themeRoundTripsThroughJSON() throws {
        let theme = ThemeCatalog.builtin.defaultTheme
        let decoded = try JSONDecoder().decode(Theme.self, from: JSONEncoder().encode(theme))
        #expect(decoded == theme)
    }
}

@Suite struct ThemeColorTests {
    @Test func parsesHexForms() throws {
        let opaque = try #require(ThemeColor(hex: "#ff8000"))
        #expect(opaque.alpha == 1)
        #expect(opaque.hex == "#ff8000ff")
        let translucent = try #require(ThemeColor(hex: "#10b98129"))
        #expect(abs(translucent.alpha - 0x29 / 255.0) < 0.0001)
        #expect(ThemeColor(hex: "#12") == nil)
        #expect(ThemeColor(hex: "zzzzzz") == nil)
    }

    @Test func contrastRatioOfBlackOnWhiteIs21() throws {
        let black = try #require(ThemeColor(hex: "#000000"))
        let white = try #require(ThemeColor(hex: "#ffffff"))
        #expect(abs(black.contrastRatio(against: white) - 21) < 0.01)
    }
}
