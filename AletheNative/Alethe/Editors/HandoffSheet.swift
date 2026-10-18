import AletheAgents
import AletheDesign
import AletheFoundation
import AletheModel
import SwiftUI

/// Continue a Claude Code conversation in Codex or the other way round (upstream `HandoffModal`):
/// the capsule is prepared, shown for review and editing, then written to the profile and handed to a
/// new terminal of the other agent in the same project, whose first prompt tells it to read it.
struct HandoffSheet: View {
    let workspace: WorkspaceModel
    let undoManager: UndoManager?
    let tabID: TabID
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var draft: Handoff.Draft?
    @State private var failure: Handoff.Failure?
    @State private var content = ""
    @State private var unrestricted = false
    @State private var error: String? { didSet { if error != oldValue { AppLog.shown(error, .agents) } } }

    private var source: (project: Project, tab: PaneTab)? {
        guard let (project, pane) = workspace.document.paneHolding(tabID),
              let tab = pane.tabs.first(where: { $0.id == tabID }) else { return nil }
        return (project, tab)
    }

    private var target: AgentKind? { source.flatMap { Handoff.counterpart(of: AgentKind(rawValue: $0.tab.agent)) } }
    private var byteCount: Int { content.utf8.count }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            if let source, let target {
                Text(verbatim: String(format: String(localized: "handoff.title"),
                    AgentLabels.name(for: source.tab.agent), AgentLabels.name(for: target.rawValue)))
            } else { Text("menu.terminal.handoff") }
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
            if let draft {
                HStack(spacing: metrics.space(.l)) {
                    Text(String(format: String(localized: "handoff.included"), draft.includedEvents))
                    if draft.omittedEvents > 0 { Text(String(format: String(localized: "handoff.omitted"), draft.omittedEvents)) }
                    if draft.redactions > 0 {
                        Text(String(format: String(localized: "handoff.redacted"), draft.redactions))
                            .foregroundStyle(theme[.statusWaiting])
                    }
                    Spacer()
                    Text(verbatim: "\(byteCount.formatted()) / \(Handoff.materializedByteLimit.formatted())")
                        .monospacedDigit()
                        .foregroundStyle(byteCount > Handoff.materializedByteLimit ? theme[.statusStopped] : theme[.textTertiary])
                }
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                if draft.usedNewest {
                    Text("handoff.usedNewest").font(metrics.font(.footnote)).foregroundStyle(theme[.statusWaiting])
                }
                Text("handoff.review").font(metrics.font(.footnote).weight(.semibold))
                TextEditor(text: $content)
                    .font(.system(size: metrics.size(11), design: .monospaced))
                    .frame(height: metrics.size(300))
                    .scrollContentBackground(.hidden)
                    .padding(metrics.space(.xs))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .accessibilityIdentifier("handoff.content")
                Text("handoff.privacy").font(metrics.font(.caption)).foregroundStyle(theme[.textTertiary])
                if let target, AgentRegistry.builtin.descriptor(for: target)?.unrestrictedFlag != nil {
                    Toggle(String(format: String(localized: "handoff.unrestricted"), AgentLabels.name(for: target.rawValue)),
                           isOn: $unrestricted)
                }
            } else if let failure {
                Text(failure.message).foregroundStyle(theme[.textSecondary]).accessibilityIdentifier("handoff.failure")
            } else {
                HStack { ProgressView().controlSize(.small); Text("handoff.preparing") }
            }
            if let error { Text(verbatim: error).foregroundStyle(theme[.statusStopped]).font(metrics.font(.footnote)) }
            }
        } footer: {
            HStack {
                Spacer()
                Button("editor.cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if let target {
                    Button(String(format: String(localized: "handoff.continue"), AgentLabels.name(for: target.rawValue))) { start() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(draft == nil || content.trimmingCharacters(in: .whitespaces).isEmpty
                                  || byteCount > Handoff.materializedByteLimit)
                        .accessibilityIdentifier("handoff.continue")
                }
            }
        }
        .task { await prepare() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("handoff")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            if let source, let target {
                Text(verbatim: String(format: String(localized: "handoff.title"),
                                      AgentLabels.name(for: source.tab.agent), AgentLabels.name(for: target.rawValue)))
                    .font(metrics.font(.title3))
            }
            if let draft {
                HStack(spacing: metrics.space(.l)) {
                    Text(String(format: String(localized: "handoff.included"), draft.includedEvents))
                    if draft.omittedEvents > 0 { Text(String(format: String(localized: "handoff.omitted"), draft.omittedEvents)) }
                    if draft.redactions > 0 {
                        Text(String(format: String(localized: "handoff.redacted"), draft.redactions))
                            .foregroundStyle(theme[.statusWaiting])
                    }
                    Spacer()
                    Text(verbatim: "\(byteCount.formatted()) / \(Handoff.materializedByteLimit.formatted())")
                        .monospacedDigit()
                        .foregroundStyle(byteCount > Handoff.materializedByteLimit ? theme[.statusStopped] : theme[.textTertiary])
                }
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                if draft.usedNewest {
                    Text("handoff.usedNewest").font(metrics.font(.footnote)).foregroundStyle(theme[.statusWaiting])
                }
                Text("handoff.review").font(metrics.font(.footnote).weight(.semibold))
                TextEditor(text: $content)
                    .font(.system(size: metrics.size(11), design: .monospaced))
                    .frame(height: metrics.size(300))
                    .scrollContentBackground(.hidden)
                    .padding(metrics.space(.xs))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .accessibilityIdentifier("handoff.content")
                Text("handoff.privacy").font(metrics.font(.caption)).foregroundStyle(theme[.textTertiary])
                if let target, AgentRegistry.builtin.descriptor(for: target)?.unrestrictedFlag != nil {
                    Toggle(String(format: String(localized: "handoff.unrestricted"), AgentLabels.name(for: target.rawValue)),
                           isOn: $unrestricted)
                }
            } else if let failure {
                Text(failure.message).foregroundStyle(theme[.textSecondary]).accessibilityIdentifier("handoff.failure")
            } else {
                HStack { ProgressView().controlSize(.small); Text("handoff.preparing") }
            }
            if let error { Text(verbatim: error).foregroundStyle(theme[.statusStopped]).font(metrics.font(.footnote)) }
            HStack {
                Spacer()
                Button("editor.cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if let target {
                    Button(String(format: String(localized: "handoff.continue"), AgentLabels.name(for: target.rawValue))) { start() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(draft == nil || content.trimmingCharacters(in: .whitespaces).isEmpty
                                  || byteCount > Handoff.materializedByteLimit)
                        .accessibilityIdentifier("handoff.continue")
                }
            }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(640))
        .task { await prepare() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("handoff")
    }

    private func prepare() async {
        guard let source, let target else { failure = .unsupported; return }
        unrestricted = source.tab.unrestricted || (environment.preferences?.document.alwaysStartUnrestricted ?? false)
        let kind = AgentKind(rawValue: source.tab.agent), session = source.tab.sessionID
        let cwd = source.tab.workingDirectory ?? source.project.folder
        switch await Task.detached(operation: { Handoff.prepare(source: kind, target: target, sessionID: session, cwd: cwd) }).value {
        case .success(let prepared):
            draft = prepared
            content = prepared.content
        case .failure(let reason):
            failure = reason
        }
    }

    private func start() {
        guard let draft, let source, let locations = environment.locations,
              let profile = environment.profileID else { return }
        do {
            let file = try Handoff.materialize(content, in: locations.handoffs(profile))
            let flag = AgentRegistry.builtin.descriptor(for: draft.target)?.unrestrictedFlag
            let tab = PaneTab(agent: draft.target.rawValue,
                              title: String(format: String(localized: "handoff.paneName"), AgentLabels.name(for: draft.target.rawValue)),
                              workingDirectory: draft.cwd == source.project.folder ? nil : draft.cwd,
                              unrestricted: unrestricted && flag != nil,
                              initialPrompt: String(format: String(localized: "handoff.bootstrapPrompt"), file.path))
            workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newTerminal")) {
                $0.addPane(to: source.project.id, tab: tab)
            }
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

extension Handoff.Failure {
    var message: LocalizedStringKey {
        switch self {
        case .unsupported, .sameAgent: "handoff.unsupported"
        case .noFolder: "handoff.noFolder"
        case .noSession: "handoff.noSession"
        case .noUserMessages: "handoff.noUserMessages"
        }
    }
}
