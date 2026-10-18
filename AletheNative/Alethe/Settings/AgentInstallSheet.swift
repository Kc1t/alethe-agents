import AletheAgents
import AletheDesign
import SwiftUI

/// Install, update or uninstall one agent CLI (upstream `AgentInstallModal`): pick a method (only
/// those this Mac can run, each showing its exact command), run it, follow the log, see the result.
struct AgentInstallSheet: View {
    enum Mode: Hashable, Identifiable {
        case install, update, uninstall
        var id: Self { self }
    }

    let agent: AgentDescriptor
    let mode: Mode
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.openURL) private var openURL
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var toolchain: InstallToolchain?
    @State private var selection: InstallMethod.ID?

    private var installer: AgentInstaller { environment.installer }
    private var entry: AgentInstallCatalog.Entry? { AgentInstallCatalog.entries[agent.kind] }

    private var methods: [InstallMethod] {
        switch mode {
        case .install: AgentInstallCatalog.methods(for: agent.kind, toolchain: toolchain)
        case .update: AgentInstallCatalog.methods(for: agent.kind, toolchain: toolchain).filter { $0.kind == .npm }
        case .uninstall: AgentInstallCatalog.uninstallMethods(for: agent.kind, toolchain: toolchain)
        }
    }

    private var isThisRun: Bool { installer.agent == agent.kind && installer.status != .idle }

    var body: some View {
        Group {
            if metrics.isWebInterface { webBody } else { nativeBody }
        }
        .task {
            toolchain = await installer.toolchain(launchers: environment.launchers)
            selection = methods.first?.id
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agentInstall")
    }

    private var webBody: some View {
        ModalsM2WebModal(title: Text(verbatim: String(format: String(localized: mode.title), agent.displayName)), close: closeWeb) {
            VStack(alignment: .leading, spacing: metrics.size(10)) {
                if toolchain == nil {
                    Text("modalsM2.install.probing")
                } else if methods.isEmpty {
                    unavailable
                } else {
                    Text(verbatim: String(format: String(localized: "modalsM2.install.chooseMethod"), agent.displayName))
                    VStack(spacing: metrics.size(6)) {
                        ForEach(methods) { method in
                            Button { selection = method.id } label: {
                                HStack(alignment: .top, spacing: metrics.size(10)) {
                                    Image(systemName: selectedMethod?.id == method.id ? "largecircle.fill.circle" : "circle")
                                        .font(metrics.font(size: 13)).foregroundStyle(theme[.accent])
                                        .padding(.top, metrics.size(2))
                                    VStack(alignment: .leading, spacing: metrics.size(3)) {
                                        Text(method.kind.title).font(metrics.font(size: 12.5, weight: .medium))
                                        Text(verbatim: method.command).font(metrics.monoFont(size: 11))
                                            .foregroundStyle(theme[.fgMuted]).textSelection(.enabled)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .padding(.horizontal, metrics.size(11)).padding(.vertical, metrics.size(9))
                                .background(theme[selectedMethod?.id == method.id ? .accentSoft : .bg],
                                            in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                                    .strokeBorder(theme[selectedMethod?.id == method.id ? .accent : .border], lineWidth: metrics.size(1)))
                            }
                            .buttonStyle(.plain).disabled(installer.isBusy)
                            .accessibilityAddTraits(selectedMethod?.id == method.id ? [.isSelected] : [])
                        }
                    }
                    .accessibilityIdentifier("agentInstall.method")
                    .onKeyPress(.downArrow) { moveMethod(1); return .handled }
                    .onKeyPress(.upArrow) { moveMethod(-1); return .handled }
                }
                if isThisRun {
                    result
                    ModalsM2InstallLog(log: installer.log).accessibilityIdentifier("agentInstall.log")
                }
                if let entry {
                    Button { openURL(entry.docsURL) } label: {
                        Label("agentInstall.docs", systemImage: "arrow.up.right.square")
                            .font(metrics.font(size: 12))
                    }.buttonStyle(.plain).foregroundStyle(theme[.accent]).padding(.top, metrics.size(10))
                }
            }
        } footer: {
            Spacer()
            Button("agentInstall.cancel", action: closeWeb).keyboardShortcut(.cancelAction)
            if !isThisRun || installer.status != .succeeded {
                Button(action: start) {
                    Label { Text(mode.action) } icon: { Image(systemName: "arrow.down.to.line").font(metrics.font(size: 13)) }
                }
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction)
                .disabled(selectedMethod == nil || installer.isBusy)
                .accessibilityIdentifier("agentInstall.run")
            }
        }
    }

    private func moveMethod(_ direction: Int) {
        guard !installer.isBusy, !methods.isEmpty else { return }
        let index = methods.firstIndex { $0.id == selection } ?? 0
        selection = methods[(index + direction + methods.count) % methods.count].id
    }

    private func closeWeb() {
        if isThisRun { if installer.isBusy { installer.cancel() }; installer.reset() }
        if let closeOverlay { closeOverlay() } else { dismiss() }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            Text(verbatim: String(format: String(localized: mode.title), agent.displayName))
                .font((metrics.isWebInterface ? metrics.font(size: 16) : metrics.font(.title3)))
            if toolchain == nil {
                ProgressView().frame(maxWidth: .infinity)
            } else if methods.isEmpty {
                unavailable
            } else {
                Picker(selection: $selection) {
                    ForEach(methods) { method in
                        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                            Text(method.kind.title)
                            Text(verbatim: method.command)
                                .font(metrics.isWebInterface ? metrics.monoFont(size: 10, weight: .regular) : .footnote.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        .tag(Optional(method.id))
                    }
                } label: { EmptyView() }
                    .pickerStyle(.radioGroup)
                    .disabled(installer.isBusy)
                    .accessibilityIdentifier("agentInstall.method")
            }
            if isThisRun {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(verbatim: installer.log.isEmpty ? " " : installer.log)
                            .font(metrics.isWebInterface ? metrics.monoFont(size: 10, weight: .regular) : .footnote.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .id("log")
                    }
                    .frame(height: metrics.size(180))
                    .padding(metrics.space(.s))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .onChange(of: installer.log) { _, _ in proxy.scrollTo("log", anchor: .bottom) }
                }
                .accessibilityIdentifier("agentInstall.log")
                result
            }
            HStack {
                if let entry {
                    Button("agentInstall.docs") { openURL(entry.docsURL) }
                        .buttonStyle(.link)
                }
                Spacer()
                if installer.isBusy && isThisRun {
                    Button("agentInstall.cancel") { installer.cancel() }
                } else {
                    Button(isThisRun ? "agentInstall.done" : "editor.cancel") {
                        installer.reset()
                        closeWeb()
                    }
                    .keyboardShortcut(.cancelAction)
                    if !isThisRun || installer.status == .failed {
                        Button(mode.action) { start() }
                            .keyboardShortcut(.defaultAction)
                            .disabled(selectedMethod == nil || installer.isBusy)
                            .accessibilityIdentifier("agentInstall.run")
                    }
                }
            }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(520))
    }

    private var selectedMethod: InstallMethod? { methods.first { $0.id == selection } }

    @ViewBuilder
    private var unavailable: some View {
        if mode == .install, AgentInstallCatalog.needsNode(agent.kind, toolchain: toolchain) {
            Text("agentInstall.needsNode").foregroundStyle(.secondary)
            if let node = AgentInstallCatalog.nodeMethods(toolchain: toolchain).first {
                Button("agentInstall.installNode") {
                    Task { await installer.run(node, for: agent.kind, cli: "npm", launchers: environment.launchers)
                        toolchain = await installer.toolchain(launchers: environment.launchers)
                        selection = methods.first?.id }
                }
                .disabled(installer.isBusy)
            } else {
                Button("agentInstall.nodeDownload") { openURL(AgentInstallCatalog.nodeDownloadURL) }
            }
        } else {
            Text(mode == .uninstall ? "agentInstall.noUninstall" : "agentInstall.noMethod")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var result: some View {
        switch installer.status {
        case .succeeded:
            Label { Text(String(format: String(localized: mode.success), agent.displayName)) } icon: { Image(systemName: "checkmark.circle.fill").webProfileSized(14) }
                .foregroundStyle(theme[.statusActive])
                .accessibilityIdentifier("agentInstall.succeeded")
        case .failed:
            Label { Text(String(format: String(localized: "agentInstall.failed"), agent.displayName)) } icon: { Image(systemName: "exclamationmark.triangle.fill").webProfileSized(14) }
                .foregroundStyle(theme[.statusStopped])
                .accessibilityIdentifier("agentInstall.failed")
        case .running:
            ProgressView().controlSize(.small)
        case .idle:
            EmptyView()
        }
    }

    private func start() {
        guard let method = selectedMethod, let cli = agent.cliCommand else { return }
        Task { await installer.run(method, for: agent.kind, cli: cli, launchers: environment.launchers) }
    }
}

extension AgentInstallSheet.Mode {
    var title: String.LocalizationValue {
        switch self {
        case .install: "agentInstall.install.title"
        case .update: "agentInstall.update.title"
        case .uninstall: "agentInstall.uninstall.title"
        }
    }

    var action: LocalizedStringKey {
        switch self {
        case .install: "agentInstall.install"
        case .update: "agentInstall.update"
        case .uninstall: "agentInstall.uninstall"
        }
    }

    var success: String.LocalizationValue {
        switch self {
        case .install: "agentInstall.install.succeeded"
        case .update: "agentInstall.update.succeeded"
        case .uninstall: "agentInstall.uninstall.succeeded"
        }
    }
}

extension InstallMethod.Kind {
    var title: LocalizedStringKey {
        switch self {
        case .native: "agentInstall.method.native"
        case .brew: "agentInstall.method.brew"
        case .npm: "agentInstall.method.npm"
        }
    }
}
