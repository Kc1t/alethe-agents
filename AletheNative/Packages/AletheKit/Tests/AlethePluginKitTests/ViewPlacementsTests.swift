import Foundation
import Testing
@testable import AlethePluginKit

private func tab(_ id: String, _ side: SidebarSide = .left) -> SidebarTabContribution {
    SidebarTabContribution(id: id, title: id, symbol: "circle", side: side, viewID: id)
}

private let tabs = [tab("git"), tab("todos"), tab("docs", .right), tab("mcp", .right)]

private func ids(_ tabs: [SidebarTabContribution]) -> [String] { tabs.map(\.id) }

@Suite("ViewPlacements")
struct ViewPlacementsTests {
    @Test func defaultsFollowContributions() {
        let arranged = ViewPlacements.empty.arranged(tabs)
        #expect(ids(arranged.left) == ["git", "todos"])
        #expect(ids(arranged.right) == ["docs", "mcp"])
    }

    @Test func movesBetweenSides() {
        var placements = ViewPlacements.empty
        placements.move("todos", to: .right, at: 1, in: tabs)
        let arranged = placements.arranged(tabs)
        #expect(ids(arranged.left) == ["git"])
        #expect(ids(arranged.right) == ["docs", "todos", "mcp"])
        #expect(placements.side(of: "todos", in: tabs) == .right)
    }

    @Test func reordersWithinASideAndClampsTheIndex() {
        var placements = ViewPlacements.empty
        placements.move("git", to: .left, at: 99, in: tabs)
        #expect(ids(placements.arranged(tabs).left) == ["todos", "git"])
        placements.move("git", to: .left, at: -3, in: tabs)
        #expect(ids(placements.arranged(tabs).left) == ["git", "todos"])
    }

    @Test func newTabsAppendOnTheirContributedSide() {
        var placements = ViewPlacements.empty
        placements.move("docs", to: .left, at: 0, in: tabs)
        let arranged = placements.arranged(tabs + [tab("extra-view"), tab("graph", .right)])
        #expect(ids(arranged.left) == ["docs", "git", "todos", "extra-view"])
        #expect(ids(arranged.right) == ["mcp", "graph"])
    }

    @Test func keepsPlacementsOfAbsentTabs() {
        var placements = ViewPlacements.empty
        placements.move("todos", to: .right, at: 0, in: tabs)
        let withoutTodos = tabs.filter { $0.id != "todos" }
        #expect(!ids(placements.arranged(withoutTodos).right).contains("todos"))
        placements.move("git", to: .right, at: 0, in: withoutTodos)
        #expect(placements.right.contains("todos"))
        #expect(ids(placements.arranged(tabs).right) == ["git", "docs", "mcp", "todos"])
        #expect(placements.side(of: "todos", in: tabs) == .right)
    }

    @Test func ignoresUnknownIDsAndDuplicates() {
        var placements = ViewPlacements(left: ["git", "git"], right: ["git"])
        placements.move("nope", to: .right, at: 0, in: tabs)
        let arranged = placements.arranged(tabs)
        #expect(ids(arranged.left) == ["git", "todos"])
        #expect(ids(arranged.right) == ["docs", "mcp"])
    }

    @Test func roundTripsAndResets() throws {
        var placements = ViewPlacements.empty
        placements.move("mcp", to: .left, at: 1, in: tabs)
        let data = try JSONEncoder().encode(placements)
        #expect(try JSONDecoder().decode(ViewPlacements.self, from: data) == placements)
        placements.reset()
        #expect(placements == .empty)
    }
}
