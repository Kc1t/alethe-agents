import AletheDesign
import AletheFoundation
import AppKit
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

    @State private var search = ""
    @State private var errorsOnly = false
    @State private var copied = false

    private var filteredEvents: [DiagnosticEvent] {
        diagnostics.recent.filter { event in
            (!errorsOnly || event.level != .warning)
                && (search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || (event.message + " " + event.domain.rawValue).localizedCaseInsensitiveContains(search))
        }
    }

    private func copyReport() {
        guard let data = try? DiagnosticsReport(context: .current(), events: diagnostics.recent).json(),
              let report = String(data: data, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        copied = NSPasteboard.general.setString(report, forType: .string)
    }

    private var diagnostics: DiagnosticsController { environment.diagnostics }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(8)) {
                Image(systemName: "exclamationmark.shield").webProfileSized(16)
                    .foregroundStyle(theme[.statusStopped])
                Text("diagnostics.title").font(metrics.font(size: 14, weight: .semibold))
                Spacer(minLength: 0)
                Button(action: dismiss) { Image(systemName: "xmark").webProfileSized(14) }
                    .accessibilityLabel(Text("settings.web.close"))
            }
            .padding(.horizontal, metrics.size(16)).padding(.vertical, metrics.size(12))
            .background(theme[.panel])
            HStack(spacing: metrics.size(8)) {
                TextField("diagnostics.search", text: $search)
                    .textFieldStyle(.plain).font(metrics.font(size: 12))
                    .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(4))
                    .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.size(4)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    .accessibilityIdentifier("diagnostics.search")
                Button { errorsOnly = false } label: {
                    Text(verbatim: String(format: String(localized: "diagnostics.all"), diagnostics.recent.count))
                }.tint(theme[errorsOnly ? .fgMuted : .accent])
                Button { errorsOnly = true } label: {
                    Text(verbatim: String(format: String(localized: "diagnostics.errors"), diagnostics.recent.filter { $0.level != .warning }.count))
                }.tint(theme[errorsOnly ? .accent : .fgMuted])
                Button(action: copyReport) {
                    Label(copied ? "diagnostics.copied" : "diagnostics.copy", systemImage: "doc.on.doc")
                }.accessibilityIdentifier("diagnostics.copy")
                Button("diagnostics.exportJSON") { diagnostics.exportReport() }
                Button { diagnostics.clearRecent() } label: { Image(systemName: "trash").webProfileSized(12) }
                    .accessibilityLabel(Text("diagnostics.clear"))
            }
            .font(metrics.font(size: 11))
            .padding(.horizontal, metrics.size(16)).padding(.vertical, metrics.size(8))
            .background(theme[.panel])
            .overlay(alignment: .top) { theme[.border].frame(height: metrics.size(1)) }
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            ScrollView {
                if filteredEvents.isEmpty {
                    Text("diagnostics.empty").foregroundStyle(theme[.fgFaint])
                        .padding(.top, metrics.size(24)).frame(maxWidth: .infinity)
                        .accessibilityIdentifier("diagnostics.empty")
                } else {
                    LazyVStack(spacing: metrics.size(6)) {
                        ForEach(filteredEvents) { event in
                            VStack(alignment: .leading, spacing: metrics.size(4)) {
                                HStack(spacing: metrics.size(8)) {
                                    Text(verbatim: "[" + event.domain.rawValue + "]")
                                        .font(metrics.monoFont(size: 9, weight: .bold))
                                        .padding(.horizontal, metrics.size(5)).padding(.vertical, metrics.size(1))
                                        .background(theme[.border], in: RoundedRectangle(cornerRadius: metrics.size(3)))
                                    Text(verbatim: event.date.formatted(.iso8601)).foregroundStyle(theme[.fgFaint])
                                }
                                Text(verbatim: event.message).textSelection(.enabled)
                            }
                            .font(metrics.monoFont(size: 11))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, metrics.size(6)).padding(.horizontal, metrics.size(10))
                            .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(4)))
                            .overlay(alignment: .leading) {
                                theme[event.level == .warning ? .statusWaiting : .statusStopped].frame(width: metrics.size(3))
                            }
                            .clipShape(RoundedRectangle(cornerRadius: metrics.size(4)))
                        }
                    }.accessibilityIdentifier("diagnostics.list")
                }
            }
            .padding(.horizontal, metrics.size(16)).padding(.vertical, metrics.size(8))
        }
        .buttonStyle(AletheButtonStyle(size: .small))
        .foregroundStyle(theme[.fg]).background(theme[.bg])
        .frame(width: metrics.size(900), height: metrics.size(620))
        .clipShape(RoundedRectangle(cornerRadius: metrics.size(8)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(8)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .onChange(of: diagnostics.recent) { _, _ in copied = false }
        .accessibilityElement(children: .contain).accessibilityIdentifier("diagnostics")
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
