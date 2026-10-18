import XCTest

@MainActor
final class TitleBarLeadingLayoutTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testDebugMenuReopensOnboardingAtLargeZoom() {
        let (app, _) = launchAlethe(arguments: ["-interfaceStyle", "web"])
        let menu = app.buttons["chrome.mainMenu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        for _ in 0..<5 { app.typeKey("+", modifierFlags: .command) }
        menu.click()
        let redo = app.buttons["chrome.mainMenu.redoOnboarding"].firstMatch
        XCTAssertTrue(redo.waitForExistence(timeout: 5))
        XCTAssertTrue(redo.isHittable)
        redo.click()
        let onboarding = app.descendants(matching: .any)["onboarding"].firstMatch
        XCTAssertTrue(onboarding.waitForExistence(timeout: 5))
        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(onboarding.frame.width, window.width)
        XCTAssertLessThanOrEqual(onboarding.frame.height, window.height)
        app.buttons["onboarding.skip"].firstMatch.click()
        XCTAssertTrue(eventually { !onboarding.exists })
        menu.click()
        XCTAssertTrue(redo.waitForExistence(timeout: 5))
        redo.click()
        XCTAssertTrue(onboarding.waitForExistence(timeout: 5), "Can rerun without relaunching")
        app.terminate()
    }

    func testFullscreenUsesWebPaddingAtEveryZoomEndpointAndSidebarState() {
        let (app, _) = launchAlethe()
        let window = app.windows.firstMatch
        let menu = app.buttons["chrome.mainMenu"].firstMatch
        let sidebar = app.buttons["chrome.toggleSidebar"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))

        // Exercise native fullscreen through this app's shortcut, without global key events.
        app.typeKey("f", modifierFlags: [.command, .control])
        XCTAssertTrue(eventually(timeout: 10) { abs(menu.frame.minX - window.frame.minX - 6) < 1 })
        for (scale, steps) in [(0.8, -2), (1.0, 0), (1.5, 5)] {
            app.typeKey("0", modifierFlags: .command)
            for _ in 0..<abs(steps) {
                app.typeKey(steps < 0 ? "-" : "+", modifierFlags: .command)
            }
            let expectedGap = 6 * scale
            XCTAssertTrue(eventually {
                abs(menu.frame.minX - window.frame.minX - expectedGap) < 1
            }, "Fullscreen must have only the web padding at zoom \(scale)")
            let leading = menu.frame.minX
            sidebar.click()
            XCTAssertTrue(eventually { abs(menu.frame.minX - leading) < 1 })
            sidebar.click()
            XCTAssertTrue(eventually { abs(menu.frame.minX - leading) < 1 })
        }

        app.typeKey("f", modifierFlags: [.command, .control])
        XCTAssertTrue(eventually(timeout: 10) {
            menu.frame.minX - window.frame.minX > 6 * 1.5 + 1
        }, "The traffic-light reserve returns after exiting fullscreen")
        app.terminate()
    }
}
