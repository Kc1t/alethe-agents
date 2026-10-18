import AletheDesign
import AletheIntegrations
import AppKit
import SwiftUI

/// The GitHub Sync sheet (`EditorRequest.gistSync`; upstream `SyncModal` GitHub card — the cloud card
/// is SET-6, not ported): connect with a token, push, pull (asks once: it replaces this profile's
/// workspace and relaunches), last push and pull, disconnect. A pulled Tauri gist opens the Tauri
/// import in place. The token is never shown once entered.
struct GistSyncSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var token = ""
    @State private var askingPull = false
    @State private var pullStarted = false

    private var sync: GistSyncController { environment.gistSync }

    var body: some View {
        Group {
            if let pull = sync.tauriPull, let workspace = environment.workspace {
                // The main window's undo manager: the import stays undoable once the sheet closes.
                TauriImportSheet(workspace: workspace, undoManager: NSApp.mainWindow?.undoManager,
                                 projectsFile: pull.projectsFile)
            } else if metrics.isWebInterface {
                webBody
            } else { form }
        }
        .accessibilityIdentifier("gistSync.sheet")
        .onAppear { sync.refresh() }
        .onDisappear { sync.close() }
    }

    private var webBody: some View {
        ModalsM2WebModal(title: Text("modalsM2.sync.title"), close: { if let closeOverlay { closeOverlay() } else { dismiss() } }, width: 580) {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                Text("modalsM2.sync.subtitle").font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                HStack(alignment: .top, spacing: metrics.size(12)) {
                    webGitHubCard
                    webCloudCard
                }
                if let error = sync.error {
                    Text(verbatim: error).font(metrics.font(size: 12)).foregroundStyle(theme[.statusOffline])
                        .textSelection(.enabled).accessibilityIdentifier("gistSync.error")
                } else if sync.notice == .pushed {
                    Text("gistSync.pushDone").font(metrics.font(size: 12)).foregroundStyle(theme[.statusWorking])
                        .accessibilityIdentifier("gistSync.notice")
                }
                HStack {
                    Spacer()
                    Button { NSWorkspace.shared.open(URL(string: "https://github.com/sponsors/Kc1t")!) } label: {
                        Label("modalsM2.sync.sponsor", systemImage: "heart").font(metrics.font(size: 12.5, weight: .semibold))
                    }.buttonStyle(AletheButtonStyle())
                    Spacer()
                }.padding(.top, metrics.size(2))
            }
        } footer: { EmptyView() }
    }

    private var webGitHubCard: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            HStack(alignment: .top, spacing: metrics.size(10)) {
                webSyncIcon("chevron.left.forwardslash.chevron.right")
                VStack(alignment: .leading, spacing: metrics.size(4)) {
                    Text("gistSync.github").font(metrics.font(size: 14, weight: .semibold))
                    if sync.connected {
                        HStack(spacing: metrics.size(6)) {
                            Circle().fill(theme[.statusWorking]).frame(width: metrics.size(7), height: metrics.size(7))
                            Text(verbatim: String(format: String(localized: "gistSync.connectedAs"), sync.status?.login ?? "—"))
                                .accessibilityIdentifier("gistSync.connectedAs")
                        }.font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
                    } else {
                        Text("gistSync.description").font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
                    }
                }
            }
            if sync.connected {
                HStack(spacing: metrics.size(8)) {
                    Button(action: sync.push) {
                        Label(sync.busy == .push ? "gistSync.pushing" : "gistSync.push", systemImage: "arrow.up.from.line")
                            .frame(maxWidth: .infinity)
                    }.accessibilityIdentifier("gistSync.push")
                    Button(action: sync.pull) {
                        Label(sync.busy == .pull ? "gistSync.pulling" : "gistSync.pull", systemImage: "arrow.down.to.line")
                            .frame(maxWidth: .infinity)
                    }.accessibilityIdentifier("gistSync.pull")
                }.buttonStyle(AletheButtonStyle()).disabled(sync.busy != nil)
                if let pull = sync.confirmingPull {
                    VStack(alignment: .leading, spacing: metrics.size(8)) {
                        Text(verbatim: pullSummary(pull)).font(metrics.font(size: 11.5))
                        HStack(spacing: metrics.size(8)) {
                            Button("editor.cancel", action: sync.cancelPull)
                            Button("gistSync.pull.action", action: sync.confirmPull)
                                .buttonStyle(AletheButtonStyle(.primary)).accessibilityIdentifier("gistSync.pullConfirm")
                        }.buttonStyle(AletheButtonStyle())
                    }
                    .padding(metrics.size(10))
                    .background(theme[.statusWaitingSoft], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.statusWaiting], lineWidth: metrics.size(1)))
                }
                VStack(alignment: .leading, spacing: metrics.size(2)) {
                    Text(verbatim: when("gistSync.lastPush", sync.status?.lastPushAt)).accessibilityIdentifier("gistSync.lastPush")
                    Text(verbatim: when("gistSync.lastPull", sync.status?.lastPullAt)).accessibilityIdentifier("gistSync.lastPull")
                }.font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
                HStack {
                    if let url = sync.status?.gistURL {
                        Button("gistSync.openGist") { NSWorkspace.shared.open(url) }
                            .accessibilityIdentifier("gistSync.openGist")
                    }
                    Spacer(minLength: 0)
                    Button("gistSync.disconnect", action: sync.disconnect)
                        .foregroundStyle(theme[.statusOffline]).disabled(sync.busy != nil).accessibilityIdentifier("gistSync.disconnect")
                }.buttonStyle(.plain).font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
            } else {
                VStack(alignment: .leading, spacing: metrics.size(8)) {
                    SecureField("gistSync.token", text: $token, prompt: Text("gistSync.token.placeholder"))
                        .modifier(ModalsM2Input(mono: true)).onSubmit(connect).accessibilityIdentifier("gistSync.token")
                    Button(action: connect) {
                        Text(sync.busy == .connect ? "gistSync.connecting" : "gistSync.connect").frame(maxWidth: .infinity)
                    }.buttonStyle(AletheButtonStyle(.primary))
                        .disabled(sync.busy != nil || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("gistSync.connect")
                    Text("gistSync.token.hint").font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
                    Button("gistSync.createToken") { NSWorkspace.shared.open(GistSyncController.createTokenURL) }
                        .buttonStyle(.plain).font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
                        .accessibilityIdentifier("gistSync.createToken")
                }
            }
        }
        .padding(metrics.size(14)).frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private var webCloudCard: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            HStack(alignment: .top, spacing: metrics.size(10)) {
                webSyncIcon("cloud")
                VStack(alignment: .leading, spacing: metrics.size(4)) {
                    Text("modalsM2.sync.cloud").font(metrics.font(size: 14, weight: .semibold))
                    Text("modalsM2.sync.soon").font(metrics.font(size: 9, weight: .bold)).textCase(.uppercase)
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                        .background(theme[.accentFaint], in: Capsule())
                    Text("modalsM2.sync.cloudDescription").font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
                }
            }
            Text("modalsM2.sync.premium").font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
            Button("modalsM2.sync.subscribe") {}.buttonStyle(AletheButtonStyle()).disabled(true)
        }
        .padding(metrics.size(14)).frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .opacity(0.9)
    }

    private func webSyncIcon(_ symbol: String) -> some View {
        Image(systemName: symbol).font(metrics.font(size: 18))
            .frame(width: metrics.size(32), height: metrics.size(32))
            .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private var form: some View {
        Form {
            Section {
                if sync.connected {
                    connectedContent
                } else {
                    connectContent
                }
            } header: {
                Text("gistSync.github")
            } footer: {
                Text("gistSync.subtitle")
                    .foregroundStyle(theme[.textSecondary])
            }
            if let error = sync.error {
                Text(verbatim: error)
                    .foregroundStyle(theme[.statusStopped])
                    .textSelection(.enabled)
                    .accessibilityIdentifier("gistSync.error")
            } else if sync.notice == .pushed {
                Text("gistSync.pushDone")
                    .foregroundStyle(theme[.textSecondary])
                    .accessibilityIdentifier("gistSync.notice")
            }
        }
        .formStyle(.grouped)
        .frame(width: metrics.size(480))
        .navigationTitle(Text("gistSync.title"))
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("gistSync.done") { dismiss() }
                    .accessibilityIdentifier("gistSync.done")
            }
        }
        .webConfirm(isPresented: $askingPull, message: sync.confirmingPull.map(pullSummary) ?? "",
                    title: String(localized: "gistSync.pull.confirm"),
                    confirmTitle: String(localized: "gistSync.pull.action"), destructive: true) {
            pullStarted = true
            sync.confirmPull()
        }
        .confirmationDialog(Text("gistSync.pull.confirm"), isPresented: Binding(get: { !metrics.isWebInterface && askingPull }, set: { askingPull = $0 })) {
            Button("gistSync.pull.action", role: .destructive) {
                pullStarted = true
                sync.confirmPull()
            }
            .accessibilityIdentifier("gistSync.pullConfirm")
        } message: {
            Text(verbatim: sync.confirmingPull.map(pullSummary) ?? "")
        }
        .onChange(of: sync.confirmingPull != nil) { _, staged in
            if staged {
                pullStarted = false
                askingPull = true
            }
        }
        .onChange(of: askingPull) { _, shown in
            // Cancelled: the staged copy is dropped and nothing changed.
            if !shown, !pullStarted { sync.cancelPull() }
        }
    }

    // MARK: - Not connected

    @ViewBuilder
    private var connectContent: some View {
        Text("gistSync.description")
            .foregroundStyle(theme[.textSecondary])
        SecureField("gistSync.token", text: $token, prompt: Text("gistSync.token.placeholder"))
            .onSubmit(connect)
            .accessibilityIdentifier("gistSync.token")
        LabeledContent {
            Button(action: connect) {
                if sync.busy == .connect {
                    Text("gistSync.connecting")
                } else {
                    Text("gistSync.connect")
                }
            }
            .disabled(sync.busy != nil || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier("gistSync.connect")
        } label: {
            HStack(spacing: metrics.size(4)) {
                Text("gistSync.token.hint")
                Button("gistSync.createToken") { NSWorkspace.shared.open(GistSyncController.createTokenURL) }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("gistSync.createToken")
            }
        }
    }

    private func connect() {
        let value = token
        // Cleared at once: the token is never shown again after entry.
        token = ""
        sync.connect(token: value)
    }

    // MARK: - Connected

    @ViewBuilder
    private var connectedContent: some View {
        LabeledContent {
            if let url = sync.status?.gistURL {
                Button("gistSync.openGist") { NSWorkspace.shared.open(url) }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("gistSync.openGist")
            }
        } label: {
            HStack(spacing: metrics.size(6)) {
                Circle()
                    .fill(theme[.statusActive])
                    .frame(width: metrics.size(7), height: metrics.size(7))
                    .accessibilityHidden(true)
                Text(verbatim: String(format: String(localized: "gistSync.connectedAs"), sync.status?.login ?? "—"))
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("gistSync.connectedAs")
        }
        LabeledContent {
            HStack {
                Button(action: sync.push) {
                    if sync.busy == .push {
                        Label("gistSync.pushing", systemImage: "arrow.up.circle")
                    } else {
                        Label("gistSync.push", systemImage: "arrow.up.circle")
                    }
                }
                .accessibilityIdentifier("gistSync.push")
                Button(action: sync.pull) {
                    if sync.busy == .pull {
                        Label("gistSync.pulling", systemImage: "arrow.down.circle")
                    } else {
                        Label("gistSync.pull", systemImage: "arrow.down.circle")
                    }
                }
                .accessibilityIdentifier("gistSync.pull")
            }
            .disabled(sync.busy != nil)
        } label: {
            Text(verbatim: when("gistSync.lastPush", sync.status?.lastPushAt))
                .accessibilityIdentifier("gistSync.lastPush")
            Text(verbatim: when("gistSync.lastPull", sync.status?.lastPullAt))
                .accessibilityIdentifier("gistSync.lastPull")
        }
        LabeledContent {
            Button("gistSync.disconnect", role: .destructive, action: sync.disconnect)
                .disabled(sync.busy != nil)
                .accessibilityIdentifier("gistSync.disconnect")
        } label: {
            Text("gistSync.disconnect.help")
        }
    }

    private func when(_ key: String.LocalizationValue, _ date: Date?) -> String {
        let value = date?.formatted(date: .abbreviated, time: .shortened) ?? String(localized: "gistSync.never")
        return String(format: String(localized: key), value)
    }

    private func pullSummary(_ pull: StagedGistPull) -> String {
        [String(format: String(localized: "gistSync.pull.holds"), pull.projects, pull.terminals),
         String(format: String(localized: "gistSync.pull.message"), environment.activeProfileName)]
            .joined(separator: "\n\n")
    }
}
