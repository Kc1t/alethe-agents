import XCTest

/// Hit-target harness (plan P0-9, lesson 1): every control is clicked where it is drawn — XCUITest
/// clicks the center of the accessibility frame, which is the rendered geometry — and the effect is
/// verified. A layout that draws controls away from their real hit area (e.g. `scaleEffect` over
/// AppKit-backed controls) fails here.
@MainActor
final class HitTargetTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launchFixture(scale: Double, extra: [String] = []) -> XCUIApplication {
        launchAlethe(arguments: ["-AletheUITestFixture", "hit-targets", "-AletheUITestScale", "\(scale)"] + extra).0
    }

    /// Clicks every fixture control and returns the ones whose click did not land.
    private func missedControls(in app: XCUIApplication) -> [String] {
        var missed: [String] = []

        let toggle = app.checkBoxes["fixture.toggle"].firstMatch
        let toggleBefore = toggle.value as? Int
        toggle.click()
        if toggle.value as? Int == toggleBefore { missed.append("toggle") }

        let button = app.buttons["fixture.button"].firstMatch
        button.click()
        if (button.value as? String) != "1" { missed.append("button") }

        let segments = app.radioGroups["fixture.segments"].firstMatch
        let third = segments.radioButtons.element(boundBy: 2)
        third.click()
        if (third.value as? Int) != 1 { missed.append("segments") }

        let field = app.textFields["fixture.field"].firstMatch
        field.click()
        // A click that missed leaves no keyboard focus; typing would abort the test.
        if (field.value(forKey: "hasKeyboardFocus") as? Bool) == true {
            field.typeText("ok")
        }
        if (field.value as? String) != "ok" { missed.append("field") }

        let appKit = app.buttons["fixture.appkit"].firstMatch
        appKit.click()
        if (appKit.value as? String) != "1" { missed.append("appkit") }

        return missed
    }

    func testControlsReceiveClicksAtEveryUIScale() {
        for scale in [0.9, 1.0, 1.2] {
            let app = launchFixture(scale: scale)
            XCTAssertEqual(missedControls(in: app), [], "controls missed at UI scale \(scale)")
            app.terminate()
        }
    }

    /// Proves the harness catches a real miss: an invisible overlay taking clicks (the first
    /// attempt's overlay bug, lesson 4).
    func testHarnessDetectsClickSwallowingOverlay() {
        let app = launchFixture(scale: 1.0, extra: ["-AletheUITestBrokenOverlay", "YES"])
        let missed = missedControls(in: app)
        XCTAssertFalse(missed.isEmpty, "an overlay swallowing clicks must be detected")
        app.terminate()
    }

    /// Records a platform fact (P0-9): on macOS 27, `scaleEffect` no longer displaces hit areas —
    /// not even for an NSView-backed control — so the first attempt's zoom bug does not reproduce.
    /// If this starts failing, a regression in AppKit/SwiftUI hit-testing has appeared; the zoom
    /// rule (scale metrics, never `scaleEffect`) stands either way.
    func testScaleEffectHitTestingOnThisOS() {
        let app = launchFixture(scale: 0.8, extra: ["-AletheUITestBrokenScale", "YES"])
        XCTAssertEqual(missedControls(in: app), [])
        app.terminate()
    }
}
