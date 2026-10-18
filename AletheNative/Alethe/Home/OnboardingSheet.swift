import AletheAgents
import AletheDesign
import AletheFoundation
import AletheIntegrations
import AletheModel
import AppKit
import SwiftUI

/// The first-run sheet (upstream `OnboardingModal`, SET-7): name, the optional Tauri import, style
/// and theme, agents, features and MCP servers. Keyboard-first — Return goes on, ⌘[ goes back, Esc
/// skips — and every choice applies at once, so skipping keeps what was already chosen. Finishing
/// hands over to the setup steps on Home (P3-16).
struct OnboardingSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @State private var step = OnboardingStep.name
    @State private var name = ""
    @State private var nameError: String?
    @State private var saving = false
    @State private var tauriAvailable = false
    @State private var photo = ""
    @State private var bodyHeight: CGFloat = 0
    @FocusState private var nameFocused: Bool

    private var steps: [OnboardingStep] {
        OnboardingStep.steps(tauriDataAvailable: tauriAvailable, mcpEnabled: environment.features.isOn(.mcp))
    }

    private var index: Int { steps.firstIndex(of: step) ?? 0 }
    private var isLast: Bool { index == steps.count - 1 }
    private var canContinue: Bool {
        !saving && (step != .name || !name.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(metrics.space(.xxl))
                .id(step)
            Divider()
            footer
        }
        .frame(width: closeOverlay == nil ? metrics.size(620) : nil,
               height: closeOverlay == nil ? metrics.size(580) : min(metrics.size(580), maximumHeight))
        .background(theme[.bg])
        .interactiveDismissDisabled()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding")
        .task {
            name = suggestedName
            photo = environment.preferences?.document.profileImageUrl ?? ""
            nameFocused = true
            tauriAvailable = await Task.detached { !TauriImportSheet.availableProfiles().isEmpty }.value
        }
    }

    // MARK: - Web chrome (OnboardingModal.module.css)

    private var webBody: some View {
        let shape = RoundedRectangle(cornerRadius: metrics.radius(.lg))
        return VStack(spacing: 0) {
            OnboardingWebHeader(count: steps.count, current: index,
                                progressLabel: format("onboarding.progress", index + 1, steps.count))
            ScrollView {
                webStep
                    .padding(metrics.size(26))
                    .frame(maxWidth: .infinity, alignment: .top)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bodyHeight = $0 }
                    .id(step)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: metrics.size(4))),
                                            removal: .identity))
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(max(metrics.size(322), bodyHeight), max(metrics.size(120), maximumHeight - metrics.size(104))))
            .clipped()
            .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.18), value: step)
            webFooter
        }
        .font(metrics.font(size: 13))
        .foregroundStyle(theme[.fg])
        .tint(theme[.accent])
        .background(theme[.surfaceModal], in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding")
        .task {
            name = suggestedName
            photo = environment.preferences?.document.profileImageUrl ?? ""
            nameFocused = true
            tauriAvailable = await Task.detached { !TauriImportSheet.availableProfiles().isEmpty }.value
        }
    }

    @ViewBuilder
    private var webStep: some View {
        switch step {
        case .name:
            OnboardingWebProfileStep(name: $name, photo: $photo, nameError: nameError, focus: $nameFocused)
        case .importData: OnboardingImportStep(workspace: workspace, undoManager: undoManager)
        case .appearance: appearanceStep
        case .agents: OnboardingWebAgentsStep()
        case .features: OnboardingWebFeaturesStep()
        case .mcp: OnboardingMcpStep(store: environment.mcpStore)
        }
    }

    private var webFooter: some View {
        HStack(spacing: metrics.size(10)) {
            Text(verbatim: webFootnote)
                .font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgFaint])
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("onboarding.skip") { skip() }
                .buttonStyle(OnboardingWebButtonStyle(kind: .ghost))
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("onboarding.skip")
            if index > 0 {
                Button("onboarding.web.back") { move(-1) }
                    .buttonStyle(OnboardingWebButtonStyle(kind: .ghost))
                    .keyboardShortcut("[", modifiers: .command)
                    .accessibilityIdentifier("onboarding.back")
            }
            Button {
                next()
            } label: {
                HStack(spacing: metrics.size(7)) {
                    Text(isLast ? LocalizedStringKey("onboarding.web.goToApp") : "onboarding.web.next")
                    Text(verbatim: "\u{23CE}")
                        .font(metrics.monoFont(size: 10.5, weight: .regular))
                        .foregroundStyle(Color.black.opacity(0.45))
                        .padding(.horizontal, metrics.size(5)).padding(.vertical, metrics.size(1))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                            .strokeBorder(Color.black.opacity(0.22), lineWidth: metrics.size(1)))
                }
            }
            .buttonStyle(OnboardingWebButtonStyle(kind: .primary))
            .keyboardShortcut(.defaultAction)
            .disabled(!canContinue)
            .accessibilityIdentifier("onboarding.next")
        }
        .padding(.horizontal, metrics.size(18)).padding(.vertical, metrics.size(12))
        .background(theme[.bgSunken])
        .overlay(alignment: .top) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
    }

    private var webFootnote: String {
        step == .features
            ? format("onboarding.web.featuresEnabledOf", Feature.allCases.filter(environment.features.isOn).count,
                     Feature.allCases.count)
            : String(localized: "onboarding.web.footerNote")
    }

    // MARK: - Chrome

    private var header: some View {
        HStack(spacing: metrics.space(.m)) {
            Text("onboarding.kicker")
                .font(metrics.font(.footnote).weight(.semibold))
                .foregroundStyle(theme[.textSecondary])
            Spacer()
            HStack(spacing: metrics.space(.xs)) {
                ForEach(Array(steps.enumerated()), id: \.element) { position, _ in
                    Capsule()
                        .fill(position <= index ? theme[.accent] : theme[.borderSubtle])
                        .frame(width: metrics.size(position == index ? 18 : 6), height: metrics.size(6))
                }
            }
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: format("onboarding.progress", index + 1, steps.count)))
            .accessibilityIdentifier("onboarding.progress")
        }
        .padding(.horizontal, metrics.space(.xxl))
        .padding(.vertical, metrics.space(.l))
    }

    private var footer: some View {
        HStack(spacing: metrics.space(.m)) {
            Text(verbatim: footnote)
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
                .lineLimit(2)
            Spacer()
            Button("onboarding.skip") { skip() }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("onboarding.skip")
            if index > 0 {
                Button("onboarding.back") { move(-1) }
                    .keyboardShortcut("[", modifiers: .command)
                    .accessibilityIdentifier("onboarding.back")
            }
            Button(isLast ? LocalizedStringKey("onboarding.finish") : "onboarding.next") { next() }
                .keyboardShortcut(.defaultAction)
                .disabled(!canContinue)
                .accessibilityIdentifier("onboarding.next")
        }
        .padding(.horizontal, metrics.space(.xxl))
        .padding(.vertical, metrics.space(.l))
    }

    private var footnote: String {
        step == .features
            ? format("onboarding.features.count", Feature.allCases.filter(environment.features.isOn).count,
                     Feature.allCases.count)
            : String(localized: "onboarding.footnote")
    }

    // MARK: - Steps

    @ViewBuilder
    private var content: some View {
        switch step {
        case .name: nameStep
        case .importData: OnboardingImportStep(workspace: workspace, undoManager: undoManager)
        case .appearance: appearanceStep
        case .agents: OnboardingAgentsStep()
        case .features: featuresStep
        case .mcp: OnboardingMcpStep(store: environment.mcpStore)
        }
    }

    private var nameStep: some View {
        VStack(spacing: metrics.space(.l)) {
            Spacer(minLength: 0)
            Circle()
                .fill(theme[.accentSoft])
                .frame(width: metrics.size(64), height: metrics.size(64))
                .overlay {
                    Text(verbatim: initial)
                        .font(metrics.font(.title1))
                        .foregroundStyle(theme[.accent])
                }
                .accessibilityHidden(true)
            Text("onboarding.name.title").font(metrics.font(.title2))
            Text("onboarding.name.subtitle")
                .foregroundStyle(theme[.textSecondary])
                .multilineTextAlignment(.center)
            TextField(text: $name, prompt: Text("onboarding.name.placeholder")) {
                Text("onboarding.name.label")
            }
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            .multilineTextAlignment(.center)
            .frame(maxWidth: metrics.size(280))
            .focused($nameFocused)
            .onChange(of: name) { nameError = nil }
            .accessibilityIdentifier("onboarding.name")
            if let nameError {
                Text(verbatim: nameError)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.statusStopped])
                    .accessibilityIdentifier("onboarding.name.error")
            }
            Text("onboarding.name.note")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    private var appearanceStep: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            OnboardingStepTitle(title: "onboarding.appearance.title", subtitle: "onboarding.appearance.subtitle")
            Picker(selection: Binding {
                environment.visualStyle
            } set: { style in
                environment.preferences?.update { $0.visualStyle = style == .normal ? nil : style.rawValue }
            }) {
                ForEach(VisualStyle.allCases, id: \.self) { Text($0.title).tag($0) }
            } label: {
                Text("settings.appearance.style")
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .accessibilityIdentifier("onboarding.style")
            if metrics.isWebInterface {
                ThemeGrid()
            } else {
                ScrollView {
                    ThemeGrid()
                }
            }
        }
    }

    private var featuresStep: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            OnboardingStepTitle(title: "onboarding.features.title", subtitle: "onboarding.features.subtitle")
            Form {
                Section {
                    ForEach(Feature.allCases, id: \.self) { FeatureRow(feature: $0, showsOptions: false) }
                }
            }
            .formStyle(.grouped)
        }
    }

    // MARK: - Actions

    private var suggestedName: String {
        if let profileID = environment.profileID, let entry = environment.profiles?.document.profile(profileID),
           let named = entry.name {
            return named
        }
        return OnboardingName.suggested(fullName: NSFullUserName(), userName: NSUserName())
    }

    private var initial: String {
        name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
    }

    private func next() {
        guard canContinue else { return }
        guard step == .name else {
            if isLast { finish() } else { move(1) }
            return
        }
        // The name is the running profile's name (P5-9).
        guard let profileID = environment.profileID else { return move(1) }
        saving = true
        let trimmedPhoto = photo.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { saving = false }
            do {
                if metrics.isWebInterface {
                    environment.preferences?.update {
                        $0.displayName = name.trimmingCharacters(in: .whitespaces)
                        $0.profileImageUrl = trimmedPhoto.isEmpty ? nil : trimmedPhoto
                    }
                }
                if environment.activeProfileName != name.trimmingCharacters(in: .whitespaces) {
                    try await environment.renameProfile(profileID, to: name)
                }
                move(1)
            } catch let failure as ProfileError {
                nameError = failure.localizedMessage
            } catch {
                nameError = error.localizedDescription
            }
        }
    }

    private func move(_ offset: Int) {
        let target = index + offset
        guard steps.indices.contains(target) else { return }
        step = steps[target]
        if step == .name { nameFocused = true }
    }

    private func skip() {
        environment.preferences?.update { $0.onboardingDone = true }
        close()
    }

    private func close() {
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private func finish() {
        environment.preferences?.update { preferences in
            preferences.onboardingDone = true
            preferences.setupHidden = nil
        }
        environment.showingHome = true
        close()
    }
}

/// A step's title and one-line explanation.
private struct OnboardingStepTitle: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface {
            OnboardingWebIntro(title: title, subtitle: Text(subtitle))
        } else {
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                Text(title).font(metrics.font(.title2))
                Text(subtitle)
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Import

/// The Tauri app's data (P1-12): the import sheet over this one, then what it added.
private struct OnboardingImportStep: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var importing = false
    @State private var imported: TauriImport.Report?

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            OnboardingStepTitle(title: "onboarding.import.title", subtitle: "onboarding.import.subtitle")
            if let imported {
                Label {
                    Text(verbatim: format("onboarding.import.done", imported.groups, imported.projects, imported.panes))
                } icon: {
                    Image(systemName: "checkmark.circle.fill").webProfileSized(14).foregroundStyle(theme[.statusActive])
                }
                .accessibilityIdentifier("onboarding.import.summary")
            }
            Button(imported == nil ? LocalizedStringKey("onboarding.import.open") : "onboarding.import.again") { importing = true }
                .accessibilityIdentifier("onboarding.import.open")
            Text("onboarding.import.note")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .gitWebSheet(isPresented: $importing, width: 520) {
            TauriImportSheet(workspace: workspace, undoManager: undoManager, onImported: { imported = $0 })
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
    }
}

// MARK: - Agents

/// The agents found on this Mac (Settings › Agents rows: turn on or off, install through P3-3).
private struct OnboardingAgentsStep: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @State private var scan = 0

    private var agents: [AgentDescriptor] { AgentRegistry.builtin.descriptors.filter { !$0.isShell } }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            HStack(alignment: .top) {
                OnboardingStepTitle(title: "onboarding.agents.title", subtitle: "onboarding.agents.subtitle")
                Spacer()
                Button("onboarding.agents.rescan") {
                    environment.launchers.invalidate()
                    scan += 1
                }
                .accessibilityIdentifier("onboarding.agents.rescan")
            }
            Form {
                Section {
                    ForEach(agents) { AgentSettingsRow(agent: $0) }
                }
            }
            .formStyle(.grouped)
            .id(scan)
            .accessibilityIdentifier("onboarding.agents")
        }
    }
}

// MARK: - MCP

/// MCP servers found per agent and the gaps between agents (upstream `McpStep`); Sync All copies
/// each server to the agents missing it through the MCP store (P5-21), never overwriting.
private struct OnboardingMcpStep: View {
    let store: McpStore?
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var snapshots: [McpAgentSnapshot]?
    @State private var busy = false
    @State private var copied: Int?
    @State private var notCopied = 0

    private var groups: [McpServerGroup] { McpStore.groups(snapshots ?? []) }
    private var gaps: [McpServerGroup] { groups.filter { !$0.missingAgents.isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            OnboardingStepTitle(title: "onboarding.mcp.title", subtitle: "onboarding.mcp.subtitle")
            HStack(spacing: metrics.space(.xl)) {
                stat(groups.count, "onboarding.mcp.stat.servers", theme[.accent])
                stat((snapshots ?? []).filter { $0.isReadable && !$0.servers.isEmpty }.count,
                     "onboarding.mcp.stat.agents", theme[.statusActive])
                stat(gaps.count, "onboarding.mcp.stat.gaps", gaps.isEmpty ? theme[.textTertiary] : theme[.statusWaiting])
            }
            if let snapshots {
                VStack(spacing: 0) {
                    ForEach(snapshots, id: \.agent) { row($0) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("onboarding.mcp.agents")
            } else {
                HStack(spacing: metrics.space(.s)) {
                    ProgressView().controlSize(.small)
                    Text("onboarding.mcp.scanning").foregroundStyle(theme[.textSecondary])
                }
            }
            action
            Spacer(minLength: 0)
        }
        .task { await rescan() }
    }

    private func stat(_ value: Int, _ label: LocalizedStringKey, _ color: Color) -> some View {
        HStack(spacing: metrics.space(.xs)) {
            Circle().fill(color).frame(width: metrics.size(6), height: metrics.size(6))
            Text(verbatim: "\(value)").font(metrics.font(.body).weight(.semibold)).monospacedDigit()
            Text(label).foregroundStyle(theme[.textSecondary])
        }
        .accessibilityElement(children: .combine)
    }

    private func row(_ snapshot: McpAgentSnapshot) -> some View {
        let found = snapshot.sources.contains(where: \.exists)
        return HStack(spacing: metrics.space(.m)) {
            Text(verbatim: AgentLabels.name(for: snapshot.agent.rawValue))
            Spacer()
            if !snapshot.servers.isEmpty {
                Text(verbatim: format("onboarding.mcp.serverCount", snapshot.servers.count))
                    .foregroundStyle(theme[.textSecondary])
            }
            Text(!snapshot.isReadable ? LocalizedStringKey("onboarding.mcp.unreadable")
                 : found ? "onboarding.mcp.found" : "onboarding.mcp.missing")
                .font(metrics.font(.footnote))
                .foregroundStyle(!snapshot.isReadable ? theme[.statusWaiting] : found ? theme[.statusActive] : theme[.textTertiary])
        }
        .padding(.vertical, metrics.space(.s))
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("onboarding.mcp.agent.\(snapshot.agent.rawValue)")
    }

    @ViewBuilder
    private var action: some View {
        if snapshots == nil {
            EmptyView()
        } else if groups.isEmpty {
            note(String(localized: "onboarding.mcp.nothing"))
        } else if !gaps.isEmpty {
            HStack(spacing: metrics.space(.m)) {
                Button {
                    Task { await syncAll() }
                } label: {
                    Text(verbatim: format("onboarding.mcp.syncAll", gaps.count))
                }
                .disabled(busy || store == nil)
                .accessibilityIdentifier("onboarding.mcp.syncAll")
                if busy { ProgressView().controlSize(.small) }
            }
            note(String(localized: "onboarding.mcp.syncHint"))
        } else if let copied, copied > 0 {
            note(format("onboarding.mcp.copied", copied))
        } else {
            note(String(localized: "onboarding.mcp.aligned"))
        }
        if notCopied > 0 {
            Text(verbatim: format("onboarding.mcp.notCopied", notCopied))
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.statusWaiting])
                .accessibilityIdentifier("onboarding.mcp.notCopied")
        }
    }

    private func note(_ text: String) -> some View {
        Text(verbatim: text)
            .font(metrics.font(.footnote))
            .foregroundStyle(theme[.textTertiary])
            .accessibilityIdentifier("onboarding.mcp.note")
    }

    private func rescan() async {
        guard let store else { return snapshots = [] }
        snapshots = (try? await store.scan(scope: .global, repository: nil)) ?? []
    }

    private func syncAll() async {
        guard let store else { return }
        busy = true
        defer { busy = false }
        let results = (try? await store.syncAll(gaps, scope: .global, repository: nil)) ?? []
        var written = 0, failed = 0
        for result in results {
            switch result.result {
            case .success(let outcomes):
                for outcome in outcomes {
                    switch outcome.status {
                    case .written: written += 1
                    case .skipped: break
                    case .blocked, .failed: failed += 1
                    }
                }
            case .failure:
                failed += 1
            }
        }
        copied = written
        notCopied = failed
        await rescan()
    }
}

// MARK: - Welcome back

/// Welcome back after an update or a long absence (upstream `WelcomeModal`).
struct WelcomeBackSheet: View {
    let welcome: WelcomeBack
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var name: String { environment.activeProfileName }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text(verbatim: format("welcome.day", welcome.day, AppIdentity.productName))
        } content: {
            VStack(spacing: metrics.size(14)) {
            Circle()
                .fill(theme[.accentSoft])
                .frame(width: metrics.size(56), height: metrics.size(56))
                .overlay {
                    Text(verbatim: name.first.map { String($0).uppercased() } ?? "?")
                        .font(metrics.font(.title1))
                        .foregroundStyle(theme[.accent])
                }
                .accessibilityHidden(true)
            Text(verbatim: format("welcome.day", welcome.day, AppIdentity.productName))
                .font(metrics.font(.footnote).weight(.semibold))
                .foregroundStyle(theme[.textSecondary])
            Text(verbatim: format("welcome.greeting", name))
                .font(metrics.font(.title1))
            Text(verbatim: subtitle)
                .foregroundStyle(theme[.textSecondary])
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("welcome.subtitle")
            }.frame(maxWidth: .infinity)
        } footer: {
            Spacer()
            Button("welcome.skip", action: dismiss)
            Button("welcome.start") { environment.showingHome = false; dismiss() }
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("welcome.start")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome")
    }

    private var nativeBody: some View {
        VStack(spacing: metrics.space(.l)) {
            Circle()
                .fill(theme[.accentSoft])
                .frame(width: metrics.size(56), height: metrics.size(56))
                .overlay {
                    Text(verbatim: name.first.map { String($0).uppercased() } ?? "?")
                        .font(metrics.font(.title1))
                        .foregroundStyle(theme[.accent])
                }
                .accessibilityHidden(true)
            Text(verbatim: format("welcome.day", welcome.day, AppIdentity.productName))
                .font(metrics.font(.footnote).weight(.semibold))
                .foregroundStyle(theme[.textSecondary])
            Text(verbatim: format("welcome.greeting", name))
                .font(metrics.font(.title1))
            Text(verbatim: subtitle)
                .foregroundStyle(theme[.textSecondary])
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("welcome.subtitle")
            HStack(spacing: metrics.space(.m)) {
                Button("welcome.skip") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("welcome.start") {
                    environment.showingHome = false
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("welcome.start")
            }
            .padding(.top, metrics.space(.s))
        }
        .padding(metrics.space(.huge))
        .frame(width: metrics.size(420))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome")
    }

    private var subtitle: String {
        if let from = welcome.updatedFrom {
            return format("welcome.updated", AppEnvironment.appVersion, from)
        }
        return String(localized: "welcome.subtitle")
    }
}

// MARK: - Launch

extension AppEnvironment {
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    /// The MCP store over the integrations home, backing up into the running profile.
    var mcpStore: McpStore? {
        guard let locations, let profileID else { return nil }
        var home = McpHome.current()
        #if DEBUG
        if UserDefaults.standard.string(forKey: "AletheIntegrationsHome") != nil {
            home = McpHome(home: Self.integrationsHome)
        }
        #endif
        return McpStore(home: home, writer: ConfigFileWriter(profileDirectory: locations.profileDirectory(profileID)))
    }

    /// Records the launch and opens the onboarding or welcome back when due and nothing else is shown.
    func greetLaunch() {
        guard let preferences, let workspace else { return }
        var greeting = LaunchGreeting.none
        let hasProjects = !workspace.document.projects.isEmpty
        preferences.update { greeting = $0.recordLaunch(version: Self.appVersion, hasProjects: hasProjects) }
        guard editorRequest == nil else { return }
        switch greeting {
        case .onboarding where Self.greets("AletheUITestOnboarding"):
            editorRequest = .onboarding
        case .welcomeBack(let welcome) where Self.greets("AletheUITestWelcome"):
            editorRequest = .welcome(welcome)
        default:
            break
        }
    }

    /// UI tests launch on a fresh data root every time: the greeting appears only when the test asks
    /// for it (`-AletheUITestOnboarding YES`, `-AletheUITestWelcome YES`).
    private static func greets(_ testFlag: String) -> Bool {
        #if DEBUG
        if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil {
            return UserDefaults.standard.bool(forKey: testFlag)
        }
        #endif
        return true
    }
}
