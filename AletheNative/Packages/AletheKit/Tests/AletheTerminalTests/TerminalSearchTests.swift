import Testing
@testable import AletheTerminal

@MainActor
@Suite struct TerminalSearchTests {
    @Test func webQueryChangesDiscardStaleProgress() {
        let search = TerminalSearch()
        _ = search.setNeedle("alpha", resetProgress: true)
        search.total = 12
        search.selected = 2
        _ = search.setNeedle("alpha", resetProgress: true)
        #expect(search.status == .match(position: 3, total: 12))
        #expect(search.setNeedle("beta\nignored", resetProgress: true) == "beta")
        #expect(search.status == .none)
        #expect(search.total == nil)
        #expect(search.selected == nil)
    }

    @Test func nativeProgressBehaviorIsPreserved() {
        let search = TerminalSearch()
        _ = search.setNeedle("alpha", resetProgress: false)
        search.total = 12
        search.selected = 2
        _ = search.setNeedle("beta", resetProgress: false)
        #expect(search.status == .match(position: 3, total: 12))
        _ = search.setNeedle("", resetProgress: false)
        #expect(search.total == nil)
        #expect(search.selected == nil)
    }

    @Test func statusFollowsGhosttyProgress() {
        let search = TerminalSearch()
        #expect(search.status == .none)
        search.needle = "alpha"
        #expect(search.status == .none, "still counting")
        search.total = 0
        #expect(search.status == .noResults)
        search.total = 4
        #expect(search.status == .count(4))
        search.selected = 0
        #expect(search.status == .match(position: 1, total: 4))
        search.selected = 9
        #expect(search.status == .count(4), "a stale index is not shown")
        search.needle = ""
        #expect(search.status == .none)
    }

    @Test func bindingNeedleIsOneCleanLine() {
        #expect(TerminalSearch.bindingNeedle("alpha") == "alpha")
        #expect(TerminalSearch.bindingNeedle("first\nsecond") == "first")
        #expect(TerminalSearch.bindingNeedle("a\u{1b}b\tc") == "abc")
        #expect(TerminalSearch.bindingNeedle("ação 🚀") == "ação 🚀")
    }
}
