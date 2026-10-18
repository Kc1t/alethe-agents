import AletheDesign
import AppKit
import Testing
@testable import AletheTerminal

@MainActor
@Suite struct TerminalPaneResizeTests {
    private func makeView() throws -> TerminalPaneView {
        try TerminalPaneView(
            launch: PTYLaunch(executable: "/bin/sh", arguments: ["sh", "-c", "sleep 5"],
                              environment: ["PATH": "/usr/bin:/bin"], workingDirectory: nil,
                              size: PTYSize(columns: 80, rows: 24)),
            theme: ThemeCatalog.builtin.defaultTheme)
    }

    @Test func surfaceFollowsEveryFrameChangeWithoutALayoutPass() throws {
        let pane = try makeView()
        pane.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        #expect(pane.terminalView.frame.size == CGSize(width: 400, height: 300))
        pane.setFrameSize(CGSize(width: 700, height: 220))
        #expect(pane.terminalView.frame == pane.bounds)
    }

    @Test func surfaceIsRepinnedAfterReparenting() throws {
        let pane = try makeView()
        let first = NSView(frame: CGRect(x: 0, y: 0, width: 300, height: 200))
        let second = NSView(frame: CGRect(x: 0, y: 0, width: 640, height: 480))
        first.addSubview(pane)
        pane.frame = first.bounds
        pane.terminalView.frame = .zero
        pane.removeFromSuperview()
        pane.frame = second.bounds
        second.addSubview(pane)
        #expect(pane.terminalView.frame == pane.bounds)
    }
}
