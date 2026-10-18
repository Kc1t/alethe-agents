import AletheDesign
import AletheFoundation
import SwiftUI

/// Help › Diagnostics… (replaces upstream `AuditModal`, SET-11): the warnings and errors recorded
/// this run, exported as JSON, plus the log actions.
struct DiagnosticsSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var diagnostics: DiagnosticsController { environment.diagnostics }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text("diagnostics.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                Text("diagnostics.subtitle").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                if diagnostics.recent.isEmpty {
                    Text("diagnostics.empty").foregroundStyle(theme[.fgFaint])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(160))
                        .accessibilityIdentifier("diagnostics.empty")
                } else {
                    LazyVStack(spacing: metrics.size(8)) {
                        ForEach(diagnostics.recent) { event in
                            DiagnosticEventRow(event: event).padding(metrics.size(10))
                                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        }
                    }.accessibilityIdentifier("diagnostics.list")
                }
                HStack {
                    Button("diagnostics.exportLogs") { diagnostics.exportLogs() }
                    Button("diagnostics.openFolder") { diagnostics.openLogsFolder() }
                }
            }
        } footer: {
            Button("diagnostics.clear") { diagnostics.clearRecent() }.disabled(diagnostics.recent.isEmpty)
            Button("diagnostics.exportJSON") { diagnostics.exportReport() }.disabled(diagnostics.recent.isEmpty)
            Spacer()
            Button("agentInstall.done", action: dismiss).keyboardShortcut(.defaultAction)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("diagnostics")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                Text("diagnostics.title").font(metrics.font(.title3))
                Text("diagnostics.subtitle")
                    .font(metrics.font(.body))
                    .foregroundStyle(theme[.textSecondary])
            }
            if diagnostics.recent.isEmpty {
                Text("diagnostics.empty")
                    .foregroundStyle(theme[.textTertiary])
                    .frame(maxWidth: .infinity, minHeight: metrics.size(160))
                    .accessibilityIdentifier("diagnostics.empty")
            } else {
                List(diagnostics.recent) { event in
                    DiagnosticEventRow(event: event)
                }
                .frame(minHeight: metrics.size(240))
                .accessibilityIdentifier("diagnostics.list")
            }
            HStack {
                Button("diagnostics.exportLogs") { diagnostics.exportLogs() }
                Button("diagnostics.openFolder") { diagnostics.openLogsFolder() }
                Spacer()
                Button("diagnostics.clear") { diagnostics.clearRecent() }
                    .disabled(diagnostics.recent.isEmpty)
                Button("diagnostics.exportJSON") { diagnostics.exportReport() }
                    .disabled(diagnostics.recent.isEmpty)
                Button("agentInstall.done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(640))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("diagnostics")
    }
}

private struct DiagnosticEventRow: View {
    let event: DiagnosticEvent
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: event.level.rawValue.uppercased())
                    .font(metrics.font(.caption).weight(.semibold))
                    .foregroundStyle(event.level == .warning ? theme[.statusWaiting] : theme[.statusStopped])
                Text(verbatim: event.domain.rawValue)
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textSecondary])
                Spacer()
                Text(event.date, format: .dateTime.hour().minute().second())
                    .font(metrics.font(.caption).monospacedDigit())
                    .foregroundStyle(theme[.textTertiary])
            }
            Text(verbatim: event.message)
                .font(metrics.font(.body))
                .textSelection(.enabled)
                .lineLimit(4)
        }
        .padding(.vertical, metrics.space(.xxs))
    }
}

/// Shown at launch after a run that did not exit cleanly (upstream `crash_watch.rs`
/// `get_last_crash_report`): the crash records to view or save. Nothing is sent anywhere.
struct CrashNoticeSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var diagnostics: DiagnosticsController { environment.diagnostics }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text("crash.title")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
            if let notice = diagnostics.crashNotice {
                Text(String(format: String(localized: "crash.message"), notice.previous.appVersion,
                            notice.previous.startedAt.formatted(date: .abbreviated, time: .shortened)))
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                if notice.artifacts.isEmpty {
                    Text("crash.noReports")
                        .foregroundStyle(theme[.textTertiary])
                        .accessibilityIdentifier("crash.noReports")
                } else {
                    VStack(alignment: .leading, spacing: metrics.space(.s)) {
                        ForEach(notice.artifacts) { artifact in
                            row(artifact)
                        }
                    }
                }
                Text("crash.privacy")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textTertiary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            }
        } footer: {
            Button("diagnostics.exportLogs") { diagnostics.exportLogs() }
            Spacer()
            Button("crash.dismiss") { diagnostics.dismissCrashNotice(); dismiss() }
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("crash.dismiss")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("crashNotice")
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            Text("crash.title").font(metrics.font(.title3))
            if let notice = diagnostics.crashNotice {
                Text(String(format: String(localized: "crash.message"), notice.previous.appVersion,
                            notice.previous.startedAt.formatted(date: .abbreviated, time: .shortened)))
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
                if notice.artifacts.isEmpty {
                    Text("crash.noReports")
                        .foregroundStyle(theme[.textTertiary])
                        .accessibilityIdentifier("crash.noReports")
                } else {
                    VStack(alignment: .leading, spacing: metrics.space(.s)) {
                        ForEach(notice.artifacts) { artifact in
                            row(artifact)
                        }
                    }
                }
                Text("crash.privacy")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textTertiary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("diagnostics.exportLogs") { diagnostics.exportLogs() }
                Spacer()
                Button("crash.dismiss") {
                    diagnostics.dismissCrashNotice()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("crash.dismiss")
            }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(520))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("crashNotice")
    }

    private func row(_ artifact: CrashArtifact) -> some View {
        HStack(spacing: metrics.space(.s)) {
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                Text(artifact.kind == .systemReport ? "crash.kind.system" : "crash.kind.metricKit")
                Text(verbatim: "\(artifact.url.lastPathComponent) · \(artifact.date.formatted(date: .abbreviated, time: .shortened))")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textSecondary])
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button("crash.view") { diagnostics.view(artifact) }
            Button("crash.export") { diagnostics.export(artifact) }
        }
    }
}
