import AletheAgents
import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// Settings › Agents (upstream Preferences › Terminal: enabled agents and CLI paths): each agent can
/// be turned off (it leaves New Terminal and the launcher) and shows the CLI it will run, with the
/// version it reports; Choose… points it at another CLI, Reset goes back to automatic lookup.
struct AgentSettings: View {
    @Environment(\.metrics) private var metrics
    @Environment(AppEnvironment.self) private var environment

    private var agents: [AgentDescriptor] { AgentRegistry.builtin.descriptors.filter { !$0.isShell } }

    var body: some View {
        AletheSettingsForm {
            Section {
                ForEach(agents) { agent in
                    AgentSettingsRow(agent: agent)
                }
            } footer: {
                Text("settings.agents.footer")
                    .font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct AgentSettingsRow: View {
    let agent: AgentDescriptor
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var version: String?
    @State private var latest: String?
    @State private var probing = false
    @State private var sheet: AgentInstallSheet.Mode?

    private var preferences: PreferencesDocument? { environment.preferences?.document }
    private var override: String? { preferences?.cliPaths?[agent.kind.rawValue] }
    private var path: String? {
        agent.cliCommand.flatMap { environment.launchers.resolve($0, override: override) }
    }
    private var isEnabled: Bool {
        AgentRegistry.builtin.enabledKinds(preferences?.enabledAgents).contains(agent.kind)
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Toggle(isOn: Binding(get: { isEnabled }, set: setEnabled)) {
                HStack(spacing: metrics.space(.s)) {
                    Circle()
                        .fill(theme[AgentTokens.accent(for: agent.kind.rawValue)])
                        .frame(width: metrics.size(8), height: metrics.size(8))
                    Text(verbatim: agent.displayName)
                    if let version {
                        Text(verbatim: version)
                            .font(metrics.isWebInterface ? metrics.font(size: 10).monospacedDigit() : .footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                        if let latest, AgentVersions.isOutdated(version, latest: latest) {
                            Text(verbatim: String(format: String(localized: "settings.agents.updateAvailable"), latest))
                                .font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote)
                                .foregroundStyle(theme[.statusWaiting])
                        }
                    } else if probing {
                        ProgressView().controlSize(.mini)
                    }
                }
            }
            .accessibilityIdentifier("settings.agent.\(agent.kind.rawValue)")
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: path ?? String(format: String(localized: "settings.agents.notFound"), agent.cliCommand ?? ""))
                    .font(metrics.isWebInterface ? metrics.monoFont(size: 10, weight: .regular) : .footnote.monospaced())
                    .foregroundStyle(path == nil ? theme[.statusStopped] : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer()
                if override != nil {
                    Text("settings.agents.custom")
                        .font(metrics.isWebInterface ? metrics.font(size: 10) : .footnote)
                        .foregroundStyle(.secondary)
                    Button("settings.agents.reset") { setOverride(nil) }
                        .accessibilityIdentifier("settings.agent.reset.\(agent.kind.rawValue)")
                }
                Button("settings.agents.choose") { choose() }
                    .accessibilityIdentifier("settings.agent.choose.\(agent.kind.rawValue)")
                installMenu
            }
        }
        .task(id: path) { await probe() }
        .gitWebSheet(item: $sheet, width: 480, onDismiss: { environment.launchers.invalidate(); Task { await probe() } }) { mode in
            AgentInstallSheet(agent: agent, mode: mode)
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
    }

    private var webBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Toggle(isOn: Binding(get: { isEnabled }, set: setEnabled)) {
                HStack(spacing: metrics.space(.s)) {
                    if metrics.isWebInterface {
                        AgentLogo(agent: agent.kind.rawValue, size: 20)
                            .frame(width: metrics.size(36), height: metrics.size(36))
                            .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(9)))
                    } else {
                        Circle()
                            .fill(theme[AgentTokens.accent(for: agent.kind.rawValue)])
                            .frame(width: metrics.size(8), height: metrics.size(8))
                    }
                    Text(verbatim: agent.displayName)
                    if let version {
                        Text(verbatim: version)
                            .font(metrics.font(size: 10).monospacedDigit())
                            .foregroundStyle(theme[.fgMuted])
                        if let latest, AgentVersions.isOutdated(version, latest: latest) {
                            Text(verbatim: String(format: String(localized: "settings.agents.updateAvailable"), latest))
                                .font(metrics.font(size: 10))
                                .foregroundStyle(theme[.statusWaiting])
                        }
                    } else if probing {
                        ProgressView().controlSize(.mini)
                    }
                }
            }
            .accessibilityIdentifier("settings.agent.\(agent.kind.rawValue)")
            ViewThatFits(in: .horizontal) {
                pathActions
                VStack(alignment: .leading, spacing: metrics.size(8)) {
                    pathText
                    actionButtons
                }
            }
        }
        .task(id: path) { await probe() }
        .gitWebSheet(item: $sheet, width: 480, onDismiss: { environment.launchers.invalidate(); Task { await probe() } }) { mode in
            AgentInstallSheet(agent: agent, mode: mode)
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
    }

    private var pathText: some View {
        Text(verbatim: path ?? String(format: String(localized: "settings.agents.notFound"), agent.cliCommand ?? ""))
                    .font(metrics.monoFont(size: 10, weight: .regular))
                    .foregroundStyle(path == nil ? theme[.statusStopped] : theme[.fgMuted])
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
    }

    private var pathActions: some View {
        HStack(spacing: metrics.space(.s)) {
            pathText
            Spacer()
            actionButtons.fixedSize()
        }
    }

    private var actionButtons: some View {
        HStack(spacing: metrics.space(.s)) {
            if override != nil {
                Text("settings.agents.custom")
                    .font(metrics.font(size: 10))
                    .foregroundStyle(theme[.fgMuted])
                Button("settings.agents.reset") { setOverride(nil) }
                    .accessibilityIdentifier("settings.agent.reset.\(agent.kind.rawValue)")
            }
            Button("settings.agents.choose") { choose() }
                .accessibilityIdentifier("settings.agent.choose.\(agent.kind.rawValue)")
            installMenu
        }
    }

    private func probe() async {
        version = nil
        guard let path else { return }
        probing = true
        version = await CLIVersion.probe(path)
        probing = false
        latest = await AgentVersions.latest(for: agent.kind)
    }

    /// Install when the CLI is missing; Update (npm, when a newer release exists) and Uninstall when
    /// it is there (upstream `AgentInstallButton`, `AgentUpdateButton`, `AgentUninstallButton`).
    @ViewBuilder
    private var installMenu: some View {
        if AgentInstallCatalog.entries[agent.kind] != nil {
            if path == nil {
                Button("agentInstall.installEllipsis") { sheet = .install }
                    .disabled(environment.installer.isBusy)
                    .accessibilityIdentifier("settings.agent.install.\(agent.kind.rawValue)")
            } else {
                Menu {
                    if let version, let latest, AgentVersions.isOutdated(version, latest: latest),
                       AgentInstallCatalog.npmPackage(for: agent.kind) != nil {
                        Button("agentInstall.updateEllipsis") { sheet = .update }
                    }
                    Button("agentInstall.uninstallEllipsis") { sheet = .uninstall }
                } label: {
                    Image(systemName: "ellipsis.circle").webProfileSized(14)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(environment.installer.isBusy)
                .accessibilityLabel(Text("agentInstall.manage"))
                .accessibilityIdentifier("settings.agent.manage.\(agent.kind.rawValue)")
            }
        }
    }

    private func setEnabled(_ enabled: Bool) {
        environment.preferences?.update {
            $0.enabledAgents = AgentRegistry.builtin.enabled($0.enabledAgents, setting: agent.kind, on: enabled)
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = true
        panel.message = format("terminal.chooseCLI.message", agent.cliCommand ?? agent.displayName)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard LauncherResolver.path(url.path, matches: agent) else {
            let alert = NSAlert()
            alert.messageText = String(localized: "terminal.cliMismatch")
            alert.informativeText = format("terminal.cliMismatch.detail", agent.cliCommand ?? "")
            alert.runModal()
            return
        }
        setOverride(url.path)
    }

    private func setOverride(_ path: String?) {
        environment.preferences?.update { preferences in
            var paths = preferences.cliPaths ?? [:]
            paths[agent.kind.rawValue] = path
            preferences.cliPaths = paths.isEmpty ? nil : paths
        }
        environment.launchers.invalidate()
    }
}
