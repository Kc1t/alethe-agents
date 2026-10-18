import AletheDesign
import AppKit
import Foundation
import Testing
@testable import AletheTerminal

/// Collects what the child prints (it reports `stty size` on start and on every SIGWINCH).
private final class Reports: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func add(_ data: Data) { lock.withLock { text += String(decoding: data, as: UTF8.self) } }
    /// Last "rows cols" line printed.
    var raw: String { lock.withLock { text } }
    var last: (rows: Int, cols: Int)? {
        lock.withLock {
            let lines = text.split(whereSeparator: { $0.isNewline })
            for line in lines.reversed() {
                let parts = line.split(separator: " ")
                if parts.count == 2, let r = Int(parts[0]), let c = Int(parts[1]) { return (r, c) }
            }
            return nil
        }
    }
}

@MainActor
@Suite(.serialized) struct TerminalPaneGridFollowTests {
    private func makeHost(script: String = "trap 'stty size' WINCH; stty size; while :; do sleep 0.05; done") throws -> (NSWindow, NSView, TerminalPaneView, Reports) {
        let pane = try TerminalPaneView(
            launch: PTYLaunch(
                executable: "/bin/sh",
                arguments: ["sh", "-c", script],
                environment: ["PATH": "/usr/bin:/bin"], workingDirectory: nil,
                size: PTYSize(columns: 80, rows: 24)),
            theme: ThemeCatalog.builtin.defaultTheme)
        let reports = Reports()
        _ = pane.tap.observeOutput { reports.add($0) }
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1000, height: 700),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let host = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.contentView = host
        host.addSubview(pane)
        pane.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        window.orderBack(nil)
        return (window, host, pane, reports)
    }

    private func pump(_ seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }

    private func settle(_ pane: TerminalPaneView, _ reports: Reports, label: String) {
        pump(1.0)
        let grid = pane.gridSize
        let seen = reports.last
        #expect(seen?.cols == Int(grid.columns) && seen?.rows == Int(grid.rows),
                "\(label): grid \(grid.columns)x\(grid.rows) child saw \(String(describing: seen)) raw=\(reports.raw.debugDescription)")
    }

    @Test func childFollowsLargeSmallLarge() throws {
        let (window, host, pane, reports) = try makeHost()
        defer { window.close() }
        pump(0.8)
        settle(pane, reports, label: "initial")
        let initial = pane.gridSize
        for size in [CGSize(width: 300, height: 200), CGSize(width: 800, height: 600)] {
            pane.setFrameSize(size)
            settle(pane, reports, label: "\(size)")
        }
        #expect(pane.gridSize.columns == initial.columns && pane.gridSize.rows == initial.rows)
        _ = host
    }

    @Test func childFollowsRapidTinyThenLarge() throws {
        let (window, _, pane, reports) = try makeHost()
        defer { window.close() }
        pump(0.8)
        for w in stride(from: 800.0, through: 40.0, by: -40.0) {
            pane.setFrameSize(CGSize(width: w, height: max(30, w * 0.75)))
            pump(0.016)
        }
        pump(0.05)
        pane.setFrameSize(CGSize(width: 12, height: 12))
        pump(0.03)
        for w in stride(from: 40.0, through: 800.0, by: 40.0) {
            pane.setFrameSize(CGSize(width: w, height: max(30, w * 0.75)))
            pump(0.016)
        }
        settle(pane, reports, label: "rapid")
        #expect(pane.gridSize.columns > 60)
    }

    @Test func childFollowsSuperviewResize() throws {
        let (window, host, pane, reports) = try makeHost()
        defer { window.close() }
        pane.autoresizingMask = [.width, .height]
        pane.frame = host.bounds
        pump(0.8)
        for size in [CGSize(width: 360, height: 220), CGSize(width: 1000, height: 700)] {
            host.setFrameSize(size)
            settle(pane, reports, label: "superview \(size)")
        }
    }

    /// A busy TUI keeps printing while the pane is resized.
    @Test func childFollowsWhileFlooding() throws {
        let flood = "trap 'echo; stty size' WINCH; stty size; while :; do printf '\\033[2J\\033[H'; seq 1 400; sleep 0.01; done"
        let (window, _, pane, reports) = try makeHost(script: flood)
        defer { window.close() }
        pump(0.8)
        for size in [CGSize(width: 300, height: 200), CGSize(width: 90, height: 60), CGSize(width: 800, height: 600),
                     CGSize(width: 500, height: 300), CGSize(width: 800, height: 600)] {
            pane.setFrameSize(size)
            pump(0.15)
        }
        pump(1.5)
        let grid = pane.gridSize
        let seen = reports.last
        #expect(seen?.cols == Int(grid.columns) && seen?.rows == Int(grid.rows),
                "flood: grid \(grid.columns)x\(grid.rows) child saw \(String(describing: seen))")
    }
}

@Suite(.serialized) struct PTYReassertTests {
    /// A winsize the child never heard about (set behind the process's back) is repaired by the
    /// settle safety net: the PTY gets the grid again and the child gets a SIGWINCH.
    @Test func reassertSendsSizeAndSigwinchWhenItDiffers() throws {
        let process = try PTYProcess(
            PTYLaunch(executable: "/bin/sh",
                      arguments: ["sh", "-c", "trap 'stty size' WINCH; stty size; while :; do sleep 0.05; done"],
                      environment: ["PATH": "/usr/bin:/bin"], workingDirectory: nil,
                      size: PTYSize(columns: 80, rows: 24)))
        let reports = Reports()
        process.onOutput = { reports.add($0) }
        process.start()
        defer { process.terminate(grace: .milliseconds(100)) }
        func wait(for rows: Int, cols: Int) -> Bool {
            for _ in 0..<100 {
                if reports.last?.rows == rows, reports.last?.cols == cols { return true }
                Thread.sleep(forTimeInterval: 0.02)
            }
            return false
        }
        #expect(wait(for: 24, cols: 80))
        process.reassertSize(PTYSize(columns: 120, rows: 40))
        #expect(wait(for: 40, cols: 120), "child saw \(String(describing: reports.last))")
    }
}
