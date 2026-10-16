import Foundation
import Testing
import AletheIntegrations
@testable import AletheOrchestrator

private actor QueueHarness {
    var context = PromptQueue.Context(availableSlots: 0)
    var launched: [QueueItem] = []
    var cancelled: [String] = []

    func read() -> PromptQueue.Context { context }
    func slots(_ count: Int) { context.availableSlots = count }
    func fitness(_ value: AgentFitness) { context.fitness[WorkerAgent.codex] = value }
    func finish(_ id: String, status: JobStatus, text: String = "") {
        guard let index = context.jobs.firstIndex(where: { $0.id == id }) else { return }
        context.jobs[index].status = status
        context.jobs[index].report = text
        context.availableSlots += 1
    }
    func launch(_ item: QueueItem) -> String {
        launched.append(item)
        let id = "job-\(launched.count)"
        context.jobs.append(Job(id: id, plannerID: item.planner, agent: item.agent,
                                runID: "run-1", runLabel: item.label, spec: item.prompt,
                                cwd: item.cwd, status: .running))
        context.availableSlots -= 1
        return id
    }
    func cancel(_ id: String) { cancelled.append(id) }
    func queue(store: PromptQueueStore? = nil) -> PromptQueue {
        PromptQueue(store: store, read: { await self.read() },
                    delegate: { await self.launch($0) }, cancel: { await self.cancel($0) })
    }
}

@Suite(.timeLimit(.minutes(1))) struct PromptQueueTests {
    @Test func priorityIsDescendingAndTiesKeepInsertionOrder() async throws {
        let harness = QueueHarness()
        let queue = await harness.queue()
        let a = QueueItem(prompt: "a", cwd: "/tmp", priority: 1)
        let b = QueueItem(prompt: "b", cwd: "/tmp", priority: 3)
        let c = QueueItem(prompt: "c", cwd: "/tmp", priority: 1)
        _ = try await queue.add([a, b, c])
        #expect(await queue.list().map(\.id) == [b.id, a.id, c.id])
        await harness.slots(3)
        await queue.tick()
        #expect(await harness.launched.map(\.id) == [b.id, a.id, c.id])
        await queue.shutdown()
    }

    @Test func reorderClearsPriorityAndDeduplicatesIDs() async throws {
        let harness = QueueHarness()
        let queue = await harness.queue()
        let a = QueueItem(prompt: "a", cwd: "/tmp", priority: 9)
        let b = QueueItem(prompt: "b", cwd: "/tmp")
        let c = QueueItem(prompt: "c", cwd: "/tmp")
        _ = try await queue.add([a, b, c])
        await queue.reorder([c.id, c.id, b.id, "unknown"])
        #expect(await queue.list().map(\.id) == [c.id, b.id, a.id])
        await queue.shutdown()
    }

    @Test func releaseConditionsAndFitnessAreBothRequired() {
        let now = Date(timeIntervalSince1970: 1_000)
        let reset = now.addingTimeInterval(100)
        let strained = AgentFitness(worst: "5h", used: 90, resetsAt: reset)
        var item = QueueItem(prompt: "prompt", cwd: "/tmp")
        #expect(item.isEligible(now: now, fitness: nil, settledJobs: []))
        #expect(!item.isEligible(now: now, fitness: strained, settledJobs: []))
        #expect(item.isEligible(now: reset, fitness: strained, settledJobs: []))
        item.release = .at(reset)
        #expect(!item.isEligible(now: now, fitness: nil, settledJobs: []))
        #expect(item.isEligible(now: reset, fitness: nil, settledJobs: []))
        item.release = .afterJob("job-1")
        #expect(!item.isEligible(now: now, fitness: nil, settledJobs: []))
        #expect(item.isEligible(now: now, fitness: nil, settledJobs: ["job-1"]))
        #expect(!item.isEligible(now: now, fitness: strained, settledJobs: ["job-1"]))
        item.state = .waitingLimit(nil)
        #expect(!item.isEligible(now: now, fitness: nil, settledJobs: ["job-1"]))
        #expect(item.isEligible(now: now, fitness: .init(worst: "5h", used: 10), settledJobs: ["job-1"]))
    }

    @Test func jobCompletionReleasesDependencyAndUpdatesState() async throws {
        let harness = QueueHarness()
        await harness.slots(1)
        let queue = await harness.queue()
        let a = QueueItem(prompt: "a", cwd: "/tmp")
        _ = try await queue.add([a])
        let b = QueueItem(prompt: "b", cwd: "/tmp", release: .afterJob("job-1"))
        _ = try await queue.add([b])
        #expect(await harness.launched.count == 1)
        await harness.finish("job-1", status: .done)
        await queue.tick()
        #expect(await queue.list().first { $0.id == a.id }?.state == .done)
        #expect(await harness.launched.map(\.id) == [a.id, b.id])
        await queue.shutdown()
    }

    @Test func nearestResetTimerWakesDispatcherWithoutFitnessEvent() async throws {
        let harness = QueueHarness()
        await harness.slots(1)
        let queue = await harness.queue()
        let reset = Date().addingTimeInterval(0.5)
        await harness.fitness(.init(worst: "5h", used: 100, resetsAt: reset, rateLimited: true))
        let item = QueueItem(prompt: "a", cwd: "/tmp")
        _ = try await queue.add([item])
        #expect(await queue.list().first?.state == .waitingLimit(reset))
        #expect(await queue.nextWake() == reset)
        for _ in 0..<60 {
            if await harness.launched.count == 1 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(await harness.launched.count == 1)
        #expect(await queue.nextWake() == nil)
        await queue.shutdown()
    }

    @Test func waitingPromptSurvivesRelaunchWithAllDelegateOptions() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "alethe-queue-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PromptQueueStore(url: directory.appending(path: PromptQueueStore.fileName))
        let harness = QueueHarness()
        let first = await harness.queue(store: store)
        var item = QueueItem(prompt: "persist me", agent: "claude", cwd: "/tmp", isolate: true,
                             label: "label", priority: 2, release: .afterJob("job-7"), planner: "planner-1",
                             askForApproval: true, webSearch: true, timeoutMs: nil)
        item.state = .waitingLimit(Date().addingTimeInterval(300))
        _ = try await first.add([item])
        await first.shutdown()
        let second = await harness.queue(store: store)
        #expect(await second.list() == [item])
        let restored = try #require(await second.list().first)
        #expect(restored.request.isolate)
        #expect(restored.request.askForApproval)
        #expect(restored.request.webSearch)
        #expect(restored.request.timeoutMs == nil)
        await second.shutdown()
    }

    @Test func usageLimitRequeuesAndRetriesAtResetWhileOtherFailuresRemainFailed() async throws {
        let harness = QueueHarness()
        await harness.slots(1)
        let queue = await harness.queue()
        let item = QueueItem(prompt: "a", cwd: "/tmp")
        _ = try await queue.add([item])
        let reset = Date().addingTimeInterval(600)
        await harness.fitness(.init(worst: "5h", used: 100, resetsAt: reset, rateLimited: true))
        await harness.finish("job-1", status: .failed, text: "Usage limit reached; try again at \(reset.ISO8601Format())")
        await queue.tick()
        let waiting = try #require(await queue.list().first)
        guard case .waitingLimit(let date) = waiting.state else {
            Issue.record("Expected waitingLimit, got \(waiting.state)"); await queue.shutdown(); return
        }
        #expect(date != nil)
        #expect(await harness.launched.count == 1)
        await queue.tick(now: reset.addingTimeInterval(1))
        #expect(await harness.launched.count == 2)
        await harness.finish("job-2", status: .failed, text: "syntax error")
        await queue.tick()
        #expect(await queue.list().first?.state == .failed)
        await queue.shutdown()
    }

    @Test func runNowBypassesReleaseAndFitnessButWaitsForSlots() async throws {
        let harness = QueueHarness()
        let queue = await harness.queue()
        await harness.fitness(.init(worst: "5h", used: 100, rateLimited: true))
        let item = QueueItem(prompt: "a", cwd: "/tmp", release: .afterJob("job-missing"))
        _ = try await queue.add([item])
        await queue.runNow([item.id])
        #expect(await harness.launched.isEmpty)
        await harness.slots(1)
        await queue.tick()
        #expect(await harness.launched.count == 1)
        await queue.cancel([item.id])
        #expect(await harness.cancelled == ["job-1"])
        #expect(await queue.list().first?.state == .cancelled)
        await queue.shutdown()
    }

    @Test func unreadableStoreIsPreservedAndRejectsNewWork() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "alethe-queue-corrupt-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = PromptQueueStore(url: directory.appending(path: PromptQueueStore.fileName))
        let corrupt = Data("broken".utf8)
        try corrupt.write(to: store.url)
        let harness = QueueHarness()
        let queue = await harness.queue(store: store)
        do {
            _ = try await queue.add([QueueItem(prompt: "a", cwd: "/tmp")])
            Issue.record("An unreadable queue must reject additions")
        } catch { }
        await queue.shutdown()
        #expect(try Data(contentsOf: store.url) == corrupt)
    }

    @Test func clockResetParserHandlesAMPMAndMidnightRollover() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 18)))
        let expected = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 17, hour: 17, minute: 47)))
        #expect(QueueLimit.reset(in: "usage limit; try again at 5:47 PM", now: now, calendar: calendar) == expected)
        #expect(QueueLimit.reset(in: "usage limit, unknown reset", now: now, calendar: calendar) == nil)
        #expect(!QueueLimit.detected(in: "a syntax error"))
    }

    @Test func revisedFitnessReschedulesResetAndHealthyReadingReleasesEarly() async throws {
        let harness = QueueHarness()
        let queue = await harness.queue()
        let earlier = Date().addingTimeInterval(300)
        let later = earlier.addingTimeInterval(300)
        await harness.fitness(.init(worst: "5h", used: 100, resetsAt: earlier, rateLimited: true))
        _ = try await queue.add([QueueItem(prompt: "a", cwd: "/tmp")])
        #expect(await queue.nextWake() == earlier)
        await harness.fitness(.init(worst: "week", used: 100, resetsAt: later, rateLimited: true))
        await queue.tick()
        #expect(await queue.nextWake() == later)
        await harness.fitness(.init(worst: "5h", used: 10))
        await harness.slots(1)
        await queue.tick()
        #expect(await harness.launched.count == 1)
        await queue.shutdown()
    }

    @Test func interruptedLaunchIsNotAutomaticallyDuplicatedAfterRelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "alethe-queue-interrupted-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PromptQueueStore(url: directory.appending(path: PromptQueueStore.fileName))
        var item = QueueItem(prompt: "a", cwd: "/tmp")
        item.state = .running("")
        try store.save([item])
        let harness = QueueHarness()
        await harness.slots(1)
        let queue = await harness.queue(store: store)
        await queue.tick()
        #expect(await queue.list().first?.state == .failed)
        #expect(await harness.launched.isEmpty)
        await queue.shutdown()
    }

    @Test func protocolErrorsDetectLimitsWithoutReadingQuotedPromptText() {
        let error: OrderedJSON = ["id": 2, "error": ["message": "Usage limit reached; try again at 5:47 PM"]]
        #expect(QueueLimit.workerMessage(error)?.contains("5:47 PM") == true)
        let failed: OrderedJSON = ["method": "turn/completed", "params": ["turn": [
            "status": "failed", "error": ["message": "rate_limit_exceeded"],
        ]]]
        #expect(QueueLimit.workerMessage(failed) != nil)
        let quoted: OrderedJSON = ["method": "item/agentMessage/delta", "params": ["delta": "Explain usage limits"]]
        #expect(QueueLimit.workerMessage(quoted) == nil)
    }

    @Test func delegateQueueFlagUsesPersistentQueueInsteadOfLaunching() async throws {
        let core = OrchestratorCore()
        await core.setAgentFitness("codex", .init(worst: "5h", used: 95, rateLimited: true))
        let result = try await core.callTool(name: "alethe_delegate", arguments: [
            "tasks": ["first", "second"], "cwd": "/tmp", "queue": true,
            "isolate": true, "askForApproval": true, "webSearch": true, "timeoutSeconds": 0,
        ], planner: "planner-1")
        #expect(result.objectValue?["queueIds"]?.arrayValue?.count == 2)
        #expect(await core.snapshot().jobs.isEmpty)
        let queue = await core.promptQueue()
        let items = await queue.list()
        #expect(items.allSatisfy { $0.isolate && $0.askForApproval && $0.webSearch && $0.timeoutMs == nil && $0.planner == "planner-1" })
        let listed = try await core.callTool(name: "alethe_queue_list", arguments: [:], planner: nil)
        #expect(listed.objectValue?["items"]?.arrayValue?.count == 2)
        await core.shutdown()
    }
}
