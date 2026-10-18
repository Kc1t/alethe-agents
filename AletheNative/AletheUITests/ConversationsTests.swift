import XCTest

/// Conversations sheet ⌘Y (P3-7).
@MainActor
final class ConversationsTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func testWebDialogsRespectStyleZoomAndEscapePriority() {
        for (style, theme) in [("normal", "light"), ("clean", "dark")] {
            let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "sidebar", "-interfaceStyle", "web",
                "-AletheUITestVisualStyle", style, "-AletheUITestTheme", theme])
            let menu = app.buttons["chrome.mainMenu"].firstMatch
            XCTAssertTrue(menu.waitForExistence(timeout: 10))
            for _ in 0..<5 { app.typeKey("+", modifierFlags: .command) }
            app.typeKey("y", modifierFlags: .command)
            let dialog = element(app, "conversations")
            XCTAssertTrue(dialog.waitForExistence(timeout: 5))
            let codex = app.buttons["conversations.agent.codex"].firstMatch
            XCTAssertTrue(codex.isHittable)
            codex.click()
            let scope = app.buttons["conversations.scope"].firstMatch
            scope.click()
            app.typeKey(.escape, modifierFlags: [])
            XCTAssertTrue(dialog.exists, "Escape closes the dropdown before the dialog")
            let search = app.textFields["conversations.filter"].firstMatch
            search.click()
            paste("no matching conversation", into: app)
            app.typeKey(.escape, modifierFlags: [])
            XCTAssertTrue(eventually { !dialog.exists }, "Escape closes with a field editor focused")
            menu.click()
            app.buttons["Diagnostics"].firstMatch.click()
            let diagnostics = element(app, "diagnostics")
            XCTAssertTrue(diagnostics.waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(diagnostics.frame.height, app.windows.firstMatch.frame.height)
            app.typeKey(.escape, modifierFlags: [])
            XCTAssertTrue(eventually { !diagnostics.exists })
            menu.click()
            app.buttons["Remote control"].firstMatch.click()
            let remote = element(app, "remote.pairing")
            XCTAssertTrue(remote.waitForExistence(timeout: 5))
            XCTAssertTrue(element(app, "remote.pairing.disabledCard").exists)
            XCTAssertTrue(app.buttons["remote.pairing.done"].firstMatch.isHittable)
            app.buttons["remote.pairing.done"].firstMatch.click()
            XCTAssertTrue(eventually { !remote.exists })
            app.terminate()
        }
    }

    func testOpensSwitchesAgentAndCloses() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "sidebar", "-interfaceStyle", "mac"])
        XCTAssertTrue(element(app, "sidebar.project.alpha").waitForExistence(timeout: 5))
        app.typeKey("y", modifierFlags: .command)
        XCTAssertTrue(element(app, "conversations").waitForExistence(timeout: 5))
        let agents = app.radioGroups["conversations.agent"].firstMatch
        XCTAssertTrue(agents.waitForExistence(timeout: 5))
        agents.radioButtons["Codex"].click()
        XCTAssertTrue(eventually { (agents.radioButtons["Codex"].value as? Int) == 1 })
        XCTAssertFalse(element(app, "conversations.open").isEnabled, "nothing selected yet")
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !self.element(app, "conversations").exists })
        app.terminate()
    }
}
