import AletheAgents
import AletheDesign
import AletheMerge
import SwiftUI

extension MergeCenterSheet {
    var webContent: some View {
        GitWebModal(close: closeWeb, closeIdentifier: "merge.close") {
            AgentLogo(agent: agent.rawValue, size: 16)
                .frame(width: metrics.size(16), height: metrics.size(16)).clipped()
            Text(verbatim: "\(AgentLabels.name(for: agent.rawValue)) (\(project?.name ?? "—"))")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                if let model {
                    Text(stageTitle(model.stage))
                        .font(metrics.font(size: 10, weight: .semibold))
                        .foregroundStyle(theme[.statusWaiting])
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                        .background(theme[.statusWaitingSoft], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.size(4))
                            .strokeBorder(theme[.statusWaiting], lineWidth: metrics.size(1)))
                        .accessibilityIdentifier("merge.stages")
                    if let error = model.error {
                        Text(verbatim: error).font(metrics.font(size: 12)).foregroundStyle(theme[.statusOffline])
                            .textSelection(.enabled).accessibilityIdentifier("merge.error")
                    }
                    if model.loading {
                        ProgressView().frame(maxWidth: .infinity).padding(metrics.size(18))
                    } else {
                        webStage(model)
                    }
                } else {
                    Text("merge.noProject").foregroundStyle(theme[.fgMuted])
                }
            }
        } footer: { EmptyView() }
        .frame(width: closeOverlay == nil ? metrics.size(480) : nil)
        .task { await loadModel() }
        .onDisappear { model?.cancel() }
        .webConfirm(isPresented: $confirmAbort, message: String(localized: "merge.abort.confirm"),
                    confirmTitle: String(localized: "merge.abort"), destructive: true) { model?.abort() }
        .webConfirm(isPresented: $confirmCleanup, message: String(localized: "merge.cleanup.confirm"),
                    confirmTitle: String(localized: "merge.cleanup"), destructive: true) { model?.forceCleanup() }
        .confirmationDialog("merge.abort.confirm", isPresented: Binding(get: { !metrics.isWebInterface && confirmAbort }, set: { confirmAbort = $0 })) {
            Button("merge.abort", role: .destructive) { model?.abort() }
        }
        .confirmationDialog("merge.cleanup.confirm", isPresented: Binding(get: { !metrics.isWebInterface && confirmCleanup }, set: { confirmCleanup = $0 })) {
            Button("merge.cleanup", role: .destructive) { model?.forceCleanup() }
        }
        .gitWebSheet(isPresented: $testingBranch, width: 560) {
            BranchTestingSheet(folder: model?.folder, initialBranch: model?.source)
        }
        .accessibilityIdentifier("merge.center")
    }

    @ViewBuilder
    func webStage(_ model: MergeCenterModel) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(6)) {
            Group {
            if model.stage == .analyze {
                ProjectGroupWebField(title: "merge.source") {
                    WebDropdown(selection: Bindable(model).source, options: model.branches) { Text(verbatim: $0) }
                        .accessibilityIdentifier("merge.source")
                }
                ProjectGroupWebField(title: "merge.target") {
                    WebDropdown(selection: Bindable(model).target, options: model.branches) { Text(verbatim: $0) }
                        .accessibilityIdentifier("merge.target")
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: metrics.size(6)), count: 3), spacing: metrics.size(6)) {
                    Button("merge.prepare") { model.prepare() }.disabled(model.analysis == nil || model.running)
                        .accessibilityIdentifier("merge.prepare")
                        .buttonStyle(AletheGitMergeActionStyle(foreground: .statusWorking, background: .statusWorkingSoft, border: .statusWorking))
                    Button("merge.abort", role: .destructive) { confirmAbort = true }.disabled(model.environment == nil)
                        .accessibilityIdentifier("merge.abort")
                        .buttonStyle(AletheGitMergeActionStyle(foreground: .statusOffline, background: .statusOfflineSoft, border: .statusOffline))
                    Button("merge.analyze") { model.analyze() }.disabled(!model.canAnalyze || model.running)
                        .keyboardShortcut(.defaultAction).accessibilityIdentifier("merge.analyze")
                }
                HStack(spacing: metrics.size(6)) {
                    Button { testingBranch = true } label: {
                        Label("menu.merge.branchTesting", systemImage: "play")
                    }
                    .disabled(model.source.isEmpty || model.running).accessibilityIdentifier("merge.testBranch")
                    .buttonStyle(AletheGitMergeActionStyle(foreground: .statusWaiting, background: .statusWaitingSoft, border: .statusWaiting))
                }
                if let analysis = model.analysis {
                    if analysis.clean {
                        Label("merge.clean", systemImage: "checkmark.circle")
                            .foregroundStyle(theme[.statusWorking]).accessibilityIdentifier("merge.clean")
                    } else {
                        webConflicts(analysis.conflicts)
                    }
                }
            } else if model.stage == .prepare {
                NewTerminalRowSelect(selection: $agent, options: agents,
                                     title: { AgentLabels.name(for: $0.rawValue) }) { kind in
                    AgentLogo(agent: kind.rawValue, size: 16)
                }
                .accessibilityIdentifier("merge.agent")
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: metrics.size(6)), count: 2), spacing: metrics.size(6)) {
                    Button("merge.resolveWithAgent") { resolveWithAgent(model) }
                        .disabled(model.environment == nil || !agents.contains(agent)).accessibilityIdentifier("merge.resolveWithAgent")
                    Button("merge.refresh") { model.refreshConflicts() }
                    Button("merge.rebase") { model.rebase() }.accessibilityIdentifier("merge.rebase")
                    Button("merge.continue") { model.stage = .validate }.disabled(!model.conflicts.isEmpty)
                        .accessibilityIdentifier("merge.continue")
                    abortButton(model)
                }
                webConflicts(model.conflicts)
            } else if model.stage == .validate {
                ProjectGroupWebField(title: "merge.validate.commands") {
                    TextEditor(text: Bindable(model).commandsText)
                        .font(metrics.monoFont(size: 12, weight: .regular))
                        .scrollContentBackground(.hidden).frame(height: metrics.size(90))
                        .modifier(GitWebEditor()).accessibilityIdentifier("merge.validate.commands")
                }
                HStack(spacing: metrics.size(6)) {
                    Button("merge.validate.run") { model.validate() }.keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("merge.validate.run")
                    Button("merge.continue") { model.stage = .finish }.accessibilityIdentifier("merge.continue")
                    abortButton(model)
                }
                webOutcome(model)
            } else {
                HStack(spacing: metrics.size(6)) {
                    Button("merge.finalize") { model.finalize() }.keyboardShortcut(.defaultAction)
                        .disabled(model.environment == nil).accessibilityIdentifier("merge.finalize")
                    abortButton(model)
                    Button("merge.cleanup", role: .destructive) { confirmCleanup = true }
                        .disabled(model.environment == nil).accessibilityIdentifier("merge.cleanup")
                }
                if model.merged {
                    Label("merge.merged", systemImage: "checkmark.circle").foregroundStyle(theme[.statusWorking])
                }
                webOutcome(model)
            }
            }
            .disabled(model.running)
            if model.running {
                HStack(spacing: metrics.size(6)) {
                    ProgressView().controlSize(.small)
                    Text("merge.working").foregroundStyle(theme[.fgMuted])
                    Button("merge.cancel") { model.cancel() }.accessibilityIdentifier("merge.cancel")
                }
            }
        }
        .font(metrics.font(size: 12))
        .buttonStyle(AletheGitMergeActionStyle())
    }

    func webConflicts(_ conflicts: [ConflictFile]) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(6)) {
            ForEach(conflicts, id: \.path) { conflict in
                VStack(alignment: .leading, spacing: metrics.size(4)) {
                    Text(verbatim: conflict.path).font(metrics.monoFont(size: 11, weight: .regular))
                    Text(verbatim: conflict.class.variantName).foregroundStyle(theme[.accent])
                    Text(verbatim: conflict.class.strategy).foregroundStyle(theme[.fgMuted])
                }
                .padding(metrics.size(8)).frame(maxWidth: .infinity, alignment: .leading)
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            }
        }
        .accessibilityIdentifier("merge.conflictList")
    }

    @ViewBuilder
    func webOutcome(_ model: MergeCenterModel) -> some View {
        if let note = model.note {
            Text(verbatim: note).font(metrics.monoFont(size: 12, weight: .regular))
                .foregroundStyle(theme[.fgMuted]).textSelection(.enabled).accessibilityIdentifier("merge.output")
        }
        if let outcome = model.outcome {
            ValidationStepsView(steps: outcome.validation?.steps ?? [])
            if let probe = outcome.validation?.healthProbe { HealthProbeSummaryView(result: probe) }
            if let warnings = outcome.contractWarnings { ContractWarningsView(warnings: warnings) }
        }
    }

    func closeWeb() { if let closeOverlay { closeOverlay() } else { dismiss() } }
}
