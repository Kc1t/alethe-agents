import AletheDesign
import AletheFoundation
import AletheGit
import AletheMerge
import AletheModel
import SwiftUI

/// Branch testing (P4-12; upstream `BranchTestingModal`): checks a branch out into a temporary
/// worktree, runs the validation commands, the optional health probe and the API contract check
/// there, and keeps the results per branch (`.alethe/branch-tests/results.json`).
struct BranchTestingSheet: View {
    let folder: URL?
    var initialBranch: String?
    @State var model: BranchTestingModel?
    @Environment(AppEnvironment.self) var environment
    @Environment(\.dismiss) var dismiss
    @Environment(\.theme) var theme
    @Environment(\.metrics) var metrics

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
        .frame(width: metrics.size(560), height: metrics.size(640))
        .navigationTitle(Text("branchTest.title"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("branchTest.close") { dismiss() }
                    .accessibilityIdentifier("branchTest.close")
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
        .accessibilityIdentifier("branchTest.sheet")
    }

    func loadModel() async {
        guard let folder else { return }
        let model = BranchTestingModel(folder: folder, initialBranch: initialBranch)
        self.model = model
        await model.load()
        if metrics.isWebInterface, let project = environment.workspace?.document.projects.first(where: {
            URL(filePath: $0.folder).standardizedFileURL == folder.standardizedFileURL
        }) {
            if let commands = project.validationCommands { model.commandsText = commands.joined(separator: "\n") }
            model.healthCommand = project.healthCheckCommand ?? ""
            model.healthPath = project.healthCheckPath ?? ""
        }
    }

    func content(_ model: BranchTestingModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            Text("branchTest.explain")
                .font(.callout)
                .foregroundStyle(theme[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if let error = model.error {
                Label { Text(verbatim: error).textSelection(.enabled) } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.callout)
                .foregroundStyle(theme[.statusStopped])
                .accessibilityIdentifier("branchTest.error")
            }
            Picker("branchTest.branch", selection: Bindable(model).branch) {
                ForEach(model.branches, id: \.self) { Text(verbatim: $0).tag($0) }
            }
            .accessibilityIdentifier("branchTest.branch")
            Text("branchTest.commands").font(.headline)
            TextEditor(text: Bindable(model).commandsText)
                .font(.body.monospaced())
                .frame(height: metrics.size(70))
                .accessibilityIdentifier("branchTest.commands")
            HStack {
                TextField("branchTest.healthCommand", text: Bindable(model).healthCommand)
                    .accessibilityIdentifier("branchTest.healthCommand")
                TextField("branchTest.healthPath", text: Bindable(model).healthPath)
                    .frame(width: metrics.size(140))
            }
            HStack {
                if model.running {
                    ProgressView().controlSize(.small)
                    Text(stepTitle(model.step)).foregroundStyle(theme[.textSecondary])
                    Button("merge.cancel") { model.cancel() }
                        .accessibilityIdentifier("branchTest.cancel")
                } else {
                    Button("branchTest.run") { model.run() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.branch.isEmpty || model.root == nil)
                        .accessibilityIdentifier("branchTest.run")
                }
                Spacer()
            }
            Divider()
            ScrollView {
                results(model).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(metrics.space(.l))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    func results(_ model: BranchTestingModel) -> some View {
        let history = model.log.history(for: model.branch)
        if let latest = history.last {
            VStack(alignment: .leading, spacing: metrics.space(.m)) {
                HStack {
                    statusLabel(latest.status)
                    Spacer()
                    Text(verbatim: String(format: String(localized: "branchTest.commit"), String(latest.commit.prefix(8))))
                        .font(metrics.isWebInterface ? metrics.monoFont(size: 11, weight: .regular) : .caption.monospaced())
                        .foregroundStyle(theme[.textSecondary])
                }
                ValidationStepsView(steps: latest.validation.steps)
                if let probe = latest.healthProbe { HealthProbeSummaryView(result: probe) }
                ContractWarningsView(warnings: latest.contractWarnings)
                if history.count > 1 {
                    Text("branchTest.history").font(metrics.isWebInterface ? metrics.font(size: 12, weight: .semibold) : .headline)
                    ForEach(Array(history.dropLast().reversed().enumerated()), id: \.offset) { _, run in
                        HStack {
                            statusLabel(run.status).font(metrics.isWebInterface ? metrics.font(size: 11) : .caption)
                            Text(run.finishedAt, format: .dateTime)
                                .font(metrics.isWebInterface ? metrics.font(size: 11) : .caption)
                                .foregroundStyle(theme[.textSecondary])
                            Spacer()
                            Text(verbatim: String(run.commit.prefix(8)))
                                .font(metrics.isWebInterface ? metrics.monoFont(size: 11, weight: .regular) : .caption.monospaced())
                                .foregroundStyle(theme[.textTertiary])
                        }
                    }
                }
            }
            .accessibilityIdentifier("branchTest.result")
        } else {
            Text("branchTest.none").foregroundStyle(theme[.textSecondary])
        }
    }

    @ViewBuilder
    func statusLabel(_ status: BranchTestResult.Status) -> some View {
        switch status {
        case .passed:
            Label("branchTest.status.passed", systemImage: "checkmark.circle.fill").foregroundStyle(theme[.statusActive])
        case .failed:
            Label("branchTest.status.failed", systemImage: "xmark.octagon.fill").foregroundStyle(theme[.statusStopped])
        case .cancelled:
            Label("branchTest.status.cancelled", systemImage: "stop.circle").foregroundStyle(theme[.textSecondary])
        case .unverified:
            Label("branchTest.status.unverified", systemImage: "questionmark.circle").foregroundStyle(theme[.statusWaiting])
        }
    }

    func stepTitle(_ step: BranchTestStep?) -> LocalizedStringKey {
        switch step {
        case .checkingOut, nil: "branchTest.step.checkingOut"
        case .validating: "branchTest.step.validating"
        case .probing: "branchTest.step.probing"
        case .checkingContract: "branchTest.step.checkingContract"
        case .cleaningUp: "branchTest.step.cleaningUp"
        }
    }
}

/// Branch list, the per-run settings, and the saved results of a repository.
@MainActor @Observable
final class BranchTestingModel {
    let folder: URL
    let initialBranch: String?
    private(set) var root: URL?
    private(set) var branches: [String] = []
    var branch = ""
    var commandsText = ""
    var healthCommand = ""
    var healthPath = ""
    private(set) var log = BranchTestLog()
    private(set) var running = false
    private(set) var step: BranchTestStep?
    private(set) var error: String? { didSet { if error != oldValue { AppLog.shown(error, .git) } } }
    private var task: Task<Void, Never>?

    init(folder: URL, initialBranch: String?) {
        self.folder = folder
        self.initialBranch = initialBranch
    }

    func load() async {
        do {
            let root = try await GitRepository.discover(folder)
            self.root = root
            let repository = GitRepository(root: root)
            branches = try await repository.branches().filter { !$0.isRemote }.map(\.name).sorted()
            let current = try await repository.currentBranch()
            branch = initialBranch.flatMap { branches.contains($0) ? $0 : nil }
                ?? branches.first { $0 != current } ?? branches.first ?? ""
            commandsText = ValidationSettings.suggested(for: root).commands.joined(separator: "\n")
            log = await Task.detached { BranchTestLog.load(root: root) }.value
        } catch {
            self.error = NewTerminalSheet.describe(error)
        }
    }

    private var settings: ValidationSettings {
        let trimmed = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
        return ValidationSettings(
            commands: commandsText.split(separator: "\n").map { trimmed(String($0)) }.filter { !$0.isEmpty },
            healthCheckCommand: trimmed(healthCommand).isEmpty ? nil : trimmed(healthCommand),
            healthCheckPath: trimmed(healthPath).isEmpty ? nil : trimmed(healthPath))
    }

    func run() {
        guard let root, !branch.isEmpty, !running else { return }
        let (branch, settings) = (branch, settings)
        running = true
        step = nil
        error = nil
        task = Task {
            // Git and the validation commands run off the main actor; cancelling terminates them.
            let work = Task.detached { () -> Result<BranchTestResult, Error> in
                do {
                    return .success(try await BranchTester(root: root).test(branch: branch, settings: settings) { step in
                        Task { @MainActor in self.step = step }
                    })
                } catch { return .failure(error) }
            }
            let outcome = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success(let result):
                log.record(result)
                let log = log
                try? await Task.detached { try log.save(root: root) }.value
            case .failure(let failure):
                error = NewTerminalSheet.describe(failure)
            }
            running = false
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        running = false
    }
}
