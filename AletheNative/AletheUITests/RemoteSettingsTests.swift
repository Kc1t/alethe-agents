import XCTest

/// Settings › Remote and terminal sharing (P7-18). The `remote` seed turns remote control on (bound to
/// 127.0.0.1) with a shared shell pane (`shared`) and a private one (`private`), input allowed, two
/// devices. `settings.remote.probe` (debug test launches only) shows what the controller and its hub
/// hold, so each check proves the click reached the controller. Every control is clicked where it is
/// drawn and its effect verified (hit targets).
@MainActor
final class RemoteSettingsTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func launchSeeded(nativeHeader: Bool = false) -> XCUIApplication {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "remote"] + (nativeHeader ? ["-interfaceStyle", "mac"] : []))
        XCTAssertTrue(element(app, "pane.header.shared").waitForExistence(timeout: 10))
        return app
    }

    private func openRemoteSettings(_ app: XCUIApplication) -> XCUIElement {
        app.typeKey(",", modifierFlags: .command)
        let tab = app.toolbars.buttons["Remote"].firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 5))
        tab.click()
        let probe = element(app, "settings.remote.probe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        return probe
    }

    private func text(_ probe: XCUIElement) -> String {
        (probe.value as? String).flatMap { $0.isEmpty ? nil : $0 } ?? probe.label
    }

    private func waitFor(_ probe: XCUIElement, _ fragment: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(eventually(timeout: 8) { self.text(probe).contains(fragment) },
                      "probe shows \(fragment); got \(text(probe))", file: file, line: line)
    }

    func testTogglesReachTheController() {
        let app = launchSeeded()
        let probe = openRemoteSettings(app)
        waitFor(probe, "enabled=true")
        waitFor(probe, "readOnly=false shell=true max=2 expiry=3600 reach=lan")

        let readOnly = element(app, "settings.remote.readOnly")
        readOnly.click()
        waitFor(probe, "readOnly=true")
        let shellInput = element(app, "settings.remote.shellInput")
        XCTAssertFalse(shellInput.isEnabled, "shell input is moot while read-only")
        readOnly.click()
        waitFor(probe, "readOnly=false")
        XCTAssertTrue(eventually { shellInput.isEnabled })
        shellInput.click()
        waitFor(probe, "shell=false")

        let maxDevices = element(app, "settings.remote.maxDevices")
        maxDevices.click()
        app.menuItems["4"].firstMatch.click()
        waitFor(probe, "max=4")

        let expiry = element(app, "settings.remote.expiry")
        expiry.click()
        app.menuItems["24 hours"].firstMatch.click()
        waitFor(probe, "expiry=86400")

        let enabled = element(app, "settings.remote.enabled")
        enabled.click()
        waitFor(probe, "enabled=false")
        XCTAssertFalse(element(app, "settings.remote.pairing").exists, "no pairing while off")

        // Turning it on asks once, with the network warning.
        enabled.click()
        let turnOn = element(app, "settings.remote.enable.turnOn")
        XCTAssertTrue(turnOn.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@",
                                                           "not encrypted", "not encrypted")).firstMatch.exists)
        turnOn.click()
        waitFor(probe, "enabled=true")
        XCTAssertTrue(element(app, "settings.remote.pairing").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "settings.remote.devices.none").exists)
        app.terminate()
    }

    func testTurningOnCanBeCancelled() {
        let app = launchSeeded()
        let probe = openRemoteSettings(app)
        let enabled = element(app, "settings.remote.enabled")
        enabled.click()
        waitFor(probe, "enabled=false")
        enabled.click()
        XCTAssertTrue(element(app, "settings.remote.enable.turnOn").waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !self.element(app, "settings.remote.enable.turnOn").exists })
        XCTAssertTrue(text(probe).contains("enabled=false"), "cancelling leaves it off")
        XCTAssertEqual(enabled.value as? Int, 0)
        app.terminate()
    }

    func testPaneHeaderMenuSharesATerminal() {
        let app = launchSeeded(nativeHeader: true)
        let header = element(app, "pane.header.private")
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertFalse(header.descendants(matching: .any)["remote.sharedGlyph"].exists, "private by default")
        XCTAssertTrue(element(app, "pane.header.shared").descendants(matching: .any)["remote.sharedGlyph"].exists)

        header.rightClick()
        app.menuItems["Share with Remote Devices"].firstMatch.click()
        XCTAssertTrue(header.descendants(matching: .any)["remote.sharedGlyph"].waitForExistence(timeout: 5))

        let probe = openRemoteSettings(app)
        waitFor(probe, "shared=private,shared")
        app.typeKey("w", modifierFlags: .command)

        element(app, "pane.header.shared").rightClick()
        app.menuItems["Share with Remote Devices"].firstMatch.click()
        XCTAssertTrue(eventually {
            !self.element(app, "pane.header.shared").descendants(matching: .any)["remote.sharedGlyph"].exists
        })
        waitFor(openRemoteSettings(app), "shared=private")
        XCTAssertFalse(text(element(app, "settings.remote.probe")).contains("shared=private,shared"))
        app.terminate()
    }

    func testSidebarMenuSharesATerminal() {
        let app = launchSeeded(nativeHeader: true)
        var row = app.outlines.staticTexts["private"].firstMatch
        if !row.waitForExistence(timeout: 2) {
            element(app, "sidebar.project.remote").click()
            app.outlines.disclosureTriangles.firstMatch.click()
            row = app.outlines.staticTexts["private"].firstMatch
        }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.rightClick()
        let share = app.menuItems["Share with Remote Devices"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 5))
        share.click()
        XCTAssertTrue(element(app, "pane.header.private").descendants(matching: .any)["remote.sharedGlyph"]
            .waitForExistence(timeout: 5), "the pane header marks it shared")

        waitFor(openRemoteSettings(app), "shared=private,shared")
        app.terminate()
    }
}
