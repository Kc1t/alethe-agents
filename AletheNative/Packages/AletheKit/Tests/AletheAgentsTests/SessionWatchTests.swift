import Foundation
import Testing
@testable import AletheAgents

@Suite struct SessionWatchTests {
    private let start = Date(timeIntervalSince1970: 10)
    private func session(_ id: String, _ time: TimeInterval) -> SessionSnapshot {
        SessionSnapshot(id: id, modifiedAt: Date(timeIntervalSince1970: time))
    }

    @Test func followsEveryNewChatAndAnOlderChatResumedAgain() {
        var watch = SessionWatch()
        #expect(watch.reconcile(sessions: [session("first", 11)], currentID: "first",
                                startedAt: start, claimedByOthers: []) == nil)
        #expect(watch.reconcile(sessions: [session("first", 11), session("second", 12)], currentID: "first",
                                startedAt: start, claimedByOthers: []) == "second")
        // The workspace acknowledges the discovered id, which is authoritative for this poll.
        _ = watch.reconcile(sessions: [session("first", 11), session("second", 12)], currentID: "second",
                            startedAt: start, claimedByOthers: [])
        #expect(watch.reconcile(sessions: [session("first", 13), session("second", 12)], currentID: "second",
                                startedAt: start, claimedByOthers: []) == "first")
    }

    @Test func ignoresOldClaimedAndAmbiguousSessions() {
        var watch = SessionWatch()
        #expect(watch.reconcile(sessions: [session("old", 1), session("held", 12)], currentID: nil,
                                startedAt: start, claimedByOthers: ["held"]) == nil)
        #expect(watch.reconcile(sessions: [session("a", 13), session("b", 14)], currentID: nil,
                                startedAt: start, claimedByOthers: []) == nil)
    }

    @Test func hookUpdateWinsOverAnInFlightSnapshot() {
        var watch = SessionWatch()
        _ = watch.reconcile(sessions: [session("first", 11)], currentID: "first",
                            startedAt: start, claimedByOthers: [])
        #expect(watch.reconcile(sessions: [session("stale", 12)], currentID: "hook-chat",
                                startedAt: start, claimedByOthers: []) == nil)
    }

    @Test func rolloutFixturesTrackNewAndPreviouslyExistingSessions() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appending(path: ".codex/sessions/2026/10/18")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        func write(_ id: String, cwd: String, at time: TimeInterval) throws {
            let file = directory.appending(path: "rollout-\(id).jsonl")
            let meta: [String: Any] = ["type": "session_meta", "payload": ["id": id, "cwd": cwd]]
            var data = try JSONSerialization.data(withJSONObject: meta)
            data.append(Data("\n{unfinished".utf8))
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: time)], ofItemAtPath: file.path)
        }
        try write("first", cwd: "/repo", at: 11)
        try write("foreign", cwd: "/elsewhere", at: 99)
        var watch = SessionWatch()
        let initial = await SessionWatch.snapshot(.codex, cwd: "/repo/", homeDirectory: root.path)
        #expect(initial.map(\.id) == ["first"])
        _ = watch.reconcile(sessions: initial, currentID: "first", startedAt: start, claimedByOthers: [])
        try write("next", cwd: "/repo", at: 12)
        let next = await SessionWatch.snapshot(.codex, cwd: "/repo", homeDirectory: root.path)
        #expect(watch.reconcile(sessions: next, currentID: "first", startedAt: start, claimedByOthers: []) == "next")
        _ = watch.reconcile(sessions: next, currentID: "next", startedAt: start, claimedByOthers: [])
        try write("first", cwd: "/repo", at: 13)
        let resumed = await SessionWatch.snapshot(.codex, cwd: "/repo", homeDirectory: root.path)
        #expect(watch.reconcile(sessions: resumed, currentID: "next", startedAt: start, claimedByOthers: []) == "first")
    }
}
