import AletheDesign
import AletheIntegrations
import SwiftUI

/// Which child session the activity sheet reads.
struct GSDSyncActivityTarget: Hashable {
    /// The checkout `opencode export` runs in.
    var directory: URL
    var sessionID: String
    var title: String

    init(_ session: GSDSyncSession) {
        directory = session.root
        sessionID = session.childID
        title = session.name
    }
}

/// The GSD Sync child session's activity, read-only (upstream `GsdSyncActivityView`): `opencode export`
/// every 5 s, user instructions collapsed, the agent's text, reasoning and tool parts expanded; the
/// feed follows new output while the reader is at the bottom.
struct GSDSyncActivitySheet: View {
    let target: GSDSyncActivityTarget
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var session: OpenCodeExportSession?
    @State private var failure: String?
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var atBottom = true

    /// How close to the end still counts as reading the latest (upstream 80 px).
    private static let stickThreshold: CGFloat = 80

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    @Environment(\.newTerminalModalHeight) private var maximumHeight

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text(verbatim: target.title).lineLimit(1)
        } content: {
            feed.frame(height: max(metrics.size(120), min(metrics.size(400), maximumHeight - metrics.size(140))))
        } footer: {
            Spacer()
            Button("agentInstall.done", action: dismiss).accessibilityIdentifier("gsdActivity.done")
        }
        .task(id: target) { await poll() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gsdActivity.sheet")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            feed
        }
        .frame(width: metrics.size(640), height: metrics.size(520))
        .background(theme[.bg])
        .task(id: target) { await poll() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gsdActivity.sheet")
    }

    private var header: some View {
        HStack(spacing: metrics.space(.m)) {
            Label {
                Text(verbatim: target.title).font(metrics.font(.headline)).lineLimit(1)
            } icon: {
                Image(systemName: "sparkles").foregroundStyle(theme[.agentOpencode])
            }
            Spacer()
            if let model = session?.modelID {
                Text(verbatim: model)
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
            }
            if let tokens = session?.totalTokens {
                Text(verbatim: format("gsdActivity.tokens", tokens))
                    .font(metrics.font(.footnote).monospacedDigit())
                    .foregroundStyle(theme[.textSecondary])
            }
            Button("agentInstall.done") { dismiss() }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("gsdActivity.done")
        }
        .padding(metrics.space(.l))
    }

    @ViewBuilder
    private var feed: some View {
        if let session {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: metrics.space(.l)) {
                    if let failure { failureText(failure) }
                    ForEach(session.messages) { message in
                        GSDActivityMessage(message: message)
                    }
                }
                .padding(metrics.space(.l))
            }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < Self.stickThreshold
            } action: { _, isAtBottom in
                atBottom = isAtBottom
            }
            .accessibilityIdentifier("gsdActivity.feed")
        } else if let failure {
            failureText(failure)
                .padding(metrics.space(.l))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            HStack(spacing: metrics.space(.s)) {
                ProgressView().controlSize(.small)
                Text("gsdActivity.loading").foregroundStyle(theme[.textSecondary])
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("gsdActivity.loading")
        }
    }

    private func failureText(_ message: String) -> some View {
        Text(verbatim: message)
            .font(metrics.font(.body))
            .foregroundStyle(theme[.statusStopped])
            .textSelection(.enabled)
            .accessibilityIdentifier("gsdActivity.error")
    }

    /// Exports until the sheet closes (the task is cancelled with it).
    private func poll() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: GSDSyncController.pollInterval)
        }
    }

    private func load() async {
        guard let service = environment.gsdSync.service else { return }
        guard let executable = environment.gsdSync.openCodeExecutable else {
            failure = String(localized: "gsdActivity.openCodeMissing")
            return
        }
        do {
            let next = try await service.export(sessionID: target.sessionID, at: target.directory,
                                                openCode: URL(filePath: executable))
            guard !Task.isCancelled else { return }
            failure = nil
            guard next != session else { return }
            let follow = atBottom
            session = next
            if follow { position.scrollTo(edge: .bottom) }
        } catch {
            guard !Task.isCancelled else { return }
            failure = Self.message(for: error)
        }
    }

    private static func message(for error: OpenCodeExportError) -> String {
        switch error {
        case .invalidSessionID: String(localized: "gsdActivity.invalidSession")
        case .notJSON: String(localized: "gsdActivity.unreadable")
        case .failed(_, let stderr):
            stderr.isEmpty ? String(localized: "gsdActivity.failed") : format("gsdActivity.failedDetail", stderr)
        case .command(let error): format("gsdActivity.failedDetail", String(describing: error))
        }
    }
}

/// One exported message: an instruction sent to the agent collapsed (typically a long repeated
/// preamble), the agent's reply expanded with an accent rail.
private struct GSDActivityMessage: View {
    let message: OpenCodeExportMessage
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var expanded = false

    var body: some View {
        switch message.role {
        case .user:
            DisclosureGroup(isExpanded: $expanded) {
                parts
            } label: {
                HStack(spacing: metrics.space(.xs)) {
                    Label("gsdActivity.roleUser", systemImage: "person")
                        .font(metrics.font(.footnote).weight(.semibold))
                    Text("gsdActivity.instructionHint")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textTertiary])
                }
                .foregroundStyle(theme[.textSecondary])
            }
            .accessibilityIdentifier("gsdActivity.instruction")
        case .assistant:
            VStack(alignment: .leading, spacing: metrics.space(.s)) {
                Label("gsdActivity.roleAssistant", systemImage: "sparkles")
                    .font(metrics.font(.footnote).weight(.semibold))
                    .foregroundStyle(theme[.agentOpencode])
                parts
            }
            .padding(.leading, metrics.space(.m))
            .overlay(alignment: .leading) {
                Rectangle().fill(theme[.agentOpencodeSoft]).frame(width: metrics.size(2))
            }
            .accessibilityIdentifier("gsdActivity.agent")
        }
    }

    private var parts: some View {
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                GSDActivityPart(part: part)
            }
        }
    }
}

private struct GSDActivityPart: View {
    let part: OpenCodeExportPart
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        switch part {
        case .text(let text):
            if let text = trimmed(text) {
                Text(verbatim: text).font(metrics.font(.body)).textSelection(.enabled)
            }
        case .reasoning(let text):
            if let text = trimmed(text) {
                Text(verbatim: text)
                    .font(metrics.font(.body).italic())
                    .foregroundStyle(theme[.textSecondary])
                    .textSelection(.enabled)
            }
        case .tool(let name, let status, let input, let output):
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                HStack(spacing: metrics.space(.xs)) {
                    Image(systemName: "wrench.and.screwdriver")
                    Text(verbatim: name).font(metrics.font(.footnote).weight(.semibold))
                    Text(verbatim: status).foregroundStyle(theme[.textTertiary])
                }
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                if let input, !input.isEmpty {
                    Text(verbatim: input)
                        .font(metrics.monoFont(size: metrics.size(11)))
                        .textSelection(.enabled)
                }
                if let output, !output.isEmpty {
                    Text(verbatim: output)
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textSecondary])
                        .lineLimit(12)
                        .textSelection(.enabled)
                }
            }
            .padding(metrics.space(.m))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).stroke(theme[.borderSubtle]))
            .accessibilityIdentifier("gsdActivity.tool")
        case .patch:
            Text("gsdActivity.patchApplied")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
        case .other:
            // step-start/step-finish and future types are not shown (upstream ignores them too).
            EmptyView()
        }
    }

    private func trimmed(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
