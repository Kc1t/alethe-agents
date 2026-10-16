import Foundation
import AletheAgents
import AletheIntegrations

extension OrchestratorCore {
    /// The latest reading for `agent` (`claude`, `codex`), pushed by whoever polls usage so the
    /// planner and the person read the same numbers (upstream `set_agent_fitness`).
    public func setAgentFitness(_ agent: String, _ fitness: AgentFitness) {
        fitnessReadings[agent] = fitness
        if let deferredPrompts { Task { await deferredPrompts.tick() } }
    }

    /// Pushes a P3-13 usage reading; one without windows leaves the previous reading in place, as
    /// upstream keeps the last one when a fetch fails. Returns the fitness pushed.
    @discardableResult
    public func setAgentFitness(from usage: ProviderUsage) -> AgentFitness? {
        guard let reading = AgentFitness(usage) else { return nil }
        setAgentFitness(usage.agent.rawValue, reading)
        return reading
    }

    public func agentFitness() -> [String: AgentFitness] { fitnessReadings }

    /// Every tool answers with the current per-agent headroom, because a tool result is the only
    /// channel this transport can push to the planner (upstream `call_tool`). A delegation into a
    /// strained side also gets `headroomHint`, and each of its jobs a routing note.
    func withFitness(_ result: OrderedJSON, tool name: String, arguments: OrderedJSONObject) -> OrderedJSON {
        let routing = FitnessRouting(fitnessReadings)
        guard let block = routing.block, case .object(var object) = result else { return result }
        if name == "alethe_delegate" {
            let requested = arguments["agent"]?.stringValue ?? WorkerAgent.codex
            if let note = routing.routingNote(requested: requested) {
                let ids = object["jobs"]?.arrayValue?.compactMap { $0.objectValue?["id"]?.stringValue } ?? []
                for id in ids { jobs[id]?.routing = note }
                if !ids.isEmpty { notify() }
            }
            if let hint = routing.headroomHint(requested: requested) {
                object["headroomHint"] = hint
            }
        }
        object["fitness"] = block
        return .object(object)
    }
}
