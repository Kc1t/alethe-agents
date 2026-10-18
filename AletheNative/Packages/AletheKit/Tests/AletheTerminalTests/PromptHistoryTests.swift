import Testing
@testable import AletheTerminal

/// Ports of upstream `terminalWrite.test.ts` (`applyPromptHistoryInput`) plus recall and escapes.
@Suite struct PromptHistoryTests {
    @Test func recordsSeveralSubmittedLinesAtOnce() {
        var history = PromptHistory()
        let changed = history.record("first\rsecond\r")
        #expect(changed)
        #expect(history.entries == ["first", "second"])
    }

    @Test func neverRetainsOversizedPastes() {
        var history = PromptHistory(entries: ["existing"])
        history.currentLine = "prefix"
        let changed = history.record(String(repeating: "x", count: PromptHistory.maxTrackedPromptLength + 1))
        #expect(!changed)
        #expect(history.currentLine == "")
        #expect(history.overflow)
        #expect(history.entries == ["existing"])
    }

    @Test func linesSpanInputChunksAndCtrlUClears() {
        var history = PromptHistory()
        history.record("/ne")
        history.record("w\r")
        history.record("old text\u{15}/clear\r")
        #expect(history.entries == ["/new", "/clear"])
    }

    @Test func keepsTheLastFiftyWithoutConsecutiveDuplicatesOrShortLines() {
        var history = PromptHistory()
        for index in 0..<10_000 { history.record("task-\(index)\r") }
        history.record("task-9999\r")
        history.record("x\r")
        history.record("  \r")
        #expect(history.entries.count == 50)
        #expect(history.entries.last == "task-9999")
        #expect(history.currentLine == "")
    }

    @Test func backspaceEditsAndCRLFSubmits() {
        var history = PromptHistory()
        history.record("lss\u{7f} -la\r\n")
        #expect(history.entries == ["ls -la"])
    }

    @Test func escapeSequencesAreNotPromptText() {
        var history = PromptHistory()
        history.record("git\u{1b}[A st\u{1b}OB\u{1b}[200~atus\u{1b}[201~\r")
        #expect(history.entries == ["git status"])
    }

    @Test func recallWalksBackAndForward() {
        var history = PromptHistory(entries: ["one", "two", "three"])
        var shown: [String?] = []
        for direction in [PromptHistory.Direction.older, .older, .older, .older, .newer, .newer, .newer, .newer] {
            shown.append(history.recall(direction))
        }
        #expect(shown == ["three", "two", "one", "one", "two", "three", "", ""],
                "stops at the oldest; past the newest is an empty line")
        history.record("four\r")
        let afterSubmit = history.recall(.older)
        #expect(afterSubmit == "four", "submitting resets the position")
        var empty = PromptHistory()
        let nothing = empty.recall(.older)
        #expect(nothing == nil)
        #expect(PromptHistory.recallInput("ls") == "\u{15}ls")
    }
}

struct PromptHistoryCleanupTests {
    @Test func persistedHistoryIsBoundedAndUntrustedEntriesAreDropped() {
        let history = PromptHistory(entries: ["ok", "ok", "x", "  ", "bad\u{1b}[A", String(repeating: "x", count: 4097), " end "])
        #expect(history.entries == ["ok", "end"])
    }

    @Test func canceledInputIsNeverCombinedWithTheNextCommand() {
        var history = PromptHistory()
        history.record("discard\u{3}keep\r")
        #expect(history.entries == ["keep"])
    }

    @Test func reverseSearchFindsRepeatedLiteralMatchesWithoutWrapping() {
        var history = PromptHistory(entries: ["echo [a]", "other", "git [a]"])
        let first = history.reverseSearch("[a]")
        let second = history.reverseSearch("[a]")
        let exhausted = history.reverseSearch("[a]")
        #expect(first == "git [a]")
        #expect(second == "echo [a]")
        #expect(exhausted == nil)
        #expect(history.currentLine == "echo [a]")
    }
}

struct PromptHistoryUnicodeLimitTests {
    @Test func limitUsesWebUTF16LengthIncludingCombinedCharacters() {
        var history = PromptHistory()
        let pasted = String(repeating: "\u{301}", count: 4097)
        history.record(pasted)
        #expect(history.overflow)
        history.record("\rnext\r")
        #expect(history.entries == ["next"])
    }
}
