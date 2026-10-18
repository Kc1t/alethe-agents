import XCTest

/// The first-run sheet (P5-26). UI tests see it only with `-AletheUITestOnboarding YES`; agent
/// configs are read from a throwaway home (`-AletheIntegrationsHome`), never the Mac's own.
@MainActor
final class OnboardingTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func launch(dataRoot: URL, extra: [String] = []) -> XCUIApplication {
        launchAlethe(dataRoot: dataRoot, arguments: [
            "-AletheUITestOnboarding", "YES",
            "-AletheIntegrationsHome", dataRoot.appending(path: "home").path,
        ] + extra).0
    }

    private func enterName(_ name: String, in app: XCUIApplication) {
        let field = element(app, "onboarding.name")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        app.typeKey("a", modifierFlags: .command)
        paste(name, into: app)
    }

    func testCompleteRunsOnceAndNamesTheProfile() {
        let root = makeTemporaryDataRoot()
        var app = launch(dataRoot: root)
        let sheet = element(app, "onboarding")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        enterName("Ada", in: app)
        XCTAssertEqual(element(app, "onboarding.progress").label, "Step 1 of 5", "no import step without Tauri data")

        // Return goes on, step by step: name, appearance, agents, features, MCP.
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(element(app, "onboarding.style").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "onboarding.import.open").exists)
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(element(app, "onboarding.agents").waitForExistence(timeout: 5))
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(element(app, "settings.feature.mcp").waitForExistence(timeout: 5))
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(element(app, "onboarding.mcp.agents").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "onboarding.mcp.note").exists, "an empty home has nothing to sync")
        element(app, "onboarding.next").click()

        // Finishing hands over to the setup steps on Home.
        XCTAssertTrue(eventually { !sheet.exists })
        XCTAssertTrue(element(app, "setup").waitForExistence(timeout: 5))
        element(app, "profiles.menu").click()
        XCTAssertTrue(app.menuItems["Ada"].waitForExistence(timeout: 5), "the name is the profile's name")
        app.typeKey(.escape, modifierFlags: [])
        app.terminate()

        // Only once.
        app = launch(dataRoot: root)
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "onboarding").waitForExistence(timeout: 2))

        // Help reopens it.
        app.menuBars.menuBarItems["Help"].click()
        app.menuItems["Show Onboarding…"].click()
        XCTAssertTrue(element(app, "onboarding").waitForExistence(timeout: 5))
        app.terminate()
    }

    func testSkipIsRemembered() {
        let root = makeTemporaryDataRoot()
        var app = launch(dataRoot: root)
        let sheet = element(app, "onboarding")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !sheet.exists })
        app.terminate()

        app = launch(dataRoot: root)
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "onboarding").waitForExistence(timeout: 2))
        app.terminate()
    }

    func testImportOfferedWhenTauriDataExists() throws {
        let fixture = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "tauri-projects", ofType: "json"))
        let app = launch(dataRoot: makeTemporaryDataRoot(), extra: ["-AletheTauriProjectsFile", fixture])
        XCTAssertTrue(element(app, "onboarding").waitForExistence(timeout: 5))
        enterName("Ada", in: app)
        XCTAssertTrue(eventually { self.element(app, "onboarding.progress").label == "Step 1 of 6" })
        element(app, "onboarding.next").click()

        let open = element(app, "onboarding.import.open")
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.click()
        let confirm = app.buttons["editor.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.click()
        XCTAssertTrue(app.staticTexts["Imported"].waitForExistence(timeout: 5))
        app.buttons["editor.confirm"].firstMatch.click()
        XCTAssertTrue(element(app, "onboarding.import.summary").waitForExistence(timeout: 5))
        element(app, "onboarding.skip").click()
        XCTAssertTrue(element(app, "sidebar.project.imported-tmp").waitForExistence(timeout: 5))
        app.terminate()
    }
}
