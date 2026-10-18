import Foundation
import Testing
import XCTest
@testable import AletheTerminal

@Suite struct ScrollbackFileTests {
    private func file(cap: Int = 1024) -> (ScrollbackFile, URL) {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "alethe-scrollback-\(UUID().uuidString)/tab.bin")
        return (ScrollbackFile(url: url, cap: cap, flushInterval: .milliseconds(20)), url)
    }

    @Test func appendsAreBatchedAndLoadable() {
        let (scrollback, url) = file()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        #expect(scrollback.load().isEmpty)
        scrollback.append(Data("one ".utf8))
        scrollback.append(Data("two".utf8))
        scrollback.flush()
        #expect(String(decoding: scrollback.load(), as: UTF8.self) == "one two")
    }

    @Test func writesWithoutAnExplicitFlush() async throws {
        let (scrollback, url) = file()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        scrollback.append(Data("later".utf8))
        try await Task.sleep(for: .milliseconds(300))
        #expect((try? Data(contentsOf: url)) == Data("later".utf8))
    }

    @Test func compactsPastTwiceTheCapAndLoadsOnlyTheTail() throws {
        let (scrollback, url) = file(cap: 100)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        for index in 0..<30 {
            scrollback.append(Data(String(format: "%09d|", index).utf8))
            scrollback.flush()
        }
        let onDisk = try Data(contentsOf: url)
        #expect(onDisk.count <= 200, "compacted, never more than twice the cap")
        let loaded = scrollback.load()
        #expect(loaded.count == 100)
        #expect(String(decoding: loaded, as: UTF8.self).hasSuffix("000000029|"))
    }

    @Test func oversizedRestoredFileLoadsOnlyItsTail() throws {
        let (scrollback, url) = file(cap: 100)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var bytes = Data(repeating: 0x41, count: 1024 * 1024)
        bytes.append(Data(repeating: 0x42, count: 100))
        try bytes.write(to: url)
        #expect(scrollback.load() == Data(repeating: 0x42, count: 100))
        scrollback.append(Data("end".utf8))
        scrollback.flush()
        #expect(scrollback.load() == Data(repeating: 0x42, count: 97) + Data("end".utf8))
        #expect(try Data(contentsOf: url).count == 100)
    }

    @Test func largeBurstKeepsTheNewestBytesInOrder() throws {
        let (scrollback, url) = file(cap: 100)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var expected = Data()
        for index in 0..<100 {
            let bytes = Data(repeating: UInt8(index), count: 64)
            expected.append(bytes)
            scrollback.append(bytes)
        }
        scrollback.flush()
        #expect(scrollback.load() == Data(expected.suffix(100)))
        #expect(try Data(contentsOf: url).count <= 200)
    }

    @Test func clearAndDelete() {
        let (scrollback, url) = file()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        scrollback.append(Data("secret".utf8))
        scrollback.clear()
        scrollback.flush()
        #expect(scrollback.load().isEmpty, "clear drops pending bytes too")
        scrollback.append(Data("again".utf8))
        scrollback.flush()
        scrollback.delete()
        scrollback.flush()
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }
}

/// P: the cost of persisting ten busy terminals (plan P2-7).
final class ScrollbackFilePerformanceTests: XCTestCase {
    func testTenBusyTerminalsFlushCost() {
        let directory = FileManager.default.temporaryDirectory.appending(path: "alethe-scrollback-perf-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let chunk = Data(repeating: 0x41, count: 16 * 1024)
        measure(metrics: [XCTClockMetric(), XCTStorageMetric()]) {
            let files = (0..<10).map { ScrollbackFile(url: directory.appending(path: "\($0).bin")) }
            for _ in 0..<64 { for file in files { file.append(chunk) } }  // 10 MiB in all
            for file in files { file.flush() }
        }
    }
}

struct ReplayResetTests {
    @Test func replayResetTurnsOffInputModes() {
        let reset = String(decoding: ScrollbackFile.replayReset, as: UTF8.self)
        // Focus reporting left on made the new process echo `^[[O`; cursor-key mode turns arrows into `ESC O A`.
        for mode in ["\u{1b}[?1004l", "\u{1b}[?1l", "\u{1b}[?2004l", "\u{1b}[?1049l", "\u{1b}[=0;1u"] {
            #expect(reset.contains(mode))
        }
        #expect(reset.hasSuffix("\u{1b}[22J\u{1b}[H"))
    }

    @Test func replayDropsTerminalQueries() {
        let esc = "\u{1b}"
        let queries = [
            "\(esc)[c", "\(esc)[>0c", "\(esc)[>q", "\(esc)[?u", "\(esc)[?2026$p", "\(esc)[6n", "\(esc)[?996n",
            "\(esc)[14t", "\(esc)[16t", "\(esc)]11;?\u{07}", "\(esc)]4;1;?\(esc)\\", "\(esc)P+q544e\(esc)\\",
            "\(esc)_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\(esc)\\",
        ]
        let kept = "\(esc)[1;32mhello\(esc)[0m \(esc)[2J\(esc)[?25l\(esc)[22;0t\(esc)]0;title\u{07}é\r\n"
        let input = Data((queries.joined() + kept).utf8)
        #expect(ScrollbackFile.withoutQueries(input) == Data(kept.utf8))
    }
}

struct ScrollbackBoundaryTests {
    @Test func truncationSkipsUTF8ContinuationBytesAndANSIParameters() {
        #expect(ScrollbackFile.safeTail(Data("old😀tail".utf8), capacity: 7) == Data("tail".utf8))
        #expect(ScrollbackFile.safeTail(Data("old\u{1b}[38;2;100;200;255mtext".utf8), capacity: 10) == Data("text".utf8))
        for sequence in ["\u{1b}]0;private title\u{7}", "\u{1b}Pprivate payload\u{1b}\\"] {
            #expect(ScrollbackFile.safeTail(Data(("old" + sequence + "tail").utf8), capacity: 10) == Data("tail".utf8))
        }
    }

    @Test func interruptedControlStringDoesNotLeakItsPayload() {
        #expect(ScrollbackFile.safeTail(Data("old\u{1b}]0;unfinished title".utf8), capacity: 8).isEmpty)
    }

    @Test func compactionAndReopenKeepTheSameSafeTail() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "pane.bin")
        let file = ScrollbackFile(url: url, cap: 10)
        file.append(Data("old\u{1b}]0;a long private title\u{7}tail".utf8))
        file.flush()
        #expect(file.load() == Data("tail".utf8))
        #expect(ScrollbackFile(url: url, cap: 10).load() == Data("tail".utf8))
        #expect(try Data(contentsOf: url).count <= 20)
    }
}

struct ScrollbackFailureTests {
    @Test func failedWriteRetainsPendingBytesUntilDiskRecovers() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        // A regular file blocks creation of the scrollback's parent directory.
        try Data().write(to: directory)
        let file = ScrollbackFile(url: directory.appending(path: "pane.bin"), flushInterval: .seconds(60))
        file.append(Data("first".utf8))
        file.flush()
        try FileManager.default.removeItem(at: directory)
        file.append(Data("second".utf8))
        file.flush()
        #expect(file.load() == Data("firstsecond".utf8))
    }
}

struct InterruptedReplayTests {
    @Test func dropsIncompleteFinalEscapeSequencesButKeepsFinishedOnes() {
        for fragment in ["\u{1b}", "\u{1b}[38;2;", "\u{1b}]0;unfinished", "\u{1b}Punfinished\u{1b}"] {
            #expect(ScrollbackFile.withoutQueries(Data(("kept" + fragment).utf8)) == Data("kept".utf8))
        }
        let complete = Data("kept\u{1b}[32mgreen\u{1b}[0m".utf8)
        #expect(ScrollbackFile.withoutQueries(complete) == complete)
    }
}
