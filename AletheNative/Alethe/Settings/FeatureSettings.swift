import AletheDesign
import AletheIntegrations
import AletheModel
import SwiftUI

/// Settings › Features (upstream `FeaturesPage`): each optional module with its toggle, the secondary
/// ones under “Show more”. A feature's own options appear under it while it is on (`FeatureOptions`).
struct FeatureSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @State private var showsMore = false

    private var secondaryCount: Int { Feature.allCases.filter(\.isSecondary).count }

    var body: some View {
        SettingsPageForm {
            Section {
                ForEach(Feature.allCases.filter { !$0.isSecondary }, id: \.self) { FeatureRow(feature: $0) }
                if metrics.isWebInterface {
                    Toggle(isOn: Binding {
                        environment.preferences?.document.enabledFeatures?["agentsPanel"] ?? true
                    } set: { on in
                        environment.preferences?.update {
                            var flags = $0.enabledFeatures ?? [:]
                            flags["agentsPanel"] = on
                            $0.enabledFeatures = flags
                        }
                    }) {
                        Text("settings.orchestration.agentsPanel")
                        Text("settings.orchestration.agentsPanelDetail")
                    }.accessibilityIdentifier("settings.feature.agentsPanel")
                }
            } footer: {
                Text("settings.features.help")
            }
            Section {
                if showsMore {
                    ForEach(Feature.allCases.filter(\.isSecondary), id: \.self) { FeatureRow(feature: $0) }
                }
                Button {
                    showsMore.toggle()
                } label: {
                    Text(verbatim: showsMore ? String(localized: "settings.features.showFewer")
                         : format("settings.features.showMore", secondaryCount))
                }
                .buttonStyle(.link)
                .accessibilityIdentifier("settings.features.showMore")
            }
            if environment.features.isOn(.mcp) {
                Section {
                    // Upstream `FeaturesPage`: a link under the list that reopens the MCP intro.
                    Button {
                        environment.editorRequest = .mcpIntro
                    } label: {
                        Text("settings.features.mcpRunSetup")
                    }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("settings.features.mcpRunSetup")
                }
            }
        }
        .formStyle(.grouped)
        .modifier(AletheSettingsSizing())
        .disabled(environment.preferences == nil)
        .accessibilityIdentifier("settings.features")
        .onAppear { if metrics.isWebInterface { showsMore = true } }
    }
}

struct FeatureRow: View {
    let feature: Feature
    /// The onboarding lists the toggles only; options stay in Settings.
    var showsOptions = true
    @Environment(AppEnvironment.self) private var environment

    private var isOn: Binding<Bool> {
        Binding {
            environment.features.isOn(feature)
        } set: { on in
            environment.preferences?.update { $0.features.set(feature, on: on) }
            if feature == .playwright, !on { Task { await environment.playwright.stop() } }
        }
    }

    var body: some View {
        Toggle(isOn: isOn) {
            Text(feature.title)
            Text(feature.detail)
        }
        .accessibilityIdentifier("settings.feature.\(feature.rawValue)")
        if showsOptions, isOn.wrappedValue {
            FeatureOptions(feature: feature)
        }
    }
}

/// The options slot under a feature that is on. Each task that gives a feature options adds its case
/// here (Graphify command P5-17, ai-memory status P5-18, Playwright browser P5-19, GSD Sync model
/// chain P5-24).
private struct FeatureOptions: View {
    let feature: Feature

    var body: some View {
        switch feature {
        case .aiMemory:
            AiMemoryOptions()
        case .graphify:
            GraphifyOptions()
        case .playwright:
            PlaywrightOptions()
        case .gsdSync:
            GSDSyncOptions()
        case .browser, .mcp, .orchestrator, .prs:
            EmptyView()
        }
    }
}

/// Settings › Features › Graphify: the CLI command and whether it answers.
private struct GraphifyOptions: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var command = ""

    private var graphify: GraphifyController { environment.graphify }

    var body: some View {
        TextField(text: $command, prompt: Text(verbatim: GraphifyService.defaultCommand)) {
            Text("features.graphify.command")
            Text("features.graphify.command.detail")
        }
        .onSubmit(save)
        .accessibilityIdentifier("settings.graphify.command")
        LabeledContent {
            HStack {
                if graphify.isDetecting { ProgressView().controlSize(.small) }
                Button("features.graphify.checkAgain") { save() }
                    .disabled(graphify.isDetecting)
                    .accessibilityIdentifier("settings.graphify.check")
            }
        } label: {
            Text("features.graphify.status")
            statusText
                .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                .foregroundStyle(theme[.textSecondary])
                .textSelection(.enabled)
                .accessibilityIdentifier("settings.graphify.status")
        }
        .task {
            command = environment.preferences?.document.graphifyCommand ?? ""
            await graphify.detect()
        }
        .onDisappear(perform: store)
    }

    private var statusText: Text {
        guard let status = graphify.status else { return Text("features.graphify.checking") }
        guard status.available, let executable = status.executable else { return Text("features.graphify.notFound") }
        return Text(verbatim: format("features.graphify.found", status.version ?? executable, executable))
    }

    /// Saves the command (empty is the default) and checks it.
    private func save() {
        store()
        Task { await graphify.detect() }
    }

    private func store() {
        let trimmed = command.trimmingCharacters(in: .whitespaces)
        let value = trimmed.isEmpty ? nil : trimmed
        guard environment.preferences?.document.graphifyCommand != value else { return }
        environment.preferences?.update { $0.graphifyCommand = value }
    }
}

/// Settings › Features › GSD Sync (upstream `prefs.gsdSyncModels*`): the fallback models the child
/// session tries in order after the mirrored one; saved on submit, remove and close.
private struct GSDSyncOptions: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var models: [ModelEntry] = []
    @State private var loaded = false

    private struct ModelEntry: Identifiable {
        let id = UUID()
        var name: String
    }

    var body: some View {
        LabeledContent {
            Button {
                models.append(ModelEntry(name: ""))
            } label: {
                Label { Text("features.gsdSync.addModel") } icon: { Image(systemName: "plus").webProfileSized(14) }
            }
            .accessibilityIdentifier("settings.gsdSync.add")
        } label: {
            Text("features.gsdSync.models")
            Text("features.gsdSync.models.detail")
        }
        if models.isEmpty {
            Text("features.gsdSync.models.empty")
                .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                .foregroundStyle(theme[.textSecondary])
                .accessibilityIdentifier("settings.gsdSync.empty")
        }
        ForEach($models) { $model in
            let index = models.firstIndex { $0.id == model.id } ?? 0
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: "\(index + 1).")
                    .font(metrics.font(.body).monospacedDigit())
                    .foregroundStyle(theme[.textTertiary])
                TextField(text: $model.name, prompt: Text(verbatim: "provider/model")) {
                    Text(verbatim: format("features.gsdSync.model", index + 1))
                }
                .labelsHidden()
                .onSubmit(store)
                .accessibilityIdentifier("settings.gsdSync.model.\(index)")
                Button {
                    models.removeAll { $0.id == model.id }
                    store()
                } label: {
                    Image(systemName: "minus.circle").webProfileSized(14)
                }
                .buttonStyle(.borderless)
                .help(Text("features.gsdSync.removeModel"))
                .accessibilityLabel(Text("features.gsdSync.removeModel"))
                .accessibilityIdentifier("settings.gsdSync.remove.\(index)")
            }
        }
        Text("features.gsdSync.models.hint")
            .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
            .foregroundStyle(theme[.textSecondary])
            .onAppear(perform: load)
            .onDisappear(perform: store)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        models = (environment.preferences?.document.gsdSyncModelChain ?? []).map { ModelEntry(name: $0) }
    }

    /// Blank rows are dropped; an empty chain is stored as none.
    private func store() {
        let chain = models.map { $0.name.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let value = chain.isEmpty ? nil : chain
        guard environment.preferences?.document.gsdSyncModelChain != value else { return }
        environment.preferences?.update { $0.gsdSyncModelChain = value }
    }
}

extension Feature {
    var title: LocalizedStringKey {
        switch self {
        case .browser: "features.browser.title"
        case .graphify: "features.graphify.title"
        case .mcp: "features.mcp.title"
        case .playwright: "features.playwright.title"
        case .orchestrator: "features.orchestrator.title"
        case .gsdSync: "features.gsdSync.title"
        case .aiMemory: "features.aiMemory.title"
        case .prs: "features.prs.title"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .browser: "features.browser.detail"
        case .graphify: "features.graphify.detail"
        case .mcp: "features.mcp.detail"
        case .playwright: "features.playwright.detail"
        case .orchestrator: "features.orchestrator.detail"
        case .gsdSync: "features.gsdSync.detail"
        case .aiMemory: "features.aiMemory.detail"
        case .prs: "features.prs.detail"
        }
    }
}
