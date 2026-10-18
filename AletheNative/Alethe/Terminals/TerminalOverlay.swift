import AletheAgents
import AletheDesign
import AletheModel
import AletheTerminal
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// What a pane shows over its terminal when the process ended or could not start; nothing while it
/// runs. Hosted by `PaneView` only when needed, so it never sits over a live terminal.
struct TerminalOverlay: View {
    let tab: PaneTab
    let project: Project
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    static func isNeeded(for state: TerminalRegistry.State?) -> Bool {
        switch state {
        case .running, nil: false
        default: true
        }
    }

    var body: some View {
        if metrics.isWebInterface { webOverlay } else { nativeOverlay }
    }

    private var webOverlay: some View {
        VStack(spacing: metrics.size(10)) {
            Image(systemName: "arrow.clockwise")
                .font(metrics.font(size: 24))
                .foregroundStyle(theme[.fgMuted]).opacity(0.5)
            Text("pane.web.processEnded")
                .font(metrics.font(size: 13, weight: .medium))
                .foregroundStyle(theme[.fg])
            Button("pane.web.restart") { environment.terminals.restart(tab, in: project, environment: environment) }
                .buttonStyle(AletheTerminalRestartStyle())
                .padding(.top, metrics.size(4))
                .accessibilityIdentifier("terminal.restart")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bgSunken].opacity(0.86))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal.overlay")
    }

    private var nativeOverlay: some View {
        ZStack {
            Color.clear
            switch environment.terminals.states[tab.id] {
            case .exited(let code):
                overlay {
                    Text(verbatim: format("terminal.exited", Int(code)))
                        .foregroundStyle(theme[.textPrimary])
                    restartButton
                }
            case .forceKilled:
                overlay {
                    Text("terminal.forceKilled.overlay")
                        .foregroundStyle(theme[.textPrimary])
                    restartButton
                }
            case .notFound(let command):
                overlay {
                    Text(verbatim: format("terminal.notFound", AgentLabels.name(for: tab.agent), command))
                        .foregroundStyle(theme[.textPrimary])
                        .multilineTextAlignment(.center)
                    HStack {
                        Button("terminal.chooseCLI") { chooseCLI(command: command) }
                        restartButton
                    }
                }
            case .failed(let message):
                overlay {
                    Text("terminal.failed").foregroundStyle(theme[.textPrimary])
                    Text(verbatim: message).font(metrics.font(.footnote)).foregroundStyle(theme[.textSecondary])
                    restartButton
                }
            case .running, nil:
                EmptyView()
            }
        }
    }

    private var restartButton: some View {
        Button("terminal.restart") { environment.terminals.restart(tab, in: project, environment: environment) }
            .keyboardShortcut(.defaultAction)
            .tint(theme[.accent])
            .accessibilityIdentifier("terminal.restart")
    }

    private func overlay(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(spacing: metrics.space(.m)) { content() }
            .font(metrics.font(.body))
            .padding(metrics.space(.xl))
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border]))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("terminal.overlay")
    }

    /// Points the agent at a CLI the resolver missed (upstream `configurePath`).
    private func chooseCLI(command: String) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = true
        panel.message = format("terminal.chooseCLI.message", command)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let descriptor = AgentRegistry.builtin.descriptor(for: AgentKind(rawValue: tab.agent)),
              LauncherResolver.path(url.path, matches: descriptor) else {
            let alert = NSAlert()
            alert.messageText = String(localized: "terminal.cliMismatch")
            alert.informativeText = format("terminal.cliMismatch.detail", command)
            alert.runModal()
            return
        }
        environment.preferences?.update { preferences in
            var paths = preferences.cliPaths ?? [:]
            paths[tab.agent] = url.path
            preferences.cliPaths = paths
        }
        environment.terminals.restart(tab, in: project, environment: environment)
    }
}

/// A catalog string with `%1$@`-style placeholders filled in.
func format(_ key: String.LocalizationValue, _ arguments: any CVarArg...) -> String {
    String(format: String(localized: key), arguments: arguments)
}

/// Over a disabled pane (upstream disabled terminal): nothing runs until it is enabled; the saved
/// output comes back with it.
struct DisabledPaneOverlay: View {
    var agent: String = "shell"
    /// Web: the terminal name under the icon and its working directory (both optional).
    var name: String?
    var cwd: String?
    let onEnable: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    /// TerminalPane.module.css `.disabledOverlay`: gap 10, padding 24, 64 icon box with a 56 logo at 0.85.
    private var webBody: some View {
        VStack(spacing: metrics.size(10)) {
            AgentLogo(agent: agent, size: 56, templateColor: theme[AgentTokens.accent(for: agent)])
                .frame(width: metrics.size(64), height: metrics.size(64))
                .opacity(0.85)
                .padding(.bottom, metrics.size(4))
            Text(verbatim: name ?? agent.capitalized)
                .font(metrics.font(size: 16, weight: .semibold))
                .foregroundStyle(theme[.fg])
                .multilineTextAlignment(.center)
            if let cwd, !cwd.isEmpty {
                Text(verbatim: cwd)
                    .font(metrics.monoFont(size: 11))
                    .foregroundStyle(theme[.fgFaint])
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.bottom, metrics.size(12))
            }
            Button(action: onEnable) {
                Text("pane.web.reactivate")
                    .font(metrics.font(size: 13, weight: .medium))
                    .foregroundStyle(theme[.fg])
                    .padding(.horizontal, metrics.size(18))
                    .padding(.vertical, metrics.size(7))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pane.enable")
        }
        .padding(metrics.size(24))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bgSunken])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.disabled")
    }

    private var nativeBody: some View {
        VStack(spacing: metrics.space(.m)) {
            Image(systemName: "pause.circle").webProfileSized(14)
                .font(metrics.font(.title1))
                .foregroundStyle(theme[.statusDisabled])
            Text("pane.disabled.title")
                .font(metrics.font(.headline))
                .foregroundStyle(theme[.textPrimary])
            Text("pane.disabled.message")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
                .multilineTextAlignment(.center)
            Button("pane.enable", action: onEnable)
                .accessibilityIdentifier("pane.enable")
        }
        .padding(metrics.space(.xl))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme[.bgSunken])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.disabled")
    }
}
