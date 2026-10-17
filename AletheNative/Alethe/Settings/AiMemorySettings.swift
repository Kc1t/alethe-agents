import AletheDesign
import AletheIntegrations
import AppKit
import SwiftUI

/// Settings › Features › AI Memory (P5-18): the CLI found (or chosen), its version, whether its
/// server answers, and a link to its documentation.
struct AiMemoryOptions: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var controller: AiMemoryController { environment.aiMemory }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: controller.executable
                     ?? String(format: String(localized: "settings.agents.notFound"), AiMemory.defaultCommand))
                    .font(metrics.isWebInterface ? metrics.monoFont(size: 10, weight: .regular) : .footnote.monospaced())
                    .foregroundStyle(controller.executable == nil ? theme[.statusStopped] : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer()
                if controller.override != nil {
                    Text("settings.agents.custom")
                        .font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote)
                        .foregroundStyle(.secondary)
                    Button("settings.agents.reset") { controller.setOverride(nil) }
                        .accessibilityIdentifier("settings.aiMemory.reset")
                }
                Button("settings.agents.choose") { choose() }
                    .accessibilityIdentifier("settings.aiMemory.choose")
            }
            HStack(spacing: metrics.space(.s)) {
                statusText
                Spacer()
                Button("settings.aiMemory.checkAgain") { controller.refresh() }
                    .disabled(controller.isDetecting)
                    .accessibilityIdentifier("settings.aiMemory.checkAgain")
                Link(destination: AiMemory.documentation) {
                    Text("settings.aiMemory.documentation")
                }
                .accessibilityIdentifier("settings.aiMemory.documentation")
            }
            Text("settings.aiMemory.wiring")
                .font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("settings.aiMemory")
        .task(id: controller.executable) {
            if controller.status?.executable != controller.executable || controller.status == nil {
                controller.refresh()
            }
        }
    }

    @ViewBuilder
    private var statusText: some View {
        Group {
            if controller.isDetecting && controller.status == nil {
                HStack(spacing: metrics.space(.xs)) {
                    ProgressView().controlSize(.mini)
                    Text("settings.aiMemory.checking")
                }
            } else if let status = controller.status {
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    if status.installed {
                        Text(verbatim: status.version.map { format("settings.aiMemory.installed", $0) }
                             ?? String(localized: "settings.aiMemory.installedNoVersion"))
                    } else if status.executable != nil {
                        Text("settings.aiMemory.broken")
                            .foregroundStyle(theme[.statusStopped])
                    } else {
                        Text("settings.aiMemory.notInstalled")
                            .foregroundStyle(theme[.statusStopped])
                    }
                    Text(verbatim: format(status.running ? "settings.aiMemory.running" : "settings.aiMemory.notRunning",
                                          AiMemory.endpoint))
                        .foregroundStyle(status.running ? theme[.statusActive] : .secondary)
                }
            }
        }
        .font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote)
        .accessibilityIdentifier("settings.aiMemory.status")
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = true
        panel.message = format("terminal.chooseCLI.message", AiMemory.defaultCommand)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        controller.setOverride(url.path)
    }
}
