import XCTest

/// Flat workspace and focus mode (P2-21).
@MainActor
final class FlatAndFocusTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func testFlatWorkspaceMergesContainers() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "panes"])
        XCTAssertTrue(element(app, "container.collapse.api").waitForExistence(timeout: 5))
        app.menuBars.menuBarItems["View"].click()
        app.menuItems["Flat Workspace"].click()
        XCTAssertTrue(eventually { !self.element(app, "container.collapse.api").exists }, "no container headers")
        XCTAssertTrue(element(app, "pane.header.one").exists && element(app, "pane.header.four").exists,
                      "panes of both projects share one area")
        app.menuBars.menuBarItems["View"].click()
        app.menuItems["Flat Workspace"].click()
        XCTAssertTrue(element(app, "container.collapse.api").waitForExistence(timeout: 5), "containers again")
        app.terminate()
    }

    func testFocusModeEntersAndLeaves() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "panes"])
        let one = element(app, "pane.header.one")
        XCTAssertTrue(one.waitForExistence(timeout: 5))
        let before = one.frame
        one.doubleClick()
        XCTAssertTrue(element(app, "focusMode.backdrop").waitForExistence(timeout: 5))
        XCTAssertTrue(eventually { one.frame.width > before.width * 1.5 }, "the pane floats over the workspace")
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(eventually { one.frame.width > window.width * 0.8 }, "focus spans the window, including the sidebar area")
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !self.element(app, "focusMode.backdrop").exists }, "Esc leaves")
        XCTAssertTrue(eventually { abs(one.frame.width - before.width) < 2 }, "the original layout returns")
        app.typeKey("f", modifierFlags: [.command, .shift])
        XCTAssertTrue(element(app, "focusMode.backdrop").waitForExistence(timeout: 5), "⇧⌘F focuses the focused pane")
        element(app, "focusMode.backdrop").click()
        XCTAssertTrue(eventually { !self.element(app, "focusMode.backdrop").exists }, "clicking the backdrop leaves")
        app.terminate()
    }
}
