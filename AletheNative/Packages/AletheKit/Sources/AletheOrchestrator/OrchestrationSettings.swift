import AletheModel
import AletheIntegrations
import Foundation

extension OrchestratorCore {
    public func applyWorkerRules(_ sets: [WorkerRuleSet]?) { workerRuleSets = sets ?? WorkerRuleSet.defaults }

    public func workerRulesBlock(named name: String?) throws(OrchestratorToolError) -> String {
        var chosen = workerRuleSets.filter { $0.isProtected }
        if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let set = workerRuleSets.first(where: { WorkerRuleSet.fold($0.name) == WorkerRuleSet.fold(name) }) else {
                throw OrchestratorToolError("unknown rule set \(name). Available: " + workerRuleSets.map(\.name).joined(separator: ", "))
            }
            if !set.isProtected { chosen.append(set) }
        }
        guard !chosen.isEmpty else { return "" }
        let body = chosen.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "\n\n")
        return "<alethe-rules>\nThese are Alethe's working rules for this task. If this repository states something different (CLAUDE.md, AGENTS.md, CONTRIBUTING.md), the repository wins.\n\n" + body + "\n</alethe-rules>\n\n"
    }

    /// Preferences are applied before accepting a delegate call; existing workers keep their budget.
    public func applySettings(_ settings: OrchestrationPreferences) {
        orchestrationSettings = settings.normalized
        setConcurrencyLimit(orchestrationSettings.maxConcurrent)
    }

    func configuredArguments(_ arguments: OrderedJSONObject, planner: String?) throws(OrchestratorToolError) -> OrderedJSONObject {
        var result = arguments
        let settings = orchestrationSettings
        let plannerAgent = planners.first { $0.id == planner }?.agent
        var selected: OrchestrationRole?
        func find(_ name: String) -> OrchestrationRole? {
            settings.roles.first { $0.name == name && $0.orchestrator == plannerAgent }
                ?? settings.roles.first { $0.name == name && $0.orchestrator == nil }
        }
        let kind = arguments["kind"]?.stringValue
        let effortClass = arguments["effortClass"]?.stringValue ?? arguments["effort_class"]?.stringValue
        if let kind, !OrchestrationRoutingRule.kinds.contains(kind) { throw OrchestratorToolError("unknown task kind \(kind)") }
        if let effortClass, !OrchestrationRoutingRule.efforts.contains(effortClass) { throw OrchestratorToolError("unknown effort class \(effortClass)") }
        if arguments["role"]?.stringValue == nil, arguments["model"]?.stringValue == nil, let kind {
            for rule in settings.routing.rules where rule.enabled {
                guard rule.kinds.isEmpty || rule.kinds.contains(kind),
                      rule.efforts.isEmpty || effortClass.map(rule.efforts.contains) == true,
                      rule.gates.allSatisfy({ gate in
                          guard let reading = fitnessReadings[gate.agent] else { return true }
                          let window = gate.window == "short" ? "5h" : gate.window == "opus" && gate.agent == "codex" ? "week" : gate.window
                          let used = reading.windows[window] ?? (reading.worst == window ? reading.used : nil)
                          return used.map { $0 < gate.below } ?? true
                      }), let role = find(rule.role) else { continue }
                if !settings.routing.allowOpusOnDeep, role.model?.lowercased().contains("opus") == true { continue }
                selected = role
                break
            }
        }
        if let name = arguments["role"]?.stringValue {
            for field in ["agent", "model", "effort", "readOnly", "timeoutSeconds"] where arguments[field] != nil {
                throw OrchestratorToolError("role \(name) already sets \(field); pass the role or \(field), not both")
            }
            guard let role = find(name) else { throw OrchestratorToolError("unknown orchestration role \(name)") }
            selected = role
        }
        if var role = selected {
            var visited = Set<String>()
            while let reading = fitnessReadings[role.agent],
                  reading.rateLimited || reading.used >= settings.routing.criticalThreshold,
                  let fallback = role.fallback, visited.insert(role.name).inserted,
                  let next = find(fallback), !role.readOnly || next.readOnly {
                role = next
            }
            result["agent"] = .string(role.agent)
            result["model"] = role.model.map(OrderedJSON.string) ?? .null
            result["effort"] = role.effort.map(OrderedJSON.string) ?? .null
            result["readOnly"] = .bool(role.readOnly)
            if let timeout = role.timeoutSeconds { result["timeoutSeconds"] = .integer(timeout) }
        }
        for key in ["model", "effort"] {
            if let value = result[key]?.stringValue, !OrchestrationPreferences.isName(value) {
                throw OrchestratorToolError("invalid \(key)")
            }
        }
        if result["readOnly"]?.boolValue == true, result["agent"]?.stringValue == "claude" {
            throw OrchestratorToolError("Claude workers do not support read-only mode")
        }
        if settings.routing.onBothCritical == "block",
           ["claude", "codex"].allSatisfy({ agent in
               fitnessReadings[agent].map { $0.rateLimited || $0.used >= settings.routing.criticalThreshold } ?? false
           }) { throw OrchestratorToolError("both providers are past the configured quota threshold; routing settings say to block") }
        if result["timeoutSeconds"] == nil { result["timeoutSeconds"] = .integer(settings.defaultTimeoutSeconds) }
        _ = try workerRulesBlock(named: arguments["rules"]?.stringValue)
        if let name = arguments["rules"]?.stringValue,
           let canonical = workerRuleSets.first(where: { WorkerRuleSet.fold($0.name) == WorkerRuleSet.fold(name) }) {
            result["rules"] = .string(canonical.name)
        }
        return result
    }
}
