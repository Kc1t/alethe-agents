import AletheAgents
import AletheDesign
import AletheFoundation
import AletheGit
import AletheMerge
import AletheModel
import SwiftUI

/// Merge Center (P4-10…P4-13; upstream merge plugin) for a project's repository. The Analyze stage
/// trial-merges a source branch into a target in a disposable worktree and lists the conflicts
/// with their class and resolution strategy. With `resumeID` it reopens a prepared environment
/// from its metadata at the stage it had reached.
struct MergeCenterSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let projectID: ProjectID?
    var resumeID: String?
    @Environment(AppEnvironment.self) var environment
    @State var agent: AgentKind = .claude
    @State var model: MergeCenterModel?
    @State var confirmAbort = false
    @State var confirmCleanup = false
    @State var testingBranch = false
    @Environment(\.dismiss) var dismiss
    @Environment(\.theme) var theme
    @Environment(\.metrics) var metrics

    var project: Project? { projectID.flatMap { workspace.document.project($0) } }

    @Environment(\.gitModalClose) var closeOverlay

    var body: some View {
        Group {
            if metrics.isWebInterface {
                webContent
            } else {
                nativeContent
            }
        }
    }

    var nativeContent: some View {
        sheetContent
        .frame(width: metrics.size(560), height: metrics.size(600))
        .navigationTitle(Text("merge.title"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("merge.close") { dismiss() }
                    .accessibilityIdentifier("merge.close")
            }
        }
    }

    var sheetContent: some View {
        Group {
            if let model {
                content(model)
            } else {
                Text("merge.noProject")
                    .foregroundStyle(theme[.textSecondary])
                    .padding(metrics.space(.xl))
            }
        }
        .task { await loadModel() }
        .onDisappear { model?.cancel() }
        .accessibilityIdentifier("merge.center")
    }

    func loadModel() async {
        guard let project else { return }
        let model = MergeCenterModel(folder: URL(filePath: project.folder, directoryHint: .isDirectory),
                                     projectID: project.id, bus: environment.multiagent.bus)
        self.model = model
        let last = AgentRegistry.builtin.parse(environment.preferences?.document.lastAgent)
        agent = last.flatMap { agents.contains($0) ? $0 : nil } ?? (agents.contains(.claude) ? .claude : agents.first ?? .claude)
        await model.load(resume: resumeID)
        if metrics.isWebInterface {
            if let provider = project.conflictAgentProvider, let selected = environment.agentRegistry.parse(provider), agents.contains(selected) { agent = selected }
            if let commands = project.validationCommands { model.commandsText = commands.joined(separator: "\n") }
            model.healthCheckCommand = project.healthCheckCommand
            model.healthCheckPath = project.healthCheckPath
        }
    }

    @ViewBuilder
    func content(_ model: MergeCenterModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            stageHeader(model.stage)
                .padding(metrics.space(.l))
            Divider()
            if let error = model.error {
                Label { Text(verbatim: error).textSelection(.enabled) } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.callout)
                .foregroundStyle(theme[.statusStopped])
                .padding(metrics.space(.m))
                .accessibilityIdentifier("merge.error")
            }
            if model.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                switch model.stage {
                case .analyze: analyze(model)
                case .prepare: prepare(model)
                case .validate: validate(model)
                case .finish: finish(model)
                }
            }
        }
        .confirmationDialog("merge.abort.confirm", isPresented: $confirmAbort) {
            Button("merge.abort", role: .destructive) { model.abort() }
        }
        .confirmationDialog("merge.cleanup.confirm", isPresented: $confirmCleanup) {
            Button("merge.cleanup", role: .destructive) { model.forceCleanup() }
        }
        .gitWebSheet(isPresented: $testingBranch, width: 560) {
            BranchTestingSheet(folder: model.folder, initialBranch: model.source)
        }
    }

    // MARK: Shared

    /// Progress with cancel while an operation runs, otherwise the given actions.
    @ViewBuilder
    func actionRow(_ model: MergeCenterModel, @ViewBuilder _ actions: () -> some View) -> some View {
        HStack {
            if model.running {
                ProgressView().controlSize(.small)
                Text("merge.working").foregroundStyle(theme[.textSecondary])
                Button("merge.cancel") { model.cancel() }
                    .accessibilityIdentifier("merge.cancel")
            } else {
                actions()
            }
            Spacer()
        }
    }

    func outputBox(_ text: String) -> some View {
        ScrollView {
            Text(verbatim: text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("merge.output")
    }

    func abortButton(_ model: MergeCenterModel) -> some View {
        Button("merge.abort", role: .destructive) { confirmAbort = true }
            .disabled(model.environment == nil)
            .accessibilityIdentifier("merge.abort")
    }

    // MARK: Prepare

    func prepare(_ model: MergeCenterModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            actionRow(model) {
                Picker("merge.agent", selection: $agent) {
                    ForEach(agents, id: \.self) { kind in
                        Text(verbatim: AgentLabels.name(for: kind.rawValue)).tag(kind)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .disabled(agents.isEmpty)
                .help(Text("merge.agent"))
                .accessibilityIdentifier("merge.agent")
                Button("merge.resolveWithAgent") { resolveWithAgent(model) }
                    .disabled(model.environment == nil || !agents.contains(agent))
                    .accessibilityIdentifier("merge.resolveWithAgent")
                Button("merge.refresh") { model.refreshConflicts() }
                Button("merge.rebase") { model.rebase() }
                    .accessibilityIdentifier("merge.rebase")
                abortButton(model)
                Button("merge.continue") { model.stage = .validate }
                    .disabled(!model.conflicts.isEmpty)
                    .accessibilityIdentifier("merge.continue")
            }
            if let path = model.environment?.path.path {
                Text(verbatim: path)
                    .font(.caption.monospaced())
                    .foregroundStyle(theme[.textSecondary])
                    .textSelection(.enabled)
            }
            if let note = model.note { outputBox(note).frame(maxHeight: metrics.size(80)) }
            Divider()
            conflictList(model.conflicts)
        }
        .padding(metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Enabled agents whose CLI is installed (shells cannot resolve conflicts).
    var agents: [AgentKind] {
        let preferences = environment.preferences?.document
        return environment.agentRegistry.enabledKinds(preferences?.enabledAgents).filter { kind in
            guard let command = environment.agentRegistry.descriptor(for: kind)?.cliCommand else { return false }
            return environment.launchers.resolve(command, override: preferences?.cliPaths?[kind.rawValue]) != nil
        }
    }

    /// Opens a terminal of the chosen agent in the merge environment, primed with the conflict
    /// instruction; the choice becomes the last used agent.
    func resolveWithAgent(_ model: MergeCenterModel) {
        guard let project, let path = model.environment?.path.path, agents.contains(agent) else { return }
        let tab = PaneTab(agent: agent.rawValue, title: String(localized: "merge.agentPaneName"),
                          workingDirectory: path,
                          extraArguments: metrics.isWebInterface ? ModelDiscovery.arguments([], model: project.conflictAgentModel ?? "", for: agent) : [],
                          initialPrompt: ConflictResolution.agentInstruction())
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newTerminal")) {
            $0.addPane(to: project.id, tab: tab)
        }
        environment.preferences?.update { $0.lastAgent = agent.rawValue }
        if metrics.isWebInterface, let closeOverlay { closeOverlay() } else { dismiss() }
    }

    // MARK: Validate

    func validate(_ model: MergeCenterModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            Text("merge.validate.commands").font(.headline)
            TextEditor(text: Bindable(model).commandsText)
                .font(.body.monospaced())
                .frame(height: metrics.size(90))
                .accessibilityIdentifier("merge.validate.commands")
            actionRow(model) {
                Button("merge.validate.run") { model.validate() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("merge.validate.run")
                abortButton(model)
                Button("merge.continue") { model.stage = .finish }
                    .accessibilityIdentifier("merge.continue")
            }
            outcomeDetails(model)
        }
        .padding(metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The last validate/finalize outcome: its message, each command, the probe and the contract check.
    @ViewBuilder
    func outcomeDetails(_ model: MergeCenterModel) -> some View {
        if model.note != nil || model.outcome != nil {
            ScrollView {
                VStack(alignment: .leading, spacing: metrics.space(.m)) {
                    if let note = model.note {
                        Text(verbatim: note)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("merge.output")
                    }
                    if let outcome = model.outcome {
                        ValidationStepsView(steps: outcome.validation?.steps ?? [])
                        if let probe = outcome.validation?.healthProbe { HealthProbeSummaryView(result: probe) }
                        if let warnings = outcome.contractWarnings { ContractWarningsView(warnings: warnings) }
                    }
                }
            }
        } else {
            Spacer()
        }
    }

    // MARK: Finish

    func finish(_ model: MergeCenterModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            actionRow(model) {
                Button("merge.finalize") { model.finalize() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.environment == nil)
                    .accessibilityIdentifier("merge.finalize")
                abortButton(model)
                Button("merge.cleanup", role: .destructive) { confirmCleanup = true }
                    .disabled(model.environment == nil)
                    .accessibilityIdentifier("merge.cleanup")
            }
            if model.merged {
                Label("merge.merged", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(theme[.statusActive])
            }
            outcomeDetails(model)
        }
        .padding(metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Stage header

    func stageHeader(_ current: MergeCenterStage) -> some View {
        HStack(spacing: metrics.space(.s)) {
            ForEach(Array(MergeCenterStage.allCases.enumerated()), id: \.element) { index, stage in
                if index > 0 {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(theme[.textSecondary])
                }
                Text(stageTitle(stage))
                    .font(.callout.weight(stage == current ? .semibold : .regular))
                    .foregroundStyle(stage == current ? theme[.accent] : theme[.textSecondary])
            }
            Spacer()
        }
        .accessibilityIdentifier("merge.stages")
    }

    func stageTitle(_ stage: MergeCenterStage) -> LocalizedStringKey {
        switch stage {
        case .analyze: "merge.stage.analyze"
        case .prepare: "merge.stage.prepare"
        case .validate: "merge.stage.validate"
        case .finish: "merge.stage.finish"
        }
    }

    // MARK: Analyze

    func analyze(_ model: MergeCenterModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            Picker("merge.source", selection: Bindable(model).source) {
                ForEach(model.branches, id: \.self) { Text(verbatim: $0).tag($0) }
            }
            .accessibilityIdentifier("merge.source")
            Picker("merge.target", selection: Bindable(model).target) {
                ForEach(model.branches, id: \.self) { Text(verbatim: $0).tag($0) }
            }
            .accessibilityIdentifier("merge.target")
            HStack {
                if model.running {
                    ProgressView().controlSize(.small)
                    Text("merge.analyzing").foregroundStyle(theme[.textSecondary])
                    Button("merge.cancel") { model.cancel() }
                        .accessibilityIdentifier("merge.cancel")
                } else {
                    Button("merge.analyze") { model.analyze() }
                        .disabled(!model.canAnalyze)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("merge.analyze")
                }
                Spacer()
            }
            HStack {
                if model.analysis != nil, !model.running {
                    Button("merge.prepare") { model.prepare() }
                        .accessibilityIdentifier("merge.prepare")
                }
                Button("menu.merge.branchTesting") { testingBranch = true }
                    .disabled(model.source.isEmpty || model.running)
                    .accessibilityIdentifier("merge.testBranch")
            }
            Divider()
            if let analysis = model.analysis {
                result(analysis)
            } else {
                Spacer()
            }
        }
        .padding(metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    func result(_ analysis: MergeAnalysis) -> some View {
        if analysis.clean {
            Label("merge.clean", systemImage: "checkmark.circle.fill")
                .foregroundStyle(theme[.statusActive])
                .accessibilityIdentifier("merge.clean")
            Spacer()
        } else {
            HStack {
                Text("merge.conflicts").font(.headline)
                Text(verbatim: "\(analysis.conflicts.count)")
                    .font(.headline)
                    .foregroundStyle(theme[.statusStopped])
            }
            conflictList(analysis.conflicts)
        }
    }

    func conflictList(_ conflicts: [ConflictFile]) -> some View {
            List(conflicts, id: \.path) { conflict in
                VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                    HStack {
                        Text(verbatim: conflict.path)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                        Spacer()
                        Text(verbatim: conflict.class.variantName)
                            .font(.caption)
                            .foregroundStyle(theme[.accent])
                    }
                    Text(verbatim: conflict.class.strategy)
                        .font(.caption)
                        .foregroundStyle(theme[.textSecondary])
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, metrics.space(.xs))
            }
            .accessibilityIdentifier("merge.conflictList")
    }
}

/// State of the Merge Center: repository branches, the chosen pair, and the running analysis.
@MainActor @Observable
final class MergeCenterModel {
    let folder: URL
    let projectID: ProjectID?
    private(set) var root: URL?
    private(set) var branches: [String] = []
    var source = ""
    var target = ""
    var stage = MergeCenterStage.analyze {
        didSet { if stage != oldValue { recordStage() } }
    }
    private(set) var environment: ConflictEnvironment?
    private(set) var conflicts: [ConflictFile] = []
    /// Validation commands for this run, one per line.
    var commandsText = ""
    var healthCheckCommand: String?
    var healthCheckPath: String?
    /// Output of the last prepare / rebase / validate / finish step.
    private(set) var note: String?
    private(set) var merged = false
    /// The last validate/finalize outcome, for its structured results.
    private(set) var outcome: MergeFinishOutcome?
    private(set) var analysis: MergeAnalysis?
    private(set) var loading = true
    private(set) var running = false
    private(set) var error: String? { didSet { if error != oldValue { AppLog.shown(error, .git) } } }
    private var task: Task<Void, Never>?
    /// Analysis and conflict-resolution events (P6-19; upstream `merge_analyzer.rs`,
    /// `conflict_resolution.rs`).
    @ObservationIgnored let events: EventOutbox

    init(folder: URL, projectID: ProjectID? = nil, bus: EventBus? = nil) {
        self.folder = folder
        self.projectID = projectID
        events = EventOutbox(bus: bus)
    }

    var canAnalyze: Bool { root != nil && !source.isEmpty && !target.isEmpty && source != target }

    func load(resume id: String? = nil) async {
        defer { loading = false }
        do {
            let root = try await GitRepository.discover(folder)
            self.root = root
            let repository = GitRepository(root: root)
            branches = try await repository.branches().filter { !$0.isRemote }.map(\.name).sorted()
            let current = try await repository.currentBranch()
            target = current ?? branches.first ?? ""
            source = branches.first { $0 != target } ?? ""
            commandsText = ValidationSettings.suggested(for: root).commands.joined(separator: "\n")
            if let id { try await resume(id: id, root: root) }
        } catch {
            self.error = String(describing: error)
        }
    }

    /// Restores a prepared environment from its metadata: branches, live conflicts, the stage it had
    /// reached and its last validation (the sheet no longer restarts at Analyze).
    private func resume(id: String, root: URL) async throws {
        let (env, meta) = try await Task.detached { try await ConflictResolution(root: root).resume(id: id) }.value
        source = meta.source
        target = meta.target
        environment = env
        conflicts = env.conflicts
        if let report = meta.lastValidation {
            outcome = MergeFinishOutcome(
                merged: false, stage: report.status == .failed ? .validation : .validated, output: "",
                validation: report, contractWarnings: meta.contractWarnings)
        }
        stage = MergeResumePoint.stage(recorded: meta.stage, conflictPaths: meta.conflictPaths,
                                       unresolved: env.conflicts.map(\.path))
    }

    /// Persists the stage reached (and the latest validation) in the environment's metadata, so the
    /// sidebar panel shows it and a reopened sheet resumes there. Best-effort.
    private func recordStage() {
        guard let root, let id = environment?.id, stage != .analyze else { return }
        let (stage, report, warnings) = (stage, outcome?.validation, outcome?.contractWarnings)
        Task.detached {
            try? ConflictResolution(root: root).updateMeta(id: id) {
                $0.stage = stage
                if let report {
                    $0.lastValidation = report
                    $0.contractWarnings = warnings
                }
            }
        }
    }

    func analyze() {
        guard let root, canAnalyze else { return }
        let (source, target) = (source, target)
        running = true
        error = nil
        analysis = nil
        task = Task {
            // The analyzer runs git subprocesses; keep it off the main actor.
            let work = Task.detached {
                do { return Result<MergeAnalysis, Error>.success(
                    try await MergeAnalyzer(root: root).analyze(source: source, target: target)) }
                catch { return .failure(error) }
            }
            let outcome = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success(let result):
                analysis = result
                events.publish(.mergeAnalyzed(projectID: projectID?.rawValue, source: result.source, target: result.target,
                                              clean: result.clean, conflictCount: result.conflicts.count,
                                              classes: result.classes.map(\.variantName)))
            case .failure(let failure): error = String(describing: failure)
            }
            running = false
        }
    }

    /// Cancels the running operation; the git process is terminated and temporary worktrees torn down.
    private var handle: MergeEnvHandle? {
        environment.map { MergeEnvHandle(id: $0.id, source: source, target: target, conflictPaths: conflicts.map(\.path)) }
    }

    private var settings: ValidationSettings {
        ValidationSettings(commands: commandsText.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
            healthCheckCommand: healthCheckCommand, healthCheckPath: healthCheckPath)
    }

    /// Runs `operation` off the main actor with the shared progress/cancel state.
    private func perform<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T,
                                      then apply: @escaping @MainActor (T) -> Void) {
        running = true
        error = nil
        task = Task {
            // Detached so git runs off the main actor; cancellation is forwarded so the git
            // process is terminated (GitRunner) and the environment torn down.
            let work = Task.detached { () -> Result<T, Error> in
                do { return .success(try await operation()) } catch { return .failure(error) }
            }
            let outcome = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success(let value): apply(value)
            case .failure(let failure): error = String(describing: failure)
            }
            running = false
        }
    }

    func prepare() {
        guard let root else { return }
        let (source, target) = (source, target)
        let projectID = projectID?.rawValue
        perform({ try await ConflictResolution(root: root).prepare(source: source, target: target, projectId: projectID) }) { env in
            self.events.publish(BusEvent.mergePrepared(
                environmentID: env.id, projectID: projectID, source: source, target: target, clean: env.clean,
                conflictCount: env.conflicts.count, environmentPath: env.path.path))
            self.environment = env
            self.conflicts = env.conflicts
            self.note = nil
            self.stage = env.clean ? .validate : .prepare
        }
    }

    func refreshConflicts() {
        guard let root, let id = environment?.id else { return }
        perform({ try await ConflictResolution(root: root).conflicts(id: id) }) { self.conflicts = $0 }
    }

    func rebase() {
        guard let root, let id = environment?.id else { return }
        perform({ try await ConflictResolution(root: root).rebaseOntoTarget(id: id) }) { outcome in
            self.note = outcome.output
            if case .conflicted(let files) = outcome { self.conflicts = files }
        }
    }

    func abort() {
        guard let root, let id = environment?.id else { return }
        perform({ try await ConflictResolution(root: root).abort(id: id) }) { _ in
            self.events.publish(.mergeAborted(environmentID: id, projectID: self.projectID?.rawValue))
            self.reset()
        }
    }

    func validate() {
        guard let root, let handle else { return }
        let settings = settings
        perform({ try await MergeFinisher(root: root).validate(handle, settings: settings) }) { outcome in
            self.publishEvents(of: outcome, handle: handle)
            self.note = Self.describe(outcome)
            self.outcome = outcome
            self.recordStage()
        }
    }

    func finalize() {
        guard let root, let handle else { return }
        let settings = settings
        perform({ try await MergeFinisher(root: root).finalize(handle, settings: settings) }) { outcome in
            self.publishEvents(of: outcome, handle: handle)
            self.note = Self.describe(outcome)
            self.outcome = outcome
            self.merged = outcome.merged
            if outcome.merged { self.environment = nil }
        }
    }

    /// `MergeValidated`/`MergeValidationFailed` when the pipeline ran, then `MergeMerged`, like
    /// upstream's validate and finalize.
    private func publishEvents(of outcome: MergeFinishOutcome, handle: MergeEnvHandle) {
        let projectID = projectID?.rawValue
        if let report = outcome.validation {
            let failed = outcome.stage == .validation ? (report.failedCommand ?? report.status.rawValue) : nil
            events.publish(.mergeValidation(environmentID: handle.id, projectID: projectID, failedStage: failed))
        }
        if outcome.merged {
            events.publish(.mergeMerged(environmentID: handle.id, projectID: projectID,
                                        source: handle.source, target: handle.target))
        }
    }

    func forceCleanup() {
        guard let root, let handle else { return }
        perform({ try await MergeFinisher(root: root).forceCleanup(handle) }) { _ in self.reset() }
    }

    private func reset() {
        environment = nil
        conflicts = []
        note = nil
        outcome = nil
        merged = false
        stage = .analyze
    }

    /// The outcome's headline; commands, probe and contract warnings render separately.
    private static func describe(_ outcome: MergeFinishOutcome) -> String {
        "[\(outcome.stage.rawValue)] \(outcome.output)"
    }

    func cancel() {
        task?.cancel()
        task = nil
        running = false
    }
}
