import AletheDesign
import AletheModel
import SwiftUI

/// MultiagentPage.tsx: editable shortcuts and rules use the web's persisted field names.
struct MultiagentWorkerSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    private var shortcuts: [OrchestratorShortcut] {
        environment.preferences?.document.orchestratorShortcuts ?? Self.defaults
    }
    private var rules: [WorkerRuleSet] {
        environment.preferences?.document.workerRuleSets ?? WorkerRuleSet.defaults
    }
    static var defaults: [OrchestratorShortcut] {
        [("apply", "finishedIsolated"), ("review", "finished"), ("continue", "any")].map { id, rule in
            .init(id: id, name: String(localized: String.LocalizationValue(workerLabelKeys[id + "Name"] ?? id)),
                  text: String(localized: String.LocalizationValue(workerLabelKeys[id + "Text"] ?? id)), rule: rule)
        }
    }
    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                if shortcuts.isEmpty {
                    workerLabel("shortcutsEmpty").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    Button { saveShortcuts(nil) } label: { workerLabel("shortcutsRestoreDefaults") }
                }
                ForEach(shortcuts) { shortcut in
                    shortcutCard(shortcut)
                }
                workerLabel("shortcutPlaceholders").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                Button {
                    saveShortcuts(shortcuts + [.init(name: String(localized: "settings.worker.shortcutNewName"))])
                } label: { workerLabel("shortcutAdd") }
            }
        } header: { workerLabel("orchestratorShortcuts") } footer: { workerLabel("orchestratorShortcutsDesc") }
        Section {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                ForEach(rules) { set in
                    WorkerRuleCard(set: set, all: rules, save: { updateRule($0) }, remove: {
                        saveRules(rules.filter { $0.id != set.id })
                    })
                }
                if rules.isEmpty {
                    workerLabel("ruleSetsEmpty").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                }
                HStack(spacing: metrics.size(6)) {
                    Button {
                        let name = WorkerRuleSet.uniqueName(String(localized: "settings.worker.ruleSetNewName"), in: rules)
                        saveRules(rules + [.init(name: name)])
                    } label: { workerLabel("ruleSetAdd") }
                    Button { saveRules(nil) } label: { workerLabel("ruleSetsRestoreAll") }
                }
            }
        } header: { workerLabel("workerRules") } footer: { workerLabel("workerRulesDesc") }
    }
    private func shortcutCard(_ row: OrchestratorShortcut) -> some View {
        VStack(spacing: metrics.size(8)) {
            HStack(spacing: metrics.size(8)) {
                TextField(text: shortcutBinding(row.id, \.name)) { workerLabel("shortcutName") }
                    .modifier(ProjectGroupWebInput())
                AletheSelect(selection: shortcutBinding(row.id, \.rule), options: ["any", "finished", "finishedIsolated"]) {
                    workerLabel($0 == "any" ? "shortcutRuleAny" : $0 == "finished" ? "shortcutRuleFinished" : "shortcutRuleIsolated")
                }
            }
            WorkerTextArea(text: shortcutBinding(row.id, \.text), height: 64, key: "shortcutText")
            HStack(spacing: metrics.size(6)) {
                Spacer(minLength: 0)
                Button {
                    if let original = Self.defaults.first(where: { $0.id == row.id }) {
                        saveShortcuts(shortcuts.map { $0.id == row.id ? original : $0 })
                    }
                } label: { workerLabel("shortcutRestore") }.disabled(!Self.defaults.contains { $0.id == row.id })
                Button { saveShortcuts(shortcuts.filter { $0.id != row.id }) } label: { workerLabel("shortcutDelete") }
            }
        }.modifier(WorkerCardStyle())
    }
    private func shortcutBinding(_ id: String, _ path: WritableKeyPath<OrchestratorShortcut, String>) -> Binding<String> {
        Binding { shortcuts.first { $0.id == id }?[keyPath: path] ?? "" } set: { value in
            saveShortcuts(shortcuts.map { row in
                var row = row; if row.id == id { row[keyPath: path] = value }; return row
            })
        }
    }
    private func updateRule(_ row: WorkerRuleSet) { saveRules(rules.map { $0.id == row.id ? row : $0 }) }
    private func saveRules(_ value: [WorkerRuleSet]?) {
        environment.preferences?.update { $0.workerRuleSets = value }
        Task { await environment.orchestrator.applyWorkerRules(value) }
    }
    private func saveShortcuts(_ value: [OrchestratorShortcut]?) {
        environment.preferences?.update { $0.orchestratorShortcuts = value }
    }
}

func workerLabel(_ key: String) -> Text { Text(LocalizedStringKey(workerLabelKeys[key] ?? key)) }

private struct WorkerCardStyle: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        content.padding(metrics.size(10))
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(8)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(8)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

private struct WorkerTextArea: View {
    @Binding var text: String
    let height: CGFloat
    let key: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        TextEditor(text: $text).font(metrics.monoFont(size: 12)).lineSpacing(metrics.size(6))
            .scrollContentBackground(.hidden).padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(8))
            .frame(minHeight: metrics.size(height))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .accessibilityLabel(workerLabel(key))
    }
}

private struct WorkerRuleCard: View {
    let set: WorkerRuleSet
    let all: [WorkerRuleSet]
    let save: (WorkerRuleSet) -> Void
    let remove: () -> Void
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var name = ""
    @State private var rejected = false
    @FocusState private var focused: Bool
    private var duplicate: Bool { self.set.isDuplicate(name, in: all) }
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(8)) {
            TextField(text: $name) { workerLabel("ruleSetName") }.modifier(ProjectGroupWebInput())
                .disabled(set.isProtected).focused($focused).onSubmit { focused = false; commitName() }
                .onChange(of: focused) { _, focused in if !focused { commitName() } }
            if duplicate || rejected {
                workerLabel("ruleSetDuplicate").font(metrics.font(size: 11)).foregroundStyle(theme[.statusStopped])
            }
            WorkerTextArea(text: Binding { set.text } set: { text in
                var next = set; next.text = text; save(next)
            }, height: 160, key: "ruleSetText")
            HStack(spacing: metrics.size(6)) {
                Text(verbatim: String(localized: "settings.worker.ruleSetSize")
                    .replacingOccurrences(of: "{count}", with: String(set.text.utf16.count)))
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                Spacer(minLength: 0)
                if let original = WorkerRuleSet.defaults.first(where: { $0.id == set.id }) {
                    Button {
                        var next = original
                        if set.isDuplicate(original.name, in: all) { next.name = set.name; rejected = true }
                        save(next)
                    } label: { workerLabel("shortcutRestore") }
                }
                if !set.isProtected { Button(action: remove) { workerLabel("shortcutDelete") } }
            }
        }.modifier(WorkerCardStyle())
            .onAppear { name = set.name }
            .onChange(of: set.name) { _, value in name = value }
    }
    private func commitName() {
        guard name != set.name else { return }
        if duplicate { name = set.name; rejected = true; return }
        rejected = false
        var next = set; next.name = name; save(next)
    }
}

private let workerLabelKeys: [String: String] = [
    "applyName": "settings.worker.applyName",
    "applyText": "settings.worker.applyText",
    "continueName": "settings.worker.continueName",
    "continueText": "settings.worker.continueText",
    "orchestratorShortcuts": "settings.worker.orchestratorShortcuts",
    "orchestratorShortcutsDesc": "settings.worker.orchestratorShortcutsDesc",
    "reviewName": "settings.worker.reviewName",
    "reviewText": "settings.worker.reviewText",
    "ruleSetAdd": "settings.worker.ruleSetAdd",
    "ruleSetDuplicate": "settings.worker.ruleSetDuplicate",
    "ruleSetName": "settings.worker.ruleSetName",
    "ruleSetNewName": "settings.worker.ruleSetNewName",
    "ruleSetSize": "settings.worker.ruleSetSize",
    "ruleSetText": "settings.worker.ruleSetText",
    "ruleSetsEmpty": "settings.worker.ruleSetsEmpty",
    "ruleSetsRestoreAll": "settings.worker.ruleSetsRestoreAll",
    "shortcutAdd": "settings.worker.shortcutAdd",
    "shortcutDelete": "settings.worker.shortcutDelete",
    "shortcutName": "settings.worker.shortcutName",
    "shortcutNewName": "settings.worker.shortcutNewName",
    "shortcutPlaceholders": "settings.worker.shortcutPlaceholders",
    "shortcutRestore": "settings.worker.shortcutRestore",
    "shortcutRuleAny": "settings.worker.shortcutRuleAny",
    "shortcutRuleFinished": "settings.worker.shortcutRuleFinished",
    "shortcutRuleIsolated": "settings.worker.shortcutRuleIsolated",
    "shortcutText": "settings.worker.shortcutText",
    "shortcutsEmpty": "settings.worker.shortcutsEmpty",
    "shortcutsRestoreDefaults": "settings.worker.shortcutsRestoreDefaults",
    "workerRules": "settings.worker.workerRules",
    "workerRulesDesc": "settings.worker.workerRulesDesc",
]
