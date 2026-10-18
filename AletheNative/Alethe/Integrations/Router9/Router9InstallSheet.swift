import AletheAgents
import AletheDesign
import AletheIntegrations
import SwiftUI

/// Installs or uninstalls the managed 9router (upstream `Router9InstallModal`, `useRouter9Install`):
/// the exact command is shown before anything runs, the sheet's button is the one confirmation, and
/// the run goes through the P3-3 installer with its live log. Node is offered first when npm is missing.
struct Router9InstallSheet: View {
    let action: Router9Controller.InstallAction
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.openURL) private var openURL
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var toolchain: InstallToolchain?
    @State private var command: String?
    @State private var startedNode = false

    private var installer: AgentInstaller { environment.installer }
    private var installing: Bool { action == .install }
    private var isThisRun: Bool { installer.tool == Router9Controller.installTool && installer.status != .idle }
    private var isNodeRun: Bool { startedNode && installer.agent != nil && installer.status != .idle }
    private var missingNode: Bool { installing && toolchain != nil && toolchain?.npm != true }
    /// Another install (an agent's, elsewhere) holds the shared installer.
    private var blocked: Bool { installer.isBusy && !isThisRun && !isNodeRun }

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
        .task {
            toolchain = await installer.toolchain(launchers: environment.launchers)
            command = await environment.router9.command(for: action)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("router9.installSheet")
    }

    /// Router9InstallModal.tsx + agentActions.module.css.
    private var webBody: some View {
        ModalsM2WebModal(title: Text(installing ? "router9.install.title" : "router9.uninstall.title"), close: closeWeb, width: 480) {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                if toolchain == nil { Text("modalsM2.install.probing").font(metrics.font(size: 13)) }
                Text(installing ? "router9.install.intro" : "router9.uninstall.intro")
                    .font(metrics.font(size: 13)).lineSpacing(metrics.size(4))
                    .fixedSize(horizontal: false, vertical: true)
                if installing {
                    ModalsM2Toolchain {
                        Text("router9.securityNote").font(metrics.font(size: 13))
                            .fixedSize(horizontal: false, vertical: true)
                        Button { openURL(Router9.advisoriesURL) } label: {
                            Label { Text("router9.advisories") } icon: {
                                Image(systemName: "arrow.up.right.square").font(metrics.font(size: 13))
                            }
                        }.buttonStyle(AletheInstallActionStyle(.link))
                    }
                }
                if let command {
                    ModalsM2Command(command: command).accessibilityIdentifier("router9.install.command")
                }
                if missingNode {
                    ModalsM2NodeToolchain(command: AgentInstallCatalog.nodeMethods(toolchain: toolchain).first?.command,
                                          running: installer.isBusy && isNodeRun, canInstall: !installer.isBusy,
                                          install: installNode, download: { openURL(AgentInstallCatalog.nodeDownloadURL) })
                }
                if isThisRun { webResult }
                if isThisRun || isNodeRun {
                    ModalsM2InstallLog(log: installer.log).accessibilityIdentifier("router9.install.log")
                }
                if blocked { Text("router9.install.busy").font(metrics.font(size: 13)).foregroundStyle(theme[.fgMuted]) }
            }
        } footer: {
            Spacer()
            Button(isThisRun && installer.status != .running ? "router9.web.close" : "editor.cancel", action: closeWeb)
                .accessibilityIdentifier("router9.install.close")
            // The run worked: offering to do it again would undo what just happened.
            if !isThisRun || installer.status != .succeeded {
                Button(action: run) {
                    Label {
                        Text(runLabel)
                    } icon: {
                        Image(systemName: installing ? "arrow.down.to.line" : "trash").font(metrics.font(size: 13))
                    }
                }
                .buttonStyle(AletheButtonStyle(installing ? .primary : .danger))
                .keyboardShortcut(.defaultAction)
                .disabled(command == nil || installer.isBusy || (installing && missingNode))
                .accessibilityIdentifier("router9.install.run")
            }
        }
    }

    private var runLabel: LocalizedStringKey {
        if isThisRun && installer.status == .running {
            return installing ? "agentInstall.web.installing" : "agentInstall.web.uninstalling"
        }
        if isThisRun && installer.status == .failed { return "router9.web.retry" }
        return installing ? "agentInstall.install" : "agentInstall.uninstall"
    }

    @ViewBuilder
    private var webResult: some View {
        switch installer.status {
        case .succeeded:
            Text(installing ? "router9.web.installDone" : "router9.web.uninstallDone")
                .font(metrics.font(size: 13)).foregroundStyle(theme[.statusWorking])
                .accessibilityIdentifier("router9.install.succeeded")
        case .failed:
            Text(installing ? "router9.web.installFailed" : "router9.web.uninstallFailed")
                .font(metrics.font(size: 13)).foregroundStyle(theme[.statusOffline])
                .accessibilityIdentifier("router9.install.failed")
        case .running, .idle:
            EmptyView()
        }
    }

    private func installNode() {
        guard let node = AgentInstallCatalog.nodeMethods(toolchain: toolchain).first else { return }
        startedNode = true
        Task {
            // Any agent carries the Node install: it verifies against npm, not the agent.
            await installer.run(node, for: .claude, cli: "npm", launchers: environment.launchers)
            toolchain = await installer.toolchain(launchers: environment.launchers)
        }
    }

    private func closeWeb() {
        if isThisRun || isNodeRun { if installer.isBusy { installer.cancel() }; installer.reset() }
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            Text(installing ? "router9.install.title" : "router9.uninstall.title")
                .font(metrics.font(.title3))
            Text(installing ? "router9.install.intro" : "router9.uninstall.intro")
                .foregroundStyle(theme[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
            if installing {
                VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                    Text("router9.securityNote")
                        .foregroundStyle(theme[.textSecondary])
                        .fixedSize(horizontal: false, vertical: true)
                    Button("router9.advisories") { openURL(Router9.advisoriesURL) }
                        .buttonStyle(.link)
                }
                .font(metrics.font(.footnote))
            }
            if toolchain == nil || command == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let command {
                Text(verbatim: command)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(metrics.space(.s))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .accessibilityIdentifier("router9.install.command")
            }
            if missingNode { nodeRow }
            if isThisRun || isNodeRun { logView }
            if isThisRun { result }
            buttons
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(520))
        .interactiveDismissDisabled(installer.isBusy && (isThisRun || isNodeRun))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("router9.installSheet")
    }

    @ViewBuilder
    private var nodeRow: some View {
        VStack(alignment: .leading, spacing: metrics.space(.xs)) {
            Text("agentInstall.needsNode").foregroundStyle(theme[.textSecondary])
            HStack {
                if let node = AgentInstallCatalog.nodeMethods(toolchain: toolchain).first {
                    Button("agentInstall.installNode") {
                        startedNode = true
                        Task {
                            // Any agent carries the Node install: it verifies against npm, not the agent.
                            await installer.run(node, for: .claude, cli: "npm", launchers: environment.launchers)
                            toolchain = await installer.toolchain(launchers: environment.launchers)
                        }
                    }
                    .disabled(installer.isBusy)
                }
                Button("agentInstall.nodeDownload") { openURL(AgentInstallCatalog.nodeDownloadURL) }
                    .buttonStyle(.link)
            }
        }
    }

    private var logView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(verbatim: installer.log.isEmpty ? " " : installer.log)
                    .font(.footnote.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .id("log")
            }
            .frame(height: metrics.size(180))
            .padding(metrics.space(.s))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .onChange(of: installer.log) { _, _ in proxy.scrollTo("log", anchor: .bottom) }
        }
        .accessibilityIdentifier("router9.install.log")
    }

    @ViewBuilder
    private var result: some View {
        switch installer.status {
        case .succeeded:
            Label(installing ? "router9.install.succeeded" : "router9.uninstall.succeeded", systemImage: "checkmark.circle.fill")
                .foregroundStyle(theme[.statusActive])
                .accessibilityIdentifier("router9.install.succeeded")
        case .failed:
            Label("router9.install.failed", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(theme[.statusStopped])
                .accessibilityIdentifier("router9.install.failed")
        case .running:
            ProgressView().controlSize(.small)
        case .idle:
            EmptyView()
        }
    }

    private var buttons: some View {
        HStack {
            if blocked {
                Text("router9.install.busy").foregroundStyle(theme[.textSecondary])
            }
            Spacer()
            if installer.isBusy && isThisRun {
                Button("agentInstall.cancel") { installer.cancel() }
            } else {
                Button(isThisRun ? "agentInstall.done" : "editor.cancel") {
                    if isThisRun || isNodeRun { installer.reset() }
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                .disabled(installer.isBusy && isNodeRun)
                .accessibilityIdentifier("router9.install.close")
                if !isThisRun || installer.status == .failed {
                    Button(installing ? "agentInstall.install" : "agentInstall.uninstall", role: installing ? nil : .destructive) {
                        run()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(command == nil || installer.isBusy || missingNode)
                    .accessibilityIdentifier("router9.install.run")
                }
            }
        }
    }

    private func run() {
        guard let command else { return }
        startedNode = false
        Task { await environment.router9.run(action, command: command) }
    }
}
