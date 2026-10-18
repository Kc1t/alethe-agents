import AletheDesign
import AletheModel
import AletheRemote
import AppKit
import SwiftUI

/// Settings › Remote (PER-7; upstream `RemoteControlPage`, `RemoteControlSettingsFields`): on/off,
/// reach, the security policy, the pairing window and the paired devices. Turning it on — the only
/// way anything listens beyond this Mac — asks once with the network warning; revoking asks once.
/// Pairing and session tokens are never shown here (the QR lives in the pairing sheet).
struct RemoteSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var confirmEnable = false
    @State private var revoking: RemoteDeviceInfo?
    @State private var confirmRevokeAll = false
    @State private var revealed: Set<Int> = []
    @State private var linkCopied = false

    static let sessionOptions = [900, 3600, 86400]
    static let tailscaleDownload = URL(string: "https://tailscale.com/download")!

    private var controller: RemoteControlController { environment.remoteControl }
    private var remote: RemotePreferences { environment.preferences?.document.remoteSettings ?? RemotePreferences() }
    private var info: RemoteInfo? { controller.info }
    private var tailscaleAvailable: Bool { controller.tailscale?.available == true }

    var body: some View {
        SettingsPageForm {
            if metrics.isWebInterface {
                Section {
                    VStack(alignment: .leading, spacing: metrics.size(8)) {
                        Text("settings.web.reference.remote.tutorialStep1")
                        Text("settings.web.reference.remote.tutorialStep2")
                        Text("settings.web.reference.remote.tutorialStep3")
                        Text("settings.web.reference.remote.tutorialStep4")
                        Text("settings.web.reference.remote.tutorialStep5")
                    }
                } header: { Text("settings.web.reference.remote.tutorialTitle") }
                  footer: { Text("settings.web.reference.remote.tutorialDesc") }
            }
            serviceSection
            reachSection
            if controller.isEnabled { pairingSection }
            securitySection
            devicesSection
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("settings.remote")
        .task { await poll() }
        .webConfirm(isPresented: $confirmEnable, message: String(localized: remote.useTailscale ? "settings.remote.enable.warningTailscale" : "settings.remote.enable.warning"), title: String(localized: "settings.remote.enable.confirm"),
                    confirmTitle: String(localized: "settings.remote.enable.turnOn")) { controller.setEnabled(true) }
        .confirmationDialog("settings.remote.enable.confirm", isPresented: Binding(get: { !metrics.isWebInterface && confirmEnable }, set: { confirmEnable = $0 }), titleVisibility: .visible) {
            Button("settings.remote.enable.turnOn") { controller.setEnabled(true) }
                .accessibilityIdentifier("settings.remote.enable.turnOn")
            Button("editor.cancel", role: .cancel) {}
        } message: {
            Text(remote.useTailscale ? "settings.remote.enable.warningTailscale" : "settings.remote.enable.warning")
        }
        .webConfirm(isPresented: webRevoking, message: String(localized: "settings.remote.revoke.detail"), title: revokeTitle,
                    confirmTitle: String(localized: "settings.remote.revoke"), destructive: true) {
            if let device = revoking { controller.revoke(deviceID: device.id) }
        }
        .confirmationDialog(Text(verbatim: revokeTitle), isPresented: presentedNative($revoking), titleVisibility: .visible,
                            presenting: revoking) { device in
            Button("settings.remote.revoke", role: .destructive) { controller.revoke(deviceID: device.id) }
                .accessibilityIdentifier("settings.remote.revoke.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: { _ in
            Text("settings.remote.revoke.detail")
        }
        .webConfirm(isPresented: $confirmRevokeAll, message: String(localized: "settings.remote.revokeAll.detail"), title: String(localized: "settings.remote.revokeAll.confirm"),
                    confirmTitle: String(localized: "settings.remote.revokeAll"), destructive: true) { controller.revokeAll() }
        .confirmationDialog("settings.remote.revokeAll.confirm", isPresented: Binding(get: { !metrics.isWebInterface && confirmRevokeAll }, set: { confirmRevokeAll = $0 }), titleVisibility: .visible) {
            Button("settings.remote.revokeAll", role: .destructive) { controller.revokeAll() }
                .accessibilityIdentifier("settings.remote.revokeAll.confirm")
            Button("editor.cancel", role: .cancel) {}
        } message: {
            Text("settings.remote.revokeAll.detail")
        }
    }

    // MARK: - Sections

    private var serviceSection: some View {
        Section {
            Toggle(isOn: Binding(get: { controller.isEnabled }, set: setEnabled)) {
                Text("settings.remote.enabled")
                Text(verbatim: statusLine)
            }
            .accessibilityIdentifier("settings.remote.enabled")
            #if DEBUG
            if UserDefaults.standard.string(forKey: "AletheDataRoot") != nil {
                // UI tests read what the controller and its hub hold, not just what the form shows.
                Text(verbatim: probe)
                    .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.caption)))
                    .foregroundStyle(theme[.textTertiary])
                    .accessibilityIdentifier("settings.remote.probe")
            }
            #endif
        } header: {
            Text(metrics.isWebInterface ? "settings.web.reference.remote.settingsStatusTitle" : "settings.remote.service")
        } footer: {
            VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                Text("settings.remote.startupNote")
                Text("settings.remote.sharingNote")
            }
            .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
            .foregroundStyle(theme[.textSecondary])
        }
    }

    private var reachSection: some View {
        Section {
            if metrics.isWebInterface {
                WebSelectRow(title: "settings.web.reference.remote.reachTitle", detail: "settings.remote.reach.help",
                             selection: Binding(get: { remote.useTailscale }, set: { tailscale in update { $0.useTailscale = tailscale } }),
                             options: tailscaleAvailable || remote.useTailscale ? [false, true] : [false]) {
                    $0 ? String(localized: "settings.remote.reach.tailscale") : String(localized: "settings.remote.reach.lan")
                }
                .accessibilityIdentifier("settings.remote.reach")
            } else {
            Picker(selection: Binding(get: { remote.useTailscale }, set: { tailscale in update { $0.useTailscale = tailscale } })) {
                Text("settings.remote.reach.lan").tag(false)
                Text("settings.remote.reach.tailscale").tag(true)
                    .disabled(!tailscaleAvailable && !remote.useTailscale)
            } label: {
                Text(metrics.isWebInterface ? "settings.web.reference.remote.reachTitle" : "settings.remote.reach")
                Text("settings.remote.reach.help")
            }
            .accessibilityIdentifier("settings.remote.reach")
            }
            if tailscaleAvailable {
                Text("settings.remote.reach.tailscaleHint")
                    .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                    .foregroundStyle(theme[.textSecondary])
            } else {
                VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                    Text(remote.useTailscale ? "settings.remote.reach.tailscaleMissingChosen" : "settings.remote.reach.tailscaleMissing")
                        .foregroundStyle(theme[remote.useTailscale ? .statusStopped : .textSecondary])
                    HStack(spacing: metrics.space(.s)) {
                        Link(destination: Self.tailscaleDownload) {
                            Text(verbatim: Self.tailscaleDownload.absoluteString)
                        }
                        .accessibilityIdentifier("settings.remote.reach.download")
                        Button(linkCopied ? LocalizedStringKey("settings.remote.reach.copied") : "settings.remote.reach.copyLink") {
                            copyDownloadLink()
                        }
                        .accessibilityIdentifier("settings.remote.reach.copyLink")
                    }
                }
                .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                .accessibilityIdentifier("settings.remote.reach.unavailable")
            }
        } header: {
            Text("settings.remote.reach.title")
        }
    }

    private var pairingSection: some View {
        let open = info?.pairingOpen == true
        return Section {
            LabeledContent {
                HStack {
                    if open {
                        Button("settings.remote.pairing.close") { controller.closePairing() }
                            .accessibilityIdentifier("settings.remote.pairing.close")
                    }
                    Button("settings.remote.pairing.pair", action: pairDevice)
                        .accessibilityIdentifier("settings.remote.pairing.pair")
                }
            } label: {
                Text(open ? "settings.remote.pairing.open" : "settings.remote.pairing.closed")
                Text(verbatim: open
                     ? String(format: String(localized: "settings.remote.pairing.countdown"), info?.pairingExpiresIn ?? 0)
                     : String(localized: "settings.remote.pairing.closedHint"))
            }
            .accessibilityIdentifier("settings.remote.pairing")
        } header: {
            Text("settings.remote.pairing")
        }
    }

    private var securitySection: some View {
        Section {
            if metrics.isWebInterface {
                WebSelectRow(title: "settings.remote.maxDevices", detail: "settings.remote.maxDevices.help",
                             selection: Binding(get: { remote.maxDevices }, set: { value in update { $0.maxDevices = value } }),
                             options: Array(RemotePreferences.maxDevicesRange)) { "\($0)" }
                    .accessibilityIdentifier("settings.remote.maxDevices")
                WebSelectRow(title: "settings.remote.expiry", detail: "settings.remote.expiry.help",
                             selection: Binding(get: { remote.sessionExpirySecs }, set: { value in update { $0.sessionExpirySecs = value } }),
                             options: Self.expiryOptions(including: remote.sessionExpirySecs)) { Self.expiryLabel($0) }
                    .accessibilityIdentifier("settings.remote.expiry")
            } else {
            Picker(selection: Binding(get: { remote.maxDevices }, set: { value in update { $0.maxDevices = value } })) {
                ForEach(Array(RemotePreferences.maxDevicesRange), id: \.self) { count in
                    Text(verbatim: "\(count)").tag(count)
                }
            } label: {
                Text("settings.remote.maxDevices")
                Text("settings.remote.maxDevices.help")
            }
            .accessibilityIdentifier("settings.remote.maxDevices")
            Picker(selection: Binding(get: { remote.sessionExpirySecs }, set: { value in update { $0.sessionExpirySecs = value } })) {
                ForEach(Self.expiryOptions(including: remote.sessionExpirySecs), id: \.self) { seconds in
                    Text(verbatim: Self.expiryLabel(seconds)).tag(seconds)
                }
            } label: {
                Text("settings.remote.expiry")
                Text("settings.remote.expiry.help")
            }
            .accessibilityIdentifier("settings.remote.expiry")
            }
            Toggle(isOn: Binding(get: { remote.readOnly }, set: { value in update { $0.readOnly = value } })) {
                Text("settings.remote.readOnly")
                Text("settings.remote.readOnly.help")
            }
            .accessibilityIdentifier("settings.remote.readOnly")
            Toggle(isOn: Binding(get: { remote.allowShellInput }, set: { value in update { $0.allowShellInput = value } })) {
                Text("settings.remote.shellInput")
                Text("settings.remote.shellInput.help")
            }
            .disabled(remote.readOnly)
            .accessibilityIdentifier("settings.remote.shellInput")
        } header: {
            Text("settings.remote.security")
        } footer: {
            Text(remote.useTailscale ? "settings.remote.securityNoteTailscale" : "settings.remote.securityNote")
                .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                .foregroundStyle(theme[.textSecondary])
        }
    }

    private var devicesSection: some View {
        let devices = info?.devices ?? []
        return Section {
            if devices.isEmpty {
                Text("settings.remote.devices.none")
                    .foregroundStyle(theme[.textSecondary])
                    .accessibilityIdentifier("settings.remote.devices.none")
            }
            ForEach(devices) { device in
                LabeledContent {
                    HStack {
                        Button(revealed.contains(device.id) ? LocalizedStringKey("settings.remote.devices.hideAddress")
                               : "settings.remote.devices.showAddress") {
                            if revealed.remove(device.id) == nil { revealed.insert(device.id) }
                        }
                        .accessibilityIdentifier("settings.remote.device.reveal")
                        Button("settings.remote.revoke", role: .destructive) { revoking = device }
                            .accessibilityIdentifier("settings.remote.device.revoke")
                    }
                } label: {
                    Text(verbatim: device.name)
                    Text(verbatim: detail(of: device))
                }
                .accessibilityIdentifier("settings.remote.device")
            }
            if !devices.isEmpty {
                Button("settings.remote.revokeAll", role: .destructive) { confirmRevokeAll = true }
                    .accessibilityIdentifier("settings.remote.revokeAll")
            }
        } header: {
            Text("settings.remote.devices")
        } footer: {
            Text("settings.remote.devices.help")
                .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
                .foregroundStyle(theme[.textSecondary])
        }
    }

    // MARK: - Text

    private var statusLine: String {
        guard controller.isEnabled else { return String(localized: "settings.remote.status.off") }
        // The listener's address shows once a device is paired (upstream); before that it stays hidden.
        if let url = info?.httpURL, (info?.connectedDevices ?? 0) > 0 {
            return String(format: String(localized: "settings.remote.status.onAt"), url)
        }
        return String(localized: "settings.remote.status.on")
    }

    private func detail(of device: RemoteDeviceInfo) -> String {
        let address = revealed.contains(device.id) ? device.address : String(localized: "settings.remote.devices.addressHidden")
        let state = device.online ? String(localized: "settings.remote.devices.online") : String(localized: "settings.remote.devices.idle")
        let expiry = String(format: String(localized: "settings.remote.devices.expires"),
                            device.expiresAt.formatted(date: .omitted, time: .shortened))
        return [address, state, expiry].joined(separator: " · ")
    }

    private var revokeTitle: String {
        String(format: String(localized: "settings.remote.revoke.confirm"), revoking?.name ?? "")
    }

    /// The upstream choices, plus a stored value outside them (an imported or edited file).
    static func expiryOptions(including current: Int) -> [Int] {
        sessionOptions.contains(current) ? sessionOptions : (sessionOptions + [current]).sorted()
    }

    static func expiryLabel(_ seconds: Int) -> String {
        switch seconds {
        case 900: String(localized: "settings.remote.expiry.15m")
        case 3600: String(localized: "settings.remote.expiry.1h")
        case 86400: String(localized: "settings.remote.expiry.24h")
        default: Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .wide))
        }
    }

    #if DEBUG
    private var probe: String {
        let shared = controller.snapshot().projects.flatMap(\.chats).map(\.name).sorted().joined(separator: ",")
        guard let info else { return "enabled=\(controller.isEnabled) shared=\(shared)" }
        return "enabled=\(info.enabled) readOnly=\(info.readOnly) shell=\(info.allowShellInput) max=\(info.maxDevices) "
            + "expiry=\(info.sessionExpirySecs) reach=\(info.reachMode.rawValue) shared=\(shared)"
    }
    #endif

    // MARK: - Actions

    private func setEnabled(_ enabled: Bool) {
        if enabled { confirmEnable = true } else { controller.setEnabled(false) }
    }

    private func update(_ change: @escaping (inout RemotePreferences) -> Void) {
        environment.preferences?.update { preferences in
            var remote = preferences.remoteSettings
            change(&remote)
            preferences.remote = remote
        }
    }

    private func pairDevice() {
        controller.openPairing()
        environment.editorRequest = .remotePairing
        openWindow(id: "main")
        dismissWindow()
    }

    private func copyDownloadLink() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(Self.tailscaleDownload.absoluteString, forType: .string)
        linkCopied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            linkCopied = false
        }
    }

    /// Keeps the device list and countdown current (1 s) and Tailscale's presence (5 s; it runs the
    /// CLI off main) while the tab is shown.
    private func poll() async {
        var tick = 0
        while !Task.isCancelled {
            if tick % 5 == 0 { controller.refreshTailscale() }
            controller.refresh()
            tick += 1
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func presented<Value>(_ value: Binding<Value?>) -> Binding<Bool> {
        Binding(get: { value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
    }

    private func presentedNative<Value>(_ value: Binding<Value?>) -> Binding<Bool> {
        Binding(get: { !metrics.isWebInterface && value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
    }

    private var webRevoking: Binding<Bool> { presented($revoking) }
}
