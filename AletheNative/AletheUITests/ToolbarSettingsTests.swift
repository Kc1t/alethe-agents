import XCTest

/// Toolbar configuration (P5-13): Settings › Toolbar hides and restores items; View › Customize
/// Toolbar… is offered.
@MainActor
final class ToolbarSettingsTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func openToolbarSettings(_ app: XCUIApplication) {
        app.typeKey(",", modifierFlags: .command)
        let tab = app.toolbars.buttons["Toolbar"].firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 5))
        tab.click()
        XCTAssertTrue(element(app, "settings.toolbar.memory").waitForExistence(timeout: 5))
    }

    func testHidingAndRestoringAnItem() {
        let (app, root) = launchAlethe()
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "memory.indicator").waitForExistence(timeout: 5), "shown by default")
        XCTAssertTrue(app.menuBars.menuItems["Customize Toolbar…"].exists)

        openToolbarSettings(app)
        let toggle = element(app, "settings.toolbar.memory")
        XCTAssertEqual(toggle.value as? Int, 1)
        XCTAssertFalse(element(app, "settings.toolbar.restore").isEnabled, "nothing to restore yet")
        toggle.click()
        XCTAssertTrue(eventually { (toggle.value as? Int) == 0 })
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(eventually { !self.element(app, "memory.indicator").exists }, "hidden from the toolbar")
        app.terminate()

        let (relaunched, _) = launchAlethe(dataRoot: root)
        XCTAssertTrue(element(relaunched, "workspace.empty").waitForExistence(timeout: 5))
        XCTAssertFalse(element(relaunched, "memory.indicator").exists, "the choice persists")
        openToolbarSettings(relaunched)
        let restore = element(relaunched, "settings.toolbar.restore")
        XCTAssertTrue(restore.isEnabled)
        restore.click()
        XCTAssertTrue(eventually { (self.element(relaunched, "settings.toolbar.memory").value as? Int) == 1 })
        relaunched.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(element(relaunched, "memory.indicator").waitForExistence(timeout: 5), "restored")
        relaunched.terminate()
    }

    /// The usage pill toggles are the same choice in AI Usage and Settings › Toolbar.
    func testUsagePillToggleIsSharedWithAIUsage() {
        let (app, _) = launchAlethe()
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        openToolbarSettings(app)
        let setting = element(app, "settings.toolbar.usage.codex")
        XCTAssertEqual(setting.value as? Int, 0, "usage pills start hidden")
        setting.click()
        XCTAssertTrue(eventually { (setting.value as? Int) == 1 })
        app.typeKey("w", modifierFlags: .command)

        element(app, "usage.button").click()
        let pill = element(app, "usage.pillToggle.codex")
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        XCTAssertEqual(pill.value as? Int, 1)
        pill.click()
        XCTAssertTrue(eventually { (pill.value as? Int) == 0 })
        app.typeKey(.escape, modifierFlags: [])
        openToolbarSettings(app)
        XCTAssertTrue(eventually { (self.element(app, "settings.toolbar.usage.codex").value as? Int) == 0 })
        app.terminate()
    }

    /// Hit targets at three zoom levels: every toggle flips where it is drawn.
    func testToolbarTogglesReceiveClicksAtThreeZoomLevels() {
        let items = ["home", "usage.claude", "usage.codex", "usage.antigravity", "usage",
                     "notifications", "memory", "profile", "remote", "router9", "sync"]
        for (steps, label) in [(-1, "90%"), (0, "100%"), (2, "120%")] {
            let (app, _) = launchAlethe()
            XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
            for _ in 0..<abs(steps) { app.typeKey(steps > 0 ? "+" : "-", modifierFlags: .command) }
            openToolbarSettings(app)
            for item in items {
                let toggle = element(app, "settings.toolbar.\(item)")
                let before = toggle.value as? Int
                toggle.click()
                XCTAssertTrue(eventually { (toggle.value as? Int) != before }, "\(item) missed at \(label)")
            }
            element(app, "settings.toolbar.restore").click()
            XCTAssertTrue(eventually { (self.element(app, "settings.toolbar.memory").value as? Int) == 1 },
                          "restore missed at \(label)")
            app.terminate()
        }
    }
}
