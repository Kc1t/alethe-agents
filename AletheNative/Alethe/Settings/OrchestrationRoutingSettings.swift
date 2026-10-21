import AletheDesign
import AletheModel
import SwiftUI

struct OrchestrationRoutingSection: View {
    @Binding var settings: OrchestrationPreferences
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var advanced = false
    private var roleNames: [String] { Array(Set(settings.roles.map(\.name))).sorted() }
    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                label("orchestrationRoutingIntro").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(160)), spacing: metrics.size(8))], spacing: metrics.size(8)) {
                    ForEach(["economy", "balanced", "performance", "custom"], id: \.self) { preset in
                        Button { settings.applyPreset(preset) } label: {
                            HStack(alignment: .top, spacing: metrics.size(8)) {
                                Image(systemName: settings.routing.preset == preset ? "largecircle.fill.circle" : "circle")
                                    .font(metrics.font(size: 14))
                                VStack(alignment: .leading, spacing: metrics.size(4)) {
                                    label("routingPreset" + preset.capitalized).font(metrics.font(size: 12, weight: .semibold))
                                    label("routingPreset" + preset.capitalized + "Desc").font(metrics.font(size: 10))
                                        .foregroundStyle(theme[.fgMuted])
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(metrics.size(10))
                                .background(theme[settings.routing.preset == preset ? .accentFaint : .panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[settings.routing.preset == preset ? .accent : .border], lineWidth: metrics.size(1)))
                        }.buttonStyle(.plain).disabled(preset == "custom")
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(180)), spacing: metrics.size(16))], alignment: .leading, spacing: metrics.size(16)) {
                    OrchestrationField("routingCriticalThreshold") {
                        TextField(value: $settings.routing.criticalThreshold, format: .number.grouping(.never)) { label("routingCriticalThreshold") }
                            .modifier(ProjectGroupWebInput())
                    }
                    Toggle(isOn: $settings.routing.allowOpusOnDeep) { label("routingAllowOpusOnDeep") }
                    OrchestrationField("routingOnBothCritical") {
                        InterfaceSelect(selection: $settings.routing.onBothCritical, options: ["ask", "run-cheapest", "block"]) { value in
                            label(value == "ask" ? "routingOnBothCriticalAsk" : value == "block" ? "routingOnBothCriticalBlock" : "routingOnBothCriticalRunCheapest")
                        }
                    }
                }
                DisclosureGroup(isExpanded: $advanced) {
                    VStack(alignment: .leading, spacing: metrics.size(10)) {
                        label("routingRulesHint").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                        ForEach(settings.routing.rules.indices, id: \.self) { index in
                            rule(index)
                        }
                        Button {
                            settings.routing.rules.append(.init(role: roleNames.first ?? "role-1")); settings.routing.preset = "custom"
                        } label: { label("routingRuleAdd") }.disabled(roleNames.isEmpty)
                    }.padding(.top, metrics.size(8))
                } label: {
                    Text(verbatim: String(localized: "settings.orchestration.routingAdvanced").replacingOccurrences(of: "{count}", with: String(settings.routing.rules.count)))
                }
            }
        } header: { label("orchestrationRouting") } footer: { label("orchestrationRoutingDesc") }
    }

    private func binding<Value>(_ index: Int, _ path: WritableKeyPath<OrchestrationRoutingRule, Value>) -> Binding<Value> {
        Binding { settings.routing.rules[index][keyPath: path] } set: { value in
            settings.routing.rules[index][keyPath: path] = value; settings.routing.preset = "custom"
        }
    }
    private func rule(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(10)) {
            HStack(spacing: metrics.size(8)) {
                Toggle(isOn: binding(index, \.enabled)) { Text(verbatim: String(index + 1)) }.toggleStyle(.checkbox)
                InterfaceSelect(selection: binding(index, \.role), options: Array(Set(roleNames + [settings.routing.rules[index].role])).sorted()) { Text(verbatim: $0) }
                Spacer(minLength: 0)
                action("arrow.up", key: "routingRuleMoveUp", disabled: index == 0) { move(index, by: -1) }
                action("arrow.down", key: "routingRuleMoveDown", disabled: index + 1 == settings.routing.rules.count) { move(index, by: 1) }
                action("trash", key: "routingRuleRemove") { settings.routing.rules.remove(at: index); settings.routing.preset = "custom" }
            }
            if !roleNames.contains(settings.routing.rules[index].role) {
                Text(verbatim: String(localized: "settings.orchestration.routingRuleRoleMissing").replacingOccurrences(of: "{name}", with: settings.routing.rules[index].role))
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.statusWaiting])
            }
            chips(index, path: \.kinds, values: OrchestrationRoutingRule.kinds, prefix: "routingKind", title: "routingRuleKinds")
            chips(index, path: \.efforts, values: OrchestrationRoutingRule.efforts, prefix: "routingEffort", title: "routingRuleEfforts")
            label("routingMatchAny").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            ForEach(settings.routing.rules[index].gates.indices, id: \.self) { gateIndex in
                HStack(spacing: metrics.size(8)) {
                    InterfaceSelect(selection: gate(index, gateIndex, \.agent), options: ["claude", "codex"]) { Text(verbatim: orchestrationAgentName($0)) }
                    InterfaceSelect(selection: gate(index, gateIndex, \.window), options: ["short", "week", "opus"]) { label("routingWindow" + $0.capitalized) }
                    TextField(value: gate(index, gateIndex, \.below), format: .number.grouping(.never)) { label("routingRuleGateBelow") }
                        .modifier(ProjectGroupWebInput()).frame(width: metrics.size(80))
                    action("trash", key: "routingRuleGateRemove") {
                        settings.routing.rules[index].gates.remove(at: gateIndex); settings.routing.preset = "custom"
                    }
                }
            }
            Button {
                settings.routing.rules[index].gates.append(.init()); settings.routing.preset = "custom"
            } label: { label("routingRuleGateAdd") }
        }.padding(metrics.size(12))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
    private func gate<Value>(_ index: Int, _ gate: Int, _ path: WritableKeyPath<OrchestrationQuotaGate, Value>) -> Binding<Value> {
        Binding { settings.routing.rules[index].gates[gate][keyPath: path] } set: { value in
            settings.routing.rules[index].gates[gate][keyPath: path] = value; settings.routing.preset = "custom"
        }
    }
    private func chips(_ index: Int, path: WritableKeyPath<OrchestrationRoutingRule, [String]>, values: [String], prefix: String, title: String) -> some View {
        OrchestrationField(title) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(80)), spacing: metrics.size(6))], spacing: metrics.size(6)) {
                ForEach(values, id: \.self) { value in
                    let selected = settings.routing.rules[index][keyPath: path].contains(value)
                    Button {
                        var list = binding(index, path).wrappedValue
                        if selected { list.removeAll { $0 == value } } else { list.append(value) }
                        binding(index, path).wrappedValue = list
                    } label: {
                        label(prefix + value.capitalized).font(metrics.font(size: 11.5))
                            .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(4))
                            .background(theme[selected ? .accentFaint : .panel], in: Capsule())
                            .overlay(Capsule().strokeBorder(theme[selected ? .accent : .border], lineWidth: metrics.size(1)))
                    }.buttonStyle(.plain)
                }
            }
        }
    }
    private func action(_ symbol: String, key: String, disabled: Bool = false, perform: @escaping () -> Void) -> some View {
        Button(action: perform) { Image(systemName: symbol).font(metrics.font(size: 14)) }
            .accessibilityLabel(label(key)).disabled(disabled)
    }
    private func move(_ index: Int, by delta: Int) {
        settings.routing.rules.swapAt(index, index + delta); settings.routing.preset = "custom"
    }
}
