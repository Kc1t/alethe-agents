import XCTest

/// Dictation (P3-17): with the microphone denied, ⌥⌘E says so and offers System Settings.
@MainActor
final class DictationTests: XCTestCase {
    func testDeniedMicrophoneExplainsAndDismisses() {
        continueAfterFailure = false
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "sidebar", "-AletheDictationDenied", "YES", "-interfaceStyle", "mac"])
        XCTAssertTrue(app.descendants(matching: .any)["sidebar.project.alpha"].waitForExistence(timeout: 5))
        app.typeKey("e", modifierFlags: [.command, .option])
        let hud = app.descendants(matching: .any)["dictation.hud"]
        XCTAssertTrue(hud.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["dictation.openSettings"].exists)
        app.descendants(matching: .any)["dictation.dismiss"].firstMatch.click()
        XCTAssertTrue(eventually { !hud.exists })
        app.terminate()
    }
    func testWebJevShortcutAndDisabledMicrophone() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "sidebar", "-interfaceStyle", "web", "-dictation.enabled", "NO"])
        XCTAssertTrue(app.descendants(matching: .any)["sidebar.project.alpha"].waitForExistence(timeout: 5))
        app.typeKey(" ", modifierFlags: [.command, .shift])
        let bar = app.descendants(matching: .any)["jev.voiceBar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["jev.microphone"].isEnabled)
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !bar.exists })
        app.terminate()
    }

    func testWebJevDeniedMicrophoneRecordsFailureAndCancels() {
        let (app, _) = launchAlethe(arguments: ["-AletheUITestSeed", "sidebar", "-interfaceStyle", "web",
                                               "-dictation.enabled", "YES", "-AletheDictationDenied", "YES", "-main.rightSidebarVisible", "YES"])
        XCTAssertTrue(app.descendants(matching: .any)["sidebar.project.alpha"].waitForExistence(timeout: 5))
        app.typeKey(" ", modifierFlags: [.command, .shift])
        let bar = app.descendants(matching: .any)["jev.voiceBar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        // Clicking exercises the same start path as F9 without depending on a physical microphone.
        app.buttons["jev.microphone"].click()
        XCTAssertTrue(app.descendants(matching: .any)["dictation.openSettings"].waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(eventually { !bar.exists })
        app.buttons["Jev"].firstMatch.click()
        let panel = app.descendants(matching: .any)["jev.panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        let clear = app.buttons["jev.clear"]
        XCTAssertTrue(clear.isEnabled)
        clear.click()
        XCTAssertTrue(eventually { !clear.isEnabled })
        app.terminate()
    }
}
