import XCTest

/// Web pane (P2-12): load failure shown with reload, address validation, page options, close; hit
/// targets at three zoom levels. No network: the seed points at a closed local port.
@MainActor
final class WebPaneTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func testBrowserSetupValidatesAndPersistsNamedPane() {
        let (app, root) = launchAlethe(arguments: ["-AletheUITestSeed", "web", "-interfaceStyle", "web"])
        let menu = app.buttons["chrome.mainMenu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        for _ in 0..<5 { app.typeKey("+", modifierFlags: .command) }
        app.typeKey("a", modifierFlags: [.command, .shift])
        let website = app.buttons["addContent.web"].firstMatch
        XCTAssertTrue(website.waitForExistence(timeout: 5))
        website.click()
        XCTAssertTrue(app.textFields["browser.add.url"].firstMatch.waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !app.textFields["browser.add.url"].firstMatch.exists })
        menu.click()
        let add = app.buttons["chrome.mainMenu.addBrowser"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.click()
        let address = app.textFields["browser.add.url"].firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        let confirm = app.buttons["browser.add.confirm"].firstMatch
        XCTAssertFalse(confirm.isEnabled)
        paste("file:///etc/hosts", into: app)
        XCTAssertFalse(confirm.isEnabled)
        address.click()
        app.typeKey("a", modifierFlags: .command)
        paste("127.0.0.1:9", into: app)
        let name = app.textFields["browser.add.name"].firstMatch
        name.click()
        paste("Local preview", into: app)
        XCTAssertTrue(confirm.isEnabled)
        XCTAssertTrue(confirm.isHittable)
        confirm.click()
        let label = app.staticTexts["web.name"].firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 10))
        XCTAssertEqual(label.value as? String, "Local preview")
        app.terminate()
        let restored = launchAlethe(dataRoot: root, arguments: ["-interfaceStyle", "web"]).0
        XCTAssertTrue(restored.staticTexts["web.name"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(restored.staticTexts["web.name"].firstMatch.value as? String, "Local preview")
        restored.terminate()
    }

    func testFailureAddressOptionsAndCloseAtThreeZoomLevels() {
        for (label, keys) in [("90 %", ["-"]), ("100 %", []), ("120 %", ["+", "+"])] {
            let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "web"])
            XCTAssertTrue(element(app, "web.failure").waitForExistence(timeout: 15), "a refused page says so")
            for key in keys { app.typeKey(key, modifierFlags: .command) }
            XCTAssertFalse(element(app, "web.back").isEnabled)

            let address = app.textFields["web.address"]
            XCTAssertEqual(address.value as? String, "http://127.0.0.1:9/")
            address.click()
            address.typeKey("a", modifierFlags: .command)
            paste("file:///etc/hosts", into: app)
            address.typeKey(.return, modifierFlags: [])
            XCTAssertEqual(address.value as? String, "file:///etc/hosts", "a refused address is kept for fixing")

            element(app, "web.options").click()
            XCTAssertTrue(app.menuItems["Keep loaded"].waitForExistence(timeout: 5), "options missed at \(label)")
            app.menuItems["Keep loaded"].click()

            element(app, "pane.close").click()
            XCTAssertTrue(eventually { !self.element(app, "web.pane").exists }, "close missed at \(label)")
            app.terminate()
        }
    }
}
