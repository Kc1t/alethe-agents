import AletheFoundation
import AletheGit
import Foundation
import Testing
@testable import AletheIntegrations

/// A temporary repository isolated from the user's git configuration, with a committed
/// `.planning/roadmap.md` and `code.txt` (upstream `planning_repo`).
private struct PlanningRepo {
    static let runner = GitRunner(environment: [
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
    ])

    let root: URL
    let audit: PlanningAudit

    init(commit: Bool = true, bus: EventBus? = nil) async throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "alethe-planning-\(UUID().uuidString)", directoryHint: .isDirectory)
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root.appending(path: ".planning"), withIntermediateDirectories: true)
        audit = PlanningAudit(runner: Self.runner, repositories: GitRepositories(), bus: bus)
        try await git("init", "-b", "main")
        try await git("config", "user.name", "Alethe Test")
        try await git("config", "user.email", "alethe@example.invalid")
        try await git("config", "commit.gpgsign", "false")
        try write("code.txt", "code\n")
        try write(".planning/roadmap.md", "- [ ] task 1\n")
        if commit {
            try await git("add", ".")
            try await git("commit", "-m", "base")
        }
    }

    @discardableResult
    func git(_ arguments: String...) async throws -> String {
        try await Self.runner.run(arguments, in: root).text
    }

    func write(_ path: String, _ text: String) throws {
        try Data(text.utf8).write(to: root.appending(path: path))
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

// Upstream `planning.rs` tests.
@Suite struct PlanningAuditGoldenTests {
    @Test func recordsScopedAuditCommitWithAgentTrailer() async throws {
        let repo = try await PlanningRepo()
        defer { repo.remove() }

        #expect(try await repo.audit.record(repository: repo.root) == nil)

        try repo.write(".planning/roadmap.md", "- [x] task 1\n")
        try repo.write("code.txt", "changed\n")
        let commit = try #require(try await repo.audit.record(repository: repo.root, agentID: "agent-42",
                                                              reason: "concluiu task 1"))
        #expect(commit.subject.contains("concluiu task 1"))

        let status = try await repo.git("status", "--porcelain")
        #expect(status.contains("code.txt"))
        #expect(!status.contains("roadmap.md"))

        let history = try await repo.audit.history(repository: repo.root, limit: 10)
        #expect(history.count == 2) // base + audit
        #expect(history[0].agentID == "agent-42")
        #expect(history[0].subject.contains("gsd(alethe)"))
        #expect(history[0].timestampMS > 0)
        #expect(history[1].agentID == nil)
    }
}

@Suite(.timeLimit(.minutes(1))) struct PlanningAuditTests {
    @Test func unrelatedStagedFilesStayStagedAndOutOfTheCommit() async throws {
        let repo = try await PlanningRepo()
        defer { repo.remove() }
        try repo.write("code.txt", "staged\n")
        try await repo.git("add", "code.txt")
        try repo.write(".planning/roadmap.md", "- [x] task 1\n")

        let commit = try #require(try await repo.audit.record(repository: repo.root, reason: "  "))
        #expect(commit.subject == "gsd(alethe): planning update")
        #expect(commit.agentID == nil)

        let files = try await repo.git("show", "--name-only", "--pretty=format:", "HEAD")
        #expect(files.trimmingCharacters(in: .whitespacesAndNewlines) == ".planning/roadmap.md")
        let status = try await repo.git("status", "--porcelain")
        #expect(status.contains("M  code.txt"))
        let body = try await repo.git("log", "-1", "--pretty=format:%B")
        #expect(body.contains("Alethe-Agent: unknown"))
    }

    @Test func recordPublishesPlanningCommitted() async throws {
        let bus = EventBus()
        let events = await bus.subscribe()
        let repo = try await PlanningRepo(bus: bus)
        defer { repo.remove() }
        try repo.write(".planning/notes.md", "new\n")

        let commit = try #require(try await repo.audit.record(repository: repo.root, agentID: "agent-7",
                                                              reason: "notes", projectID: "project-1"))
        var iterator = events.makeAsyncIterator()
        let event = try #require(await iterator.next())
        #expect(event.type == BusEventType.planningCommitted)
        #expect(event.taskID == "project-1")
        #expect(event.agentID == "agent-7")
        #expect(event.correlationID.hasPrefix("gsd-audit-"))
        #expect(event.data == .object(["hash": .string(commit.hash), "subject": .string("gsd(alethe): notes")]))
    }

    @Test func missingPlanningFolderIsAnError() async throws {
        let repo = try await PlanningRepo()
        defer { repo.remove() }
        try FileManager.default.removeItem(at: repo.root.appending(path: ".planning"))
        await #expect(throws: PlanningAuditError.planningDirectoryNotFound) {
            try await repo.audit.record(repository: repo.root)
        }
    }

    @Test func newRepositoryHasAnEmptyHistory() async throws {
        let repo = try await PlanningRepo(commit: false)
        defer { repo.remove() }
        #expect(try await repo.audit.history(repository: repo.root).isEmpty)
    }

    @Test func historyIsScopedToPlanningAndLimited() async throws {
        let repo = try await PlanningRepo()
        defer { repo.remove() }
        try repo.write("code.txt", "outside\n")
        try await repo.git("commit", "-am", "code only")
        for step in 1...3 {
            try repo.write(".planning/roadmap.md", "- [ ] step \(step)\n")
            try await repo.audit.record(repository: repo.root, agentID: "agent-\(step)", reason: "step \(step)")
        }
        let all = try await repo.audit.history(repository: repo.root)
        #expect(all.map(\.subject) == ["gsd(alethe): step 3", "gsd(alethe): step 2", "gsd(alethe): step 1", "base"])
        #expect(all.first?.author == "Alethe Test")
        let limited = try await repo.audit.history(repository: repo.root, limit: 2)
        #expect(limited.map(\.agentID) == ["agent-3", "agent-2"])
    }

    @Test func parsesHistoryRecords() {
        let raw = "abc\u{1f}Ana\u{1f}1700000000\u{1f}gsd(alethe): x\u{1f}agent-1\u{1e}\n"
            + "def\u{1f}Bo\u{1f}oops\u{1f}base\u{1f}\u{1e}\n"
            + "short\u{1f}record\u{1e}\n"
            + "ghi\u{1f}Cy\u{1f}1\u{1f}no trailer field\u{1e}"
        let commits = PlanningAudit.parseHistory(raw)
        #expect(commits == [
            PlanningCommit(hash: "abc", author: "Ana", timestampMS: 1_700_000_000_000, subject: "gsd(alethe): x", agentID: "agent-1"),
            PlanningCommit(hash: "def", author: "Bo", timestampMS: 0, subject: "base", agentID: nil),
            PlanningCommit(hash: "ghi", author: "Cy", timestampMS: 1000, subject: "no trailer field", agentID: nil),
        ])
        #expect(PlanningAudit.parseHistory("").isEmpty)
    }

    @Test func commitEncodesWithUpstreamKeys() throws {
        let commit = PlanningCommit(hash: "h", author: "a", timestampMS: 5, subject: "s", agentID: "x")
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(commit)) as? [String: Any]
        #expect(Set(object?.keys.map { $0 } ?? []) == ["hash", "author", "timestampMs", "subject", "agentId"])
    }
}

@Suite(.timeLimit(.minutes(1))) struct PlanningAutocommitTests {
    private actor Commits {
        var roots: [(URL, String?)] = []
        func add(_ root: URL, _ projectID: String?) { roots.append((root, projectID)) }
    }

    private static func updated(_ dir: String, project: String = "p1") -> BusEvent {
        BusEvent(type: BusEventType.planningUpdated, correlationID: "gsd-test", taskID: project,
                 data: .object(["action": .string("Modify"), "planning_dir": .string(dir)]))
    }

    @Test func generationsKeepOnlyTheLatestPerKey() {
        var generations = DebounceGenerations()
        let first = generations.bump("/a/.planning")
        let second = generations.bump("/a/.planning")
        let other = generations.bump("/b/.planning")
        #expect(!generations.isLatest(first, for: "/a/.planning"))
        #expect(generations.isLatest(second, for: "/a/.planning"))
        #expect(generations.isLatest(other, for: "/b/.planning"))
        #expect(!generations.isLatest(1, for: "/c/.planning"))
    }

    @Test func burstsCommitOnceAfterTheLastChangePerFolder() async throws {
        let commits = Commits()
        let autocommit = PlanningAutocommit(bus: EventBus(), delay: .milliseconds(80)) { root, projectID in
            await commits.add(root, projectID)
        }
        await autocommit.setEnabled(true)
        for _ in 0..<3 { await autocommit.handle(Self.updated("/repo/a/.planning")) }
        await autocommit.handle(Self.updated("/repo/b/.planning", project: "p2"))
        // Wait for both folders (generous under load), then give a duplicate commit time to show up.
        let deadline = ContinuousClock.now + .seconds(10)
        while await commits.roots.count < 2, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        try await Task.sleep(for: .milliseconds(300))
        let roots = await commits.roots
        #expect(roots.count == 2)
        #expect(Set(roots.map(\.0.path)) == ["/repo/a", "/repo/b"])
        #expect(Set(roots.compactMap(\.1)) == ["p1", "p2"])
    }

    @Test func offByDefaultAndIgnoresOtherEvents() async throws {
        let commits = Commits()
        let autocommit = PlanningAutocommit(bus: EventBus(), delay: .milliseconds(20)) { root, projectID in
            await commits.add(root, projectID)
        }
        #expect(await !autocommit.isEnabled)
        await autocommit.handle(Self.updated("/repo/a/.planning"))
        await autocommit.setEnabled(true)
        await autocommit.handle(BusEvent(type: BusEventType.planningCommitted, correlationID: "x",
                                         data: .object(["planning_dir": .string("/repo/a/.planning")])))
        await autocommit.handle(BusEvent(type: BusEventType.planningUpdated, correlationID: "x"))
        try await Task.sleep(for: .milliseconds(200))
        #expect(await commits.roots.isEmpty)
    }

    @Test func disablingCancelsPendingCommits() async throws {
        let commits = Commits()
        let autocommit = PlanningAutocommit(bus: EventBus(), delay: .milliseconds(100)) { root, projectID in
            await commits.add(root, projectID)
        }
        await autocommit.setEnabled(true)
        await autocommit.handle(Self.updated("/repo/a/.planning"))
        await autocommit.setEnabled(false)
        try await Task.sleep(for: .milliseconds(300))
        #expect(await commits.roots.isEmpty)
    }

    @Test func subscribesToTheBusAndCommitsARealRepository() async throws {
        let bus = EventBus()
        let repo = try await PlanningRepo()
        defer { repo.remove() }
        let autocommit = PlanningAutocommit(bus: bus, audit: repo.audit, delay: .milliseconds(50))
        await autocommit.start()
        await autocommit.setEnabled(true)
        try repo.write(".planning/roadmap.md", "- [x] task 1\n")
        let planningDir = repo.root.appending(path: ".planning").path
        await bus.publish(Self.updated(planningDir))
        var history: [PlanningCommit] = []
        for _ in 0..<40 where history.first?.subject != "gsd(alethe): auto-commit" {
            try await Task.sleep(for: .milliseconds(100))
            history = try await repo.audit.history(repository: repo.root)
        }
        await autocommit.stop()
        #expect(history.first?.subject == "gsd(alethe): auto-commit")
        #expect(history.first?.agentID == "unknown")
    }
}
