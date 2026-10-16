import Foundation
import AletheIntegrations

extension OrchestratorCore {
    public func promptQueue() -> PromptQueue {
        if let deferredPrompts { return deferredPrompts }
        let store = configuration.store.map {
            PromptQueueStore(url: $0.url.deletingLastPathComponent().appending(path: PromptQueueStore.fileName))
        }
        let prompts = PromptQueue(store: store, read: { [weak self] in
            await self?.promptQueueContext() ?? .init(availableSlots: 0)
        }, delegate: { [weak self] item in
            guard let self else { throw OrchestratorToolError("the orchestrator is unavailable") }
            let result = try await self.delegate(item.request, planner: item.planner)
            guard let id = result.objectValue?["jobs"]?.arrayValue?.first?.objectValue?["id"]?.stringValue else {
                throw OrchestratorToolError("delegate returned no job")
            }
            return id
        }, cancel: { [weak self] id in _ = await self?.cancel([id]) })
        deferredPrompts = prompts
        return prompts
    }

    private func promptQueueContext() -> PromptQueue.Context {
        .init(fitness: fitnessReadings, jobs: order.compactMap { jobs[$0] },
              availableSlots: isShutDown ? 0 : max(0, concurrencyLimit - slots.count - queue.count))
    }

    func enqueueDelegate(_ request: DelegateRequest, planner: String?) async throws(OrchestratorToolError) -> OrderedJSON {
        let fitness = fitnessReadings[request.agent]
        let additions = request.tasks.map { prompt in
            var item = QueueItem(prompt: prompt, agent: request.agent, cwd: request.cwd,
                                 isolate: request.isolate, label: request.label, planner: planner,
                                 askForApproval: request.askForApproval, webSearch: request.webSearch,
                                 timeoutMs: request.timeoutMs)
            item.state = .waitingLimit(fitness?.resetsAt)
            return item
        }
        do {
            let added = try await promptQueue().add(additions)
            return ["queueIds": .array(added.map { .string($0.id) }),
                    "items": .array(added.map(\.json)),
                    "resetsAt": .optional(fitness?.resetsAt?.ISO8601Format())]
        } catch { throw OrchestratorToolError(String(describing: error)) }
    }

    func queueTool(name: String, arguments: OrderedJSONObject, planner: String?) async throws(OrchestratorToolError) -> OrderedJSON {
        guard !isShutDown else { throw OrchestratorToolError("the orchestrator is shutting down") }
        let prompts = promptQueue()
        let ids = arguments["ids"]?.arrayValue?.compactMap(\.stringValue) ?? []
        switch name {
        case "alethe_queue_add":
            guard let prompt = arguments["prompt"]?.stringValue, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw OrchestratorToolError("prompt must not be empty")
            }
            guard arguments["at"] == nil || arguments["afterJob"] == nil else {
                throw OrchestratorToolError("at and afterJob are mutually exclusive")
            }
            var release = QueueItem.Release.whenAgentHasRoom
            if let at = arguments["at"] {
                guard let value = at.stringValue, let date = Self.queueDate(value) else { throw OrchestratorToolError("at must be an ISO 8601 date") }
                release = .at(date)
            }
            if let afterJob = arguments["afterJob"] {
                guard let id = afterJob.stringValue, jobs[id] != nil else { throw OrchestratorToolError("afterJob must name an existing job") }
                release = .afterJob(id)
            }
            let item = QueueItem(prompt: prompt, agent: arguments["agent"]?.stringValue ?? WorkerAgent.codex,
                                 cwd: arguments["cwd"]?.stringValue ?? FileManager.default.currentDirectoryPath,
                                 isolate: arguments["isolate"]?.boolValue ?? false, label: arguments["label"]?.stringValue,
                                 priority: arguments["priority"]?.intValue ?? 0, release: release, planner: planner)
            do { return ["items": .array(try await prompts.add([item]).map(\.json))] }
            catch { throw OrchestratorToolError(String(describing: error)) }
        case "alethe_queue_cancel": await prompts.cancel(ids)
        case "alethe_queue_run_now": await prompts.runNow(ids)
        case "alethe_queue_reorder": await prompts.reorder(ids)
        default: break
        }
        var result: OrderedJSONObject = ["items": .array(await prompts.list().map(\.json))]
        if await prompts.persistenceError != nil { result["persistenceError"] = "could not read or write the prompt queue" }
        return .object(result)
    }

    private static func queueDate(_ value: String) -> Date? {
        if let date = try? Date(value, strategy: .iso8601) { return date }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: value)
    }
}
