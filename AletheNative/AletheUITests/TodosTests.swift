import XCTest

/// The Todos tab: add items, edit tags and manage settings.
@MainActor
final class TodosTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// View › New Todo reveals the tab and focuses the field.
    private func newTodo(_ title: String, in app: XCUIApplication) {
        app.menuBars.menuBarItems["View"].click()
        app.menuItems["New Todo"].click()
        XCTAssertTrue(element(app, "todos.newField").waitForExistence(timeout: 5))
        paste(title, into: app)
        app.typeKey(.return, modifierFlags: [])
    }

    func testAddAndEditTags() {
        let (app, _) = launchAlethe()
        newTodo("Write the report #docs", in: app)
        let row = app.staticTexts["Write the report"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the todo is listed without its tag words")
        XCTAssertTrue(app.staticTexts["#docs"].firstMatch.exists, "the #word became a tag")

        row.rightClick()
        app.menuItems["Edit Tags"].click()
        XCTAssertTrue(element(app, "todos.tagsField").waitForExistence(timeout: 5))
        app.typeKey("a", modifierFlags: .command)
        paste("#review #ui", into: app)
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.staticTexts["#review #ui"].firstMatch.waitForExistence(timeout: 5), "tags were replaced")

        app.terminate()
    }

    func testSettingsSheetOpensAndCloses() {
        let (app, _) = launchAlethe()
        app.menuBars.menuBarItems["View"].click()
        app.menuItems["New Todo"].click()
        let gear = element(app, "todos.settingsButton")
        XCTAssertTrue(gear.waitForExistence(timeout: 5))
        gear.click()
        XCTAssertTrue(element(app, "todos.settings.sheet").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "todos.settings.folder").exists)
        element(app, "todos.settings.reset").click()
        let confirm = app.buttons["webConfirmation.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.click()
        element(app, "todos.settings.done").click()
        XCTAssertTrue(eventually { !self.element(app, "todos.settings.sheet").exists })
        XCTAssertTrue(app.buttons["Review active workspace"].firstMatch.waitForExistence(timeout: 5), "defaults restored")
        app.terminate()
    }
}
