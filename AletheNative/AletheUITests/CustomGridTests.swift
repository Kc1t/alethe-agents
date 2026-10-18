import XCTest

/// Custom grid (P2-19): the designer applies a preset and saves; the panes follow it.
@MainActor
final class CustomGridTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    func testDesignerPresetAndSave() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "panes"])
        let one = element(app, "pane.header.one"), two = element(app, "pane.header.two")
        XCTAssertTrue(one.waitForExistence(timeout: 5))

        let project = element(app, "sidebar.project.api")
        project.rightClick()
        app.menuItems["Design Layout…"].click()
        XCTAssertTrue(element(app, "layoutDesigner").waitForExistence(timeout: 5))
        element(app, "layoutDesigner.preset.rows").click()
        element(app, "editor.confirm").click()
        XCTAssertTrue(eventually { !self.element(app, "layoutDesigner").exists })
        XCTAssertTrue(eventually { abs(one.frame.minX - two.frame.minX) < 2 && one.frame.maxY < two.frame.minY },
                      "the Rows preset stacks the panes")

        app.typeKey("z", modifierFlags: .command)
        XCTAssertTrue(eventually { one.frame.maxX < two.frame.minX }, "⌘Z restores Auto")
        app.terminate()
    }

    func testDesignerGrowsTheSelectedBox() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "panes"])
        XCTAssertTrue(element(app, "container.layout.api").waitForExistence(timeout: 5))
        let picker = element(app, "container.layout.api")
        picker.click()
        picker.menuItems["Design Grid…"].click()
        // Auto: one, two on the first row; three alone on the second, with a free slot beside it.
        element(app, "layoutDesigner.box.three").click()
        XCTAssertTrue(element(app, "layoutDesigner.grow.right").waitForExistence(timeout: 5))
        element(app, "layoutDesigner.grow.right").click()
        XCTAssertTrue(eventually { !self.element(app, "layoutDesigner.grow.right").exists }, "no room left to grow")
        XCTAssertTrue(element(app, "layoutDesigner.shrink.right").exists)
        app.typeKey(.escape, modifierFlags: [])
        app.terminate()
    }
}
