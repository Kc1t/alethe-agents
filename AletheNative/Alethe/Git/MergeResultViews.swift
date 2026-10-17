import AletheDesign
import AletheMerge
import SwiftUI

/// Validation commands of a run: status per command, exit code, duration and expandable output.
struct ValidationStepsView: View {
    let steps: [ValidationStepResult]
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if !steps.isEmpty {
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                Text("mergeResult.steps.title").font(metrics.isWebInterface ? metrics.font(size: 12, weight: .semibold) : .headline)
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    DisclosureGroup {
                        ScrollView {
                            Text(verbatim: step.output)
                                .font(metrics.isWebInterface ? metrics.monoFont(size: 11, weight: .regular) : .caption.monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: metrics.size(140))
                    } label: {
                        HStack(spacing: metrics.space(.s)) {
                            Image(systemName: step.succeeded ? "checkmark.circle.fill" : "xmark.octagon.fill")
                                .foregroundStyle(theme[step.succeeded ? .statusActive : .statusStopped])
                            Text(verbatim: step.command).font(metrics.isWebInterface ? metrics.monoFont(size: 12, weight: .regular) : .body.monospaced()).lineLimit(1)
                            Spacer()
                            Text(verbatim: String(format: String(localized: "mergeResult.step.exit"),
                                                  Int(step.exitCode), step.durationMs))
                                .font(metrics.isWebInterface ? metrics.font(size: 11) : .caption)
                                .foregroundStyle(theme[.textSecondary])
                        }
                    }
                }
            }
            .accessibilityIdentifier("mergeResult.steps")
        }
    }
}

/// The health probe line: a warning signal only, never a blocker.
struct HealthProbeSummaryView: View {
    @Environment(\.metrics) private var metrics
    let result: HealthProbeResult
    @Environment(\.theme) private var theme

    var body: some View {
        Label {
            VStack(alignment: .leading) {
                Text("mergeResult.probe.title").font(metrics.isWebInterface ? metrics.font(size: 12, weight: .semibold) : .headline)
                if let status = result.statusCode, result.responded {
                    Text(verbatim: String(format: String(localized: "mergeResult.probe.status"), status, result.elapsedMs))
                } else {
                    Text("mergeResult.probe.noResponse")
                }
            }
        } icon: {
            Image(systemName: result.healthy ? "heart.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(theme[result.healthy ? .statusActive : .statusWaiting])
        }
        .accessibilityIdentifier("mergeResult.probe")
    }
}

/// API contract check result (upstream shield layer 3): calls without a matching backend route.
struct ContractWarningsView: View {
    let warnings: [ContractWarning]
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Text("mergeResult.contract.title").font(metrics.isWebInterface ? metrics.font(size: 12, weight: .semibold) : .headline)
            if warnings.isEmpty {
                Label("mergeResult.contract.ok", systemImage: "checkmark.circle")
                    .foregroundStyle(theme[.textSecondary])
            } else {
                ForEach(warnings, id: \.self) { warning in
                    Label {
                        VStack(alignment: .leading) {
                            Text(verbatim: String(format: String(localized: "mergeResult.contract.missing"),
                                                  warning.call.pathPattern))
                            Text(verbatim: "\(warning.call.file):\(warning.call.line)")
                                .font(metrics.isWebInterface ? metrics.monoFont(size: 11, weight: .regular) : .caption.monospaced())
                                .foregroundStyle(theme[.textSecondary])
                                .textSelection(.enabled)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(theme[.statusWaiting])
                    }
                }
            }
        }
        .accessibilityIdentifier("mergeResult.contract")
    }
}
