import XCTest

/// The MCP tab and manager (P5-25) over a seeded throwaway home (`-AletheUITestSeed mcp` with
/// `-AletheIntegrationsHome`): Claude Code has `alpha` (secret env), Codex has `beta`, Cursor an
/// empty config. Never the user's real agent configs.
@MainActor
final class McpManagerTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func text(_ element: XCUIElement) -> String {
        (element.value as? String).flatMap { $0.isEmpty ? nil : $0 } ?? element.label
    }

    private func launchWithMcp(root: URL = makeTemporaryDataRoot(), extra: [String] = []) -> XCUIApplication {
        let (app, _) = launchAlethe(dataRoot: root, arguments: [
            "-AletheUITestSeed", "mcp",
            "-AletheIntegrationsHome", root.appending(path: "home").path,
            "-main.rightSidebarVisible", "YES",
        ] + extra)
        return app
    }

    /// The right sidebar's MCP tab, once the scan listed both seeded servers.
    private func openPanel(_ app: XCUIApplication) {
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        let tabs = element(app, "rightSidebar.tabs")
        XCTAssertTrue(tabs.waitForExistence(timeout: 5))
        tabs.radioButtons["MCP"].click()
        XCTAssertTrue(element(app, "mcp.panel").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "mcp.panel.row.alpha").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "mcp.panel.row.beta").exists)
    }

    /// History › MCP Servers…, then a server picked in the list.
    private func openManager(_ app: XCUIApplication, server: String) {
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        app.menuBars.menuBarItems["History"].click()
        app.menuItems["MCP Servers…"].click()
        XCTAssertTrue(element(app, "mcp.manager").waitForExistence(timeout: 5))
        let row = element(app, "mcp.manager.row.\(server)")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.click()
        XCTAssertTrue(eventually { self.text(self.element(app, "mcp.detail.name")) == server })
    }

    func testPanelListsServersAndTheManagerRevealsOnlyOnRequest() {
        let app = launchWithMcp()
        openPanel(app)
        XCTAssertTrue(text(element(app, "mcp.panel.stats")).contains("2"))

        // The agent filter keeps servers of the picked agent.
        element(app, "mcp.panel.agent.codex").click()
        XCTAssertTrue(eventually { !self.element(app, "mcp.panel.row.alpha").exists })
        XCTAssertTrue(element(app, "mcp.panel.row.beta").exists)
        element(app, "mcp.panel.agent.codex").click()
        XCTAssertTrue(element(app, "mcp.panel.row.alpha").waitForExistence(timeout: 5))

        element(app, "mcp.panel.row.alpha").click()
        XCTAssertTrue(element(app, "mcp.manager").waitForExistence(timeout: 5))
        XCTAssertTrue(eventually { self.text(self.element(app, "mcp.detail.name")) == "alpha" })
        let value = element(app, "mcp.env.value.API_KEY")
        XCTAssertTrue(value.waitForExistence(timeout: 5))
        XCTAssertFalse(text(value).contains("sk-test"), "masked until revealed")
        XCTAssertTrue(text(value).hasSuffix("abcd"))

        element(app, "mcp.env.reveal.API_KEY").click()
        XCTAssertTrue(eventually { self.text(value) == "sk-test-0123456789abcd" })
        element(app, "mcp.env.hide.API_KEY").click()
        XCTAssertTrue(eventually { !self.text(value).contains("sk-test") })

        element(app, "mcp.manager.done").click()
        XCTAssertTrue(eventually { !self.element(app, "mcp.manager").exists })
        app.terminate()
    }

    func testAddingAServerManuallyThenUndo() {
        let app = launchWithMcp()
        openManager(app, server: "alpha")
        element(app, "mcp.manager.add").click()
        XCTAssertTrue(element(app, "mcp.editor").waitForExistence(timeout: 5))
        app.buttons["Manual"].firstMatch.click()

        element(app, "mcp.field.name").click()
        paste("gamma", into: app)
        element(app, "mcp.field.command").click()
        paste("node", into: app)
        element(app, "mcp.field.args").click()
        paste("server.js", into: app)
        XCTAssertTrue(eventually { (self.element(app, "mcp.target.cursor").value as? Int) == 1 }, "writable agents are picked")

        element(app, "mcp.editor.save").click()
        XCTAssertTrue(eventually { !self.element(app, "mcp.editor").exists })
        let note = element(app, "mcp.manager.note")
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertTrue(text(note).contains("gamma added to"))
        XCTAssertTrue(element(app, "mcp.manager.row.gamma").waitForExistence(timeout: 5))

        element(app, "mcp.manager.undo").click()
        XCTAssertTrue(eventually { !self.element(app, "mcp.manager.row.gamma").exists }, "undo removes it everywhere")
        XCTAssertTrue(text(element(app, "mcp.manager.note")).contains("Undone"))
        app.terminate()
    }

    func testDisablingOnCodexAppliesAtOnceWithUndo() {
        let app = launchWithMcp()
        openManager(app, server: "beta")
        let toggle = element(app, "mcp.detail.enabled.codex")
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "mcp.detail.enabled.claude").exists, "Claude Code has no enabled flag")
        toggle.click()
        XCTAssertTrue(element(app, "mcp.detail.disabled.codex").waitForExistence(timeout: 5), "no confirmation")

        element(app, "mcp.manager.undo").click()
        XCTAssertTrue(eventually { !self.element(app, "mcp.detail.disabled.codex").exists })
        app.terminate()
    }

    func testCopyingToAnAgentThatLacksTheServer() {
        let app = launchWithMcp()
        openManager(app, server: "alpha")
        XCTAssertFalse(element(app, "mcp.detail.path.cursor").exists)
        element(app, "mcp.detail.copy.cursor").click()
        let path = element(app, "mcp.detail.path.cursor")
        XCTAssertTrue(path.waitForExistence(timeout: 5))
        XCTAssertTrue(text(path).hasSuffix(".cursor/mcp.json"))
        XCTAssertTrue(text(element(app, "mcp.manager.note")).contains("alpha copied to Cursor"))
        // The secret travelled inside the store: Cursor's copy is masked too.
        XCTAssertFalse(app.staticTexts["sk-test-0123456789abcd"].exists)
        app.terminate()
    }

    func testRemovingAsksOnceAndABackupRestoresIt() {
        let app = launchWithMcp()
        openManager(app, server: "beta")
        element(app, "mcp.detail.remove.codex").click()
        let confirm = element(app, "mcp.remove.confirm")
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "asks once")
        confirm.click()
        XCTAssertTrue(eventually { !self.element(app, "mcp.manager.row.beta").exists })
        XCTAssertFalse(element(app, "mcp.manager.undo").exists, "a removal is taken back from Backups")

        // Codex's file still exists; restore its backup through another server's record.
        element(app, "mcp.manager.add").click()
        XCTAssertTrue(element(app, "mcp.editor").waitForExistence(timeout: 5))
        app.buttons["Manual"].firstMatch.click()
        element(app, "mcp.field.name").click()
        paste("delta", into: app)
        element(app, "mcp.field.command").click()
        paste("node", into: app)
        element(app, "mcp.target.claude").click()
        element(app, "mcp.editor.save").click()
        let delta = element(app, "mcp.manager.row.delta")
        XCTAssertTrue(delta.waitForExistence(timeout: 5))
        delta.click()
        element(app, "mcp.detail.backups.codex").click()
        let restore = element(app, "mcp.backups.restore.0")
        XCTAssertTrue(restore.waitForExistence(timeout: 5))
        // The newest backup is the file before delta was added: beta already removed.
        element(app, "mcp.backups.restore.1").click()
        let confirmRestore = element(app, "mcp.backups.confirm")
        XCTAssertTrue(confirmRestore.waitForExistence(timeout: 5), "asks once")
        confirmRestore.click()
        XCTAssertTrue(element(app, "mcp.manager.row.beta").waitForExistence(timeout: 5), "beta is back")
        app.terminate()
    }

    func testIntroIsOfferedOnceAndOpensTheManager() {
        let root = makeTemporaryDataRoot()
        let app = launchWithMcp(root: root, extra: ["-AletheUITestMcpIntro", "YES"])
        XCTAssertTrue(element(app, "mcp.intro").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "mcp.intro.agent.claude").waitForExistence(timeout: 5))
        element(app, "mcp.intro.open").click()
        XCTAssertTrue(element(app, "mcp.manager").waitForExistence(timeout: 5))
        app.terminate()

        let relaunched = launchWithMcp(root: root, extra: ["-AletheUITestMcpIntro", "YES"])
        XCTAssertTrue(element(relaunched, "workspace.empty").waitForExistence(timeout: 5))
        XCTAssertFalse(element(relaunched, "mcp.intro").waitForExistence(timeout: 3), "seen once")
        relaunched.terminate()
    }

    /// HT: at 120 % zoom the panel's controls take clicks where they are drawn.
    func testPanelControlsReceiveClicksWhenZoomed() {
        let app = launchWithMcp()
        XCTAssertTrue(element(app, "workspace.empty").waitForExistence(timeout: 5))
        for _ in 0..<2 {
            app.menuBars.menuBarItems["View"].click()
            app.menuItems["Zoom In"].click()
        }
        openPanel(app)

        let chip = element(app, "mcp.panel.agent.claude")
        chip.click()
        XCTAssertTrue(eventually { self.text(self.element(app, "mcp.panel.stats")).contains("1 of 2") }, "filter chip")
        chip.click()

        element(app, "mcp.panel.search").click()
        paste("bet", into: app)
        XCTAssertTrue(eventually { !self.element(app, "mcp.panel.row.alpha").exists }, "search field")

        element(app, "mcp.panel.section").radioButtons["Skills"].click()
        XCTAssertTrue(eventually { self.text(self.element(app, "mcp.panel.stats")).hasPrefix("Skills") }, "section switch")
        element(app, "mcp.panel.section").radioButtons["Servers"].click()

        element(app, "mcp.panel.row.beta").click()
        XCTAssertTrue(element(app, "mcp.manager").waitForExistence(timeout: 5), "row")
        element(app, "mcp.manager.done").click()
        app.terminate()
    }
}
