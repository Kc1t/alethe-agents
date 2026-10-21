import AletheDesign
import AletheModel
import SwiftUI

/// OrchestrationPage.tsx: the web interface alone exposes the portable worker preferences.
struct OrchestrationSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var pluginsDraft: String?
    @FocusState private var pluginsFocused: Bool
    private var settings: OrchestrationPreferences { environment.preferences?.document.orchestration ?? .init() }

    private func binding<Value>(_ path: WritableKeyPath<OrchestrationPreferences, Value>) -> Binding<Value> {
        Binding { settings[keyPath: path] } set: { value in
            environment.preferences?.update { document in
                var next = document.orchestration ?? .init()
                next[keyPath: path] = value
                document.orchestration = next.normalized
            }
        }
    }

    var body: some View {
        SettingsPageForm("orchestration") {
            Section {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: metrics.size(16)) {
                    choice("orchestrationSkillBackend", selection: binding(\.skill.backend),
                           values: ["auto", "skill", "mcp"], prefix: "orchestrationSkillBackend.")
                    choice("orchestrationSkillStrategy", selection: binding(\.skill.defaultStrategy),
                           values: ["auto", "economy", "balanced", "quality", "research", "parallel", "rescue"], prefix: "orchestrationSkillStrategy.")
                    provider("orchestrationSkillConserve", selection: binding(\.skill.conserveProvider), empty: "orchestrationSkillProviderNone")
                    choice("orchestrationSkillSwitch", selection: binding(\.skill.providerSwitch),
                           values: ["ask", "automatic", "never"], prefix: "orchestrationSkillSwitch.")
                    provider("orchestrationSkillPreferred", selection: binding(\.skill.preferredProvider), empty: "orchestrationSkillProviderAuto")
                }
                hint("orchestrationSkillHint")
            } header: { label("orchestrationSkill") } footer: { label("orchestrationSkillDesc") }
            Section {
                HStack(alignment: .top, spacing: metrics.size(16)) {
                    OrchestrationField("orchestrationConcurrency") {
                        HStack(spacing: metrics.size(8)) {
                            Button { binding(\.maxConcurrent).wrappedValue -= 1 } label: {
                                Image(systemName: "minus").font(metrics.font(size: 15))
                            }.disabled(settings.maxConcurrent <= 1)
                                .accessibilityLabel(label("orchestrationConcurrencyDecrease"))
                            Text(verbatim: String(settings.maxConcurrent)).font(metrics.font(size: 14, weight: .bold))
                                .frame(maxWidth: .infinity)
                            Button { binding(\.maxConcurrent).wrappedValue += 1 } label: {
                                Image(systemName: "plus").font(metrics.font(size: 15))
                            }.disabled(settings.maxConcurrent >= 16)
                                .accessibilityLabel(label("orchestrationConcurrencyIncrease"))
                        }
                    }
                    OrchestrationField("orchestrationDefaultTimeout") {
                        TextField(value: binding(\.defaultTimeoutSeconds), format: .number.grouping(.never)) { label("orchestrationDefaultTimeout") }
                            .modifier(ProjectGroupWebInput())
                        hint("orchestrationTimeoutHint")
                    }
                }
                OrchestrationField("orchestrationWorkerPlugins") {
                    OrchestrationTextArea(text: Binding {
                        pluginsDraft ?? settings.workerDisabledPlugins.joined(separator: "\n")
                    } set: { value in
                        pluginsDraft = value
                        binding(\.workerDisabledPlugins).wrappedValue = value.components(separatedBy: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ",")))
                    }, height: 72, label: "orchestrationWorkerPlugins")
                    .focused($pluginsFocused)
                    .onChange(of: pluginsFocused) { _, focused in if !focused { pluginsDraft = nil } }
                    hint("orchestrationWorkerPluginsHint")
                }
            } header: { label("orchestrationLimits") } footer: { label("orchestrationLimitsDesc") }
            Section {
                if settings.roles.isEmpty { hint("orchestrationRolesEmpty") }
                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: metrics.size(8)) {
                        HStack(spacing: metrics.size(8)) {
                            ForEach(Array(zip(roleLabels.indices, roleLabels)), id: \.0) { index, key in
                                label(key).font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                                    .frame(width: metrics.size(roleWidths[index]), alignment: .leading)
                            }
                        }
                        ForEach(settings.roles.indices, id: \.self) { index in
                            OrchestrationRoleRow(role: settings.roles[index], roles: settings.roles,
                                save: { saveRole(index, $0) }, remove: {
                                    var roles = settings.roles; roles.remove(at: index); binding(\.roles).wrappedValue = roles
                                })
                        }
                    }
                }
                Button { 
                    var number = 1
                    while settings.roles.contains(where: { $0.name == "role-\(number)" }) { number += 1 }
                    binding(\.roles).wrappedValue.append(.init(name: "role-\(number)"))
                } label: { Label { label("orchestrationAddRole") } icon: { Image(systemName: "plus").font(metrics.font(size: 14)) } }
            } header: { label("orchestrationRoles") } footer: { label("orchestrationRolesDesc") }
            OrchestrationRoutingSection(settings: Binding { settings } set: { value in
                environment.preferences?.update { $0.orchestration = value.normalized }
            })
        }
        .accessibilityIdentifier("settings.orchestration")
        .onChange(of: settings) { _, value in
            Task { await environment.orchestrator.applySettings(value) }
        }
    }

    private func saveRole(_ index: Int, _ role: OrchestrationRole) {
        var roles = settings.roles
        guard roles.indices.contains(index), role.isValid,
              !roles.enumerated().contains(where: { $0.offset != index && $0.element.name == role.name && $0.element.orchestrator == role.orchestrator }) else { return }
        let old = roles[index].name
        roles[index] = role
        if old != role.name, !roles.contains(where: { $0.name == old }) {
            for i in roles.indices where roles[i].fallback == old { roles[i].fallback = role.name }
        }
        binding(\.roles).wrappedValue = roles
    }

    private func choice(_ key: String, selection: Binding<String>, values: [String], prefix: String) -> some View {
        OrchestrationField(key) {
            InterfaceSelect(selection: selection, options: values) { label(prefix + $0) }
        }
    }
    private func provider(_ key: String, selection: Binding<String?>, empty: String) -> some View {
        OrchestrationField(key) {
            InterfaceSelect(selection: Binding { selection.wrappedValue ?? "" } set: { selection.wrappedValue = $0.isEmpty ? nil : $0 },
                         options: [""] + OrchestrationSkill.providers) { value in
                if value.isEmpty { label(empty) } else { Text(verbatim: orchestrationAgentName(value)) }
            }
        }
    }
    private func hint(_ key: String) -> some View {
        label(key).font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
    }
}

func orchestrationAgentName(_ value: String) -> String {
    switch value { case "claude": "Claude Code"; case "codex": "Codex"; case "agy": "Agy / Antigravity"; case "kimi": "Kimi Code"; default: value }
}

func label(_ key: String) -> Text { Text(LocalizedStringKey(labelKeys[key] ?? key)) }

private let roleWidths: [CGFloat] = [96, 88, 104, 120, 96, 40, 88, 104, 28]
private let roleLabels = ["orchestrationRoleName", "orchestrationOrchestrator", "orchestrationAgent", "orchestrationModel", "orchestrationEffort", "orchestrationReadOnly", "orchestrationBudget", "orchestrationFallback"]

struct OrchestrationField<Content: View>: View {
    let key: String
    @ViewBuilder var content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    init(_ key: String, @ViewBuilder content: @escaping () -> Content) { self.key = key; self.content = content }
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(6)) {
            label(key).font(metrics.font(size: 12, weight: .medium)).textCase(.uppercase)
                .tracking(metrics.size(0.48)).foregroundStyle(theme[.fgMuted])
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct OrchestrationTextArea: View {
    @Binding var text: String
    let height: CGFloat
    let label: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        TextEditor(text: $text)
            .font(metrics.monoFont(size: 12)).scrollContentBackground(.hidden)
            .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(8))
            .frame(minHeight: metrics.size(height))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .accessibilityLabel(Text(LocalizedStringKey(labelKeys[label] ?? label)))
    }
}

private struct OrchestrationRoleRow: View {
    let role: OrchestrationRole
    let roles: [OrchestrationRole]
    let save: (OrchestrationRole) -> Void
    let remove: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var draft = ""
    private var invalid: Bool {
        !OrchestrationPreferences.isName(draft) || roles.contains { $0 != role && $0.name == draft && $0.orchestrator == role.orchestrator }
    }
    private func binding<Value>(_ path: WritableKeyPath<OrchestrationRole, Value>) -> Binding<Value> {
        Binding { role[keyPath: path] } set: { value in var next = role; next[keyPath: path] = value; save(next) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(4)) {
            HStack(spacing: metrics.size(8)) {
                TextField(text: $draft) { label("orchestrationRoleName") }.modifier(ProjectGroupWebInput())
                    .frame(width: metrics.size(96))
                    .onChange(of: draft) { _, value in if !invalid { binding(\.name).wrappedValue = value } }
                InterfaceSelect(selection: optional(\.orchestrator), options: ["", "claude", "codex"],
                    optionDisabled: { value in roles.contains { $0 != role && $0.name == role.name && ($0.orchestrator ?? "") == value } }) { value in
                    if value.isEmpty { label("orchestrationOrchestratorAny") } else { Text(verbatim: orchestrationAgentName(value)) }
                }.frame(width: metrics.size(88))
                InterfaceSelect(selection: Binding { role.agent } set: { agent in
                    var next = role; next.agent = agent; next.model = nil; next.effort = nil; next.readOnly = false; save(next)
                }, options: ["codex", "claude"]) { Text(verbatim: orchestrationAgentName($0)) }.frame(width: metrics.size(104))
                if metrics.isWebInterface {
                    WebDropdown(selection: optional(\.model), options: [""] + (role.model.map { [$0] } ?? []),
                        searchable: true, searchText: { $0 }, customValue: { $0 },
                        customOptionLabel: { String(localized: "dropdown.orchestration.custom").replacingOccurrences(of: "{value}", with: $0) }) { value in
                        if value.isEmpty { label("orchestrationCliDefault") } else { Text(verbatim: value) }
                    }.frame(width: metrics.size(120)).accessibilityLabel(label("orchestrationModel"))
                } else {
                TextField(text: optional(\.model), prompt: label("orchestrationCliDefault")) { label("orchestrationModel") }
                    .modifier(ProjectGroupWebInput()).frame(width: metrics.size(120))
                }
                InterfaceSelect(selection: optional(\.effort), options: ["", "low", "medium", "high", "xhigh", "max"]) { value in
                    if value.isEmpty { label("orchestrationModelDefault") } else { Text(verbatim: value) }
                }.frame(width: metrics.size(96))
                Toggle(isOn: binding(\.readOnly)) { label("orchestrationReadOnly") }.labelsHidden()
                    .toggleStyle(.switch).disabled(role.agent != "codex").frame(width: metrics.size(40))
                TextField(text: Binding { role.timeoutSeconds.map(String.init) ?? "" } set: { value in
                    if value.isEmpty { binding(\.timeoutSeconds).wrappedValue = nil }
                    else if let seconds = Int(value), (0...OrchestrationPreferences.maximumTimeout).contains(seconds) {
                        binding(\.timeoutSeconds).wrappedValue = seconds
                    }
                }) { label("orchestrationBudget") }.modifier(ProjectGroupWebInput()).frame(width: metrics.size(88))
                InterfaceSelect(selection: optional(\.fallback), options: [""] + fallbackNames) { value in
                    if value.isEmpty { label("orchestrationFallbackNone") } else { Text(verbatim: value) }
                }.frame(width: metrics.size(104))
                Button(action: remove) { Image(systemName: "trash").font(metrics.font(size: 14)) }
                    .accessibilityLabel(label("orchestrationRemoveRole")).frame(width: metrics.size(28))
            }
            if invalid { label("orchestrationRoleNameInvalid").font(metrics.font(size: 11)).foregroundStyle(theme[.statusStopped]) }
        }
        .onAppear { draft = role.name }
        .onChange(of: role.name) { _, value in draft = value }
    }
    private var fallbackNames: [String] {
        var settings = OrchestrationPreferences(); settings.roles = roles
        return Array(Set(roles.map(\.name))).sorted().filter { settings.canFallBack(role, to: $0) }
    }
    private func optional(_ path: WritableKeyPath<OrchestrationRole, String?>) -> Binding<String> {
        Binding { role[keyPath: path] ?? "" } set: { binding(path).wrappedValue = $0.isEmpty ? nil : $0 }
    }
}

private let labelKeys: [String: String] = [
    "orchestrationAddRole": "settings.orchestration.orchestrationAddRole",
    "orchestrationAgent": "settings.orchestration.orchestrationAgent",
    "orchestrationBudget": "settings.orchestration.orchestrationBudget",
    "orchestrationCliDefault": "settings.orchestration.orchestrationCliDefault",
    "orchestrationConcurrency": "settings.orchestration.orchestrationConcurrency",
    "orchestrationConcurrencyDecrease": "settings.orchestration.orchestrationConcurrencyDecrease",
    "orchestrationConcurrencyIncrease": "settings.orchestration.orchestrationConcurrencyIncrease",
    "orchestrationDefaultTimeout": "settings.orchestration.orchestrationDefaultTimeout",
    "orchestrationEffort": "settings.orchestration.orchestrationEffort",
    "orchestrationFallback": "settings.orchestration.orchestrationFallback",
    "orchestrationFallbackNone": "settings.orchestration.orchestrationFallbackNone",
    "orchestrationLimits": "settings.orchestration.orchestrationLimits",
    "orchestrationLimitsDesc": "settings.orchestration.orchestrationLimitsDesc",
    "orchestrationModel": "settings.orchestration.orchestrationModel",
    "orchestrationModelDefault": "settings.orchestration.orchestrationModelDefault",
    "orchestrationOrchestrator": "settings.orchestration.orchestrationOrchestrator",
    "orchestrationOrchestratorAny": "settings.orchestration.orchestrationOrchestratorAny",
    "orchestrationReadOnly": "settings.orchestration.orchestrationReadOnly",
    "orchestrationRemoveRole": "settings.orchestration.orchestrationRemoveRole",
    "orchestrationRoleName": "settings.orchestration.orchestrationRoleName",
    "orchestrationRoleNameInvalid": "settings.orchestration.orchestrationRoleNameInvalid",
    "orchestrationRoles": "settings.orchestration.orchestrationRoles",
    "orchestrationRolesDesc": "settings.orchestration.orchestrationRolesDesc",
    "orchestrationRolesEmpty": "settings.orchestration.orchestrationRolesEmpty",
    "orchestrationRouting": "settings.orchestration.orchestrationRouting",
    "orchestrationRoutingDesc": "settings.orchestration.orchestrationRoutingDesc",
    "orchestrationRoutingIntro": "settings.orchestration.orchestrationRoutingIntro",
    "orchestrationSkill": "settings.orchestration.orchestrationSkill",
    "orchestrationSkillBackend": "settings.orchestration.orchestrationSkillBackend",
    "orchestrationSkillBackend.auto": "settings.orchestration.orchestrationSkillBackend.auto",
    "orchestrationSkillBackend.mcp": "settings.orchestration.orchestrationSkillBackend.mcp",
    "orchestrationSkillBackend.skill": "settings.orchestration.orchestrationSkillBackend.skill",
    "orchestrationSkillConserve": "settings.orchestration.orchestrationSkillConserve",
    "orchestrationSkillDesc": "settings.orchestration.orchestrationSkillDesc",
    "orchestrationSkillHint": "settings.orchestration.orchestrationSkillHint",
    "orchestrationSkillPreferred": "settings.orchestration.orchestrationSkillPreferred",
    "orchestrationSkillProviderAuto": "settings.orchestration.orchestrationSkillProviderAuto",
    "orchestrationSkillProviderNone": "settings.orchestration.orchestrationSkillProviderNone",
    "orchestrationSkillStrategy": "settings.orchestration.orchestrationSkillStrategy",
    "orchestrationSkillStrategy.auto": "settings.orchestration.orchestrationSkillStrategy.auto",
    "orchestrationSkillStrategy.balanced": "settings.orchestration.orchestrationSkillStrategy.balanced",
    "orchestrationSkillStrategy.economy": "settings.orchestration.orchestrationSkillStrategy.economy",
    "orchestrationSkillStrategy.parallel": "settings.orchestration.orchestrationSkillStrategy.parallel",
    "orchestrationSkillStrategy.quality": "settings.orchestration.orchestrationSkillStrategy.quality",
    "orchestrationSkillStrategy.rescue": "settings.orchestration.orchestrationSkillStrategy.rescue",
    "orchestrationSkillStrategy.research": "settings.orchestration.orchestrationSkillStrategy.research",
    "orchestrationSkillSwitch": "settings.orchestration.orchestrationSkillSwitch",
    "orchestrationSkillSwitch.ask": "settings.orchestration.orchestrationSkillSwitch.ask",
    "orchestrationSkillSwitch.automatic": "settings.orchestration.orchestrationSkillSwitch.automatic",
    "orchestrationSkillSwitch.never": "settings.orchestration.orchestrationSkillSwitch.never",
    "orchestrationTimeoutHint": "settings.orchestration.orchestrationTimeoutHint",
    "orchestrationWorkerPlugins": "settings.orchestration.orchestrationWorkerPlugins",
    "orchestrationWorkerPluginsHint": "settings.orchestration.orchestrationWorkerPluginsHint",
    "routingAdvanced": "settings.orchestration.routingAdvanced",
    "routingAllowOpusOnDeep": "settings.orchestration.routingAllowOpusOnDeep",
    "routingCriticalThreshold": "settings.orchestration.routingCriticalThreshold",
    "routingEffortDeep": "settings.orchestration.routingEffortDeep",
    "routingEffortLight": "settings.orchestration.routingEffortLight",
    "routingEffortStandard": "settings.orchestration.routingEffortStandard",
    "routingKindCode": "settings.orchestration.routingKindCode",
    "routingKindCommand": "settings.orchestration.routingKindCommand",
    "routingKindDocs": "settings.orchestration.routingKindDocs",
    "routingKindResearch": "settings.orchestration.routingKindResearch",
    "routingKindReview": "settings.orchestration.routingKindReview",
    "routingKindScrap": "settings.orchestration.routingKindScrap",
    "routingMatchAny": "settings.orchestration.routingMatchAny",
    "routingOnBothCritical": "settings.orchestration.routingOnBothCritical",
    "routingOnBothCriticalAsk": "settings.orchestration.routingOnBothCriticalAsk",
    "routingOnBothCriticalBlock": "settings.orchestration.routingOnBothCriticalBlock",
    "routingOnBothCriticalRunCheapest": "settings.orchestration.routingOnBothCriticalRunCheapest",
    "routingPresetBalanced": "settings.orchestration.routingPresetBalanced",
    "routingPresetBalancedDesc": "settings.orchestration.routingPresetBalancedDesc",
    "routingPresetCustom": "settings.orchestration.routingPresetCustom",
    "routingPresetCustomDesc": "settings.orchestration.routingPresetCustomDesc",
    "routingPresetEconomy": "settings.orchestration.routingPresetEconomy",
    "routingPresetEconomyDesc": "settings.orchestration.routingPresetEconomyDesc",
    "routingPresetPerformance": "settings.orchestration.routingPresetPerformance",
    "routingPresetPerformanceDesc": "settings.orchestration.routingPresetPerformanceDesc",
    "routingRuleAdd": "settings.orchestration.routingRuleAdd",
    "routingRuleEfforts": "settings.orchestration.routingRuleEfforts",
    "routingRuleGateAdd": "settings.orchestration.routingRuleGateAdd",
    "routingRuleGateBelow": "settings.orchestration.routingRuleGateBelow",
    "routingRuleGateRemove": "settings.orchestration.routingRuleGateRemove",
    "routingRuleKinds": "settings.orchestration.routingRuleKinds",
    "routingRuleMoveDown": "settings.orchestration.routingRuleMoveDown",
    "routingRuleMoveUp": "settings.orchestration.routingRuleMoveUp",
    "routingRuleRemove": "settings.orchestration.routingRuleRemove",
    "routingRuleRoleMissing": "settings.orchestration.routingRuleRoleMissing",
    "routingRulesHint": "settings.orchestration.routingRulesHint",
    "routingWindowOpus": "settings.orchestration.routingWindowOpus",
    "routingWindowShort": "settings.orchestration.routingWindowShort",
    "routingWindowWeek": "settings.orchestration.routingWindowWeek",
]
