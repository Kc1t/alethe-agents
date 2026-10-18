import Foundation

extension OrchestrationPreferences {
    /// routingPresets.ts: replace preset-owned names, preserve all other user roles.
    public mutating func applyPreset(_ preset: String) {
        guard ["economy", "balanced", "performance"].contains(preset) else { return }
        let scout = OrchestrationRole(name: "scout", agent: "claude", model: "haiku", effort: "low", fallback: "handyman")
        let handyman = OrchestrationRole(name: "handyman", effort: "low", readOnly: true)
        let codexBuilder = OrchestrationRole(name: "codex-builder", effort: "medium")
        let builder = OrchestrationRole(name: "builder", agent: "claude", model: "sonnet", effort: "medium", fallback: "codex-builder")
        let expert = OrchestrationRole(name: "expert", agent: "claude", model: "opus", effort: "high", fallback: "builder")
        let owned: [OrchestrationRole]
        switch preset {
        case "economy": owned = [scout, handyman, .init(name: "builder", effort: "medium", fallback: "scout")]
        case "performance": owned = [builder, codexBuilder, expert]
        default: owned = [scout, handyman, builder, codexBuilder, expert]
        }
        roles = owned + roles.filter { current in !owned.contains { $0.name == current.name } }
        func rule(_ role: String, kinds: [String] = [], efforts: [String] = [], gate: Int? = nil) -> OrchestrationRoutingRule {
            var rule = OrchestrationRoutingRule(role: role)
            rule.kinds = kinds; rule.efforts = efforts
            if let gate { var quota = OrchestrationQuotaGate(); quota.window = "opus"; quota.below = gate; rule.gates = [quota] }
            return rule
        }
        switch preset {
        case "economy": routing.rules = [rule("scout", kinds: ["research", "scrap", "docs"]), rule("scout", efforts: ["light"]), rule("handyman", kinds: ["review"]), rule("builder", efforts: ["standard", "deep"])]
        case "performance": routing.rules = [rule("builder", efforts: ["light"]), rule("expert", efforts: ["deep"], gate: 80), rule("builder")]
        default: routing.rules = [rule("scout", kinds: ["research", "scrap", "docs"]), rule("scout", efforts: ["light"]), rule("handyman", kinds: ["review"]), rule("expert", efforts: ["deep"], gate: 50), rule("builder")]
        }
        routing.preset = preset
        self = normalized
    }
}
