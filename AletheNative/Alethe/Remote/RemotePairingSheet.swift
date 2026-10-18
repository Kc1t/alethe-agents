import AletheDesign
import AletheRemote
import AppKit
import SwiftUI

/// The pairing sheet (`EditorRequest.remotePairing`; upstream `RemoteControlModal`): status and the
/// on/off switch, the pairing QR and URL with Copy and the 120 s countdown (reopened when it closes),
/// the paired devices with Revoke, and Open Settings. The pairing window opens with the sheet and
/// closes with it, so the URL and its token are only ever shown here, while the sheet is open.
struct RemotePairingSheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.openSettings) private var openSettings
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    /// The URL last copied, so "Copied" never refers to an older pairing token.
    @State private var copiedURL: String?

    private var remote: RemoteControlController { environment.remoteControl }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var webBody: some View {
        GitWebModal(close: dismiss) {
            Text("titlebar.remote")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(16)) {
                header(enabled: remote.isEnabled)
                if remote.isEnabled {
                    pairing(remote.info)
                    devices(remote.info)
                } else {
                    Text("remote.pairing.disabledCard").foregroundStyle(theme[.fgMuted])
                        .frame(maxWidth: .infinity, minHeight: metrics.size(120))
                        .accessibilityIdentifier("remote.pairing.disabledCard")
                }
                Text(remote.info?.reachMode == .tailscale ? "remote.pairing.securityTailscale" : "remote.pairing.security")
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            }
        } footer: {
            footer(enabled: remote.isEnabled)
        }
        .task {
            while !Task.isCancelled {
                remote.refresh()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .task(id: remote.isEnabled) {
            if remote.isEnabled, remote.info?.pairingOpen != true { remote.openPairing() }
        }
        .onDisappear { if remote.isEnabled { remote.closePairing() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote.pairing")
    }

    @ViewBuilder private var nativeBody: some View {
        let info = remote.info
        let enabled = remote.isEnabled
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            header(enabled: enabled)
            if enabled {
                pairing(info)
                devices(info)
            } else {
                Text("remote.pairing.disabledCard")
                    .font(metrics.font(.body))
                    .foregroundStyle(theme[.textSecondary])
                    .frame(maxWidth: .infinity, minHeight: metrics.size(120))
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .accessibilityIdentifier("remote.pairing.disabledCard")
            }
            Text(info?.reachMode == .tailscale ? "remote.pairing.securityTailscale" : "remote.pairing.security")
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textTertiary])
                .fixedSize(horizontal: false, vertical: true)
            footer(enabled: enabled)
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(560))
        // While the sheet is open: the countdown and device list follow the hub (upstream polls each second).
        .task {
            while !Task.isCancelled {
                remote.refresh()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .task(id: enabled) {
            if enabled, remote.info?.pairingOpen != true { remote.openPairing() }
        }
        .onDisappear {
            if remote.isEnabled { remote.closePairing() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote.pairing")
    }

    // MARK: - Sections

    private func header(enabled: Bool) -> some View {
        HStack(alignment: .top, spacing: metrics.space(.l)) {
            Image(systemName: "iphone")
                .font(metrics.font(.title2))
                .foregroundStyle(enabled ? theme[.accent] : theme[.textTertiary])
                .frame(width: metrics.size(40), height: metrics.size(40))
                .background(enabled ? theme[.accentBgSoft] : theme[.bgSunken],
                            in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                Text(enabled ? "remote.pairing.statusOn" : "remote.pairing.statusOff")
                    .font(metrics.font(.title3))
                Text(enabled ? "remote.pairing.descriptionOn" : "remote.pairing.descriptionOff")
                    .font(metrics.font(.body))
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack(spacing: metrics.space(.xs)) {
                Circle()
                    .fill(enabled ? theme[.statusActive] : theme[.statusDisabled])
                    .frame(width: metrics.size(6), height: metrics.size(6))
                Text(enabled ? "remote.pairing.badgeOn" : "remote.pairing.badgeOff")
            }
            .font(metrics.font(.caption).weight(.semibold))
            .foregroundStyle(enabled ? theme[.statusActive] : theme[.textTertiary])
            .padding(.horizontal, metrics.space(.m))
            .padding(.vertical, metrics.space(.xxs))
            .background(theme[.bgSunken], in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("remote.pairing.status")
        }
    }

    @ViewBuilder
    private func pairing(_ info: RemoteInfo?) -> some View {
        HStack(alignment: .top, spacing: metrics.space(.xl)) {
            VStack(spacing: metrics.space(.m)) {
                if let info, info.pairingOpen, let url = info.pairingURL,
                   let image = RemotePairingQR.shared.image(for: url) {
                    Image(decorative: image, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: metrics.size(CGFloat(RemotePairingQR.minimumSide)),
                               height: metrics.size(CGFloat(RemotePairingQR.minimumSide)))
                        .clipShape(RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                        .accessibilityElement()
                        .accessibilityLabel(Text("remote.pairing.qr"))
                        .accessibilityIdentifier("remote.pairing.qr")
                    Text(String(format: String(localized: "remote.pairing.countdown"), info.pairingExpiresIn))
                        .font(metrics.font(.footnote).monospacedDigit())
                        .foregroundStyle(theme[.textSecondary])
                        .accessibilityIdentifier("remote.pairing.countdown")
                } else {
                    Text("remote.pairing.closedHint")
                        .font(metrics.font(.footnote))
                        .foregroundStyle(theme[.textSecondary])
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("remote.pairing.closed")
                    Button("remote.pairing.reopen") { remote.openPairing() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("remote.pairing.reopen")
                }
            }
            .frame(width: metrics.size(CGFloat(RemotePairingQR.minimumSide)),
                   height: metrics.size(CGFloat(RemotePairingQR.minimumSide) + 28))
            VStack(alignment: .leading, spacing: metrics.space(.l)) {
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Text("remote.pairing.connected")
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textTertiary])
                    Text(String(format: String(localized: "remote.pairing.connectedCount"),
                                info?.connectedDevices ?? 0, info?.maxDevices ?? 1))
                        .font(metrics.font(.title2).monospacedDigit())
                        .accessibilityIdentifier("remote.pairing.connectedCount")
                }
                VStack(alignment: .leading, spacing: metrics.space(.xs)) {
                    Text("remote.pairing.url")
                        .font(metrics.font(.caption))
                        .foregroundStyle(theme[.textTertiary])
                    if let info, info.pairingOpen, let url = info.pairingURL {
                        Text(verbatim: url)
                            .font(metrics.font(.footnote).monospaced())
                            .textSelection(.enabled)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("remote.pairing.urlText")
                        Button(copiedURL == url ? "remote.pairing.copied" : "remote.pairing.copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(url, forType: .string)
                            copiedURL = url
                        }
                        .accessibilityIdentifier("remote.pairing.copy")
                    } else {
                        Text("remote.pairing.urlHidden")
                            .font(metrics.font(.footnote))
                            .foregroundStyle(theme[.textTertiary])
                    }
                }
                Text("remote.pairing.hint")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(metrics.space(.l))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
    }

    private func devices(_ info: RemoteInfo?) -> some View {
        let devices = info?.devices ?? []
        return VStack(alignment: .leading, spacing: metrics.space(.s)) {
            HStack {
                Text("remote.pairing.devices").font(metrics.font(.headline))
                Spacer()
                if !devices.isEmpty {
                    Button("remote.pairing.revokeAll", role: .destructive) { remote.revokeAll() }
                        .accessibilityIdentifier("remote.pairing.revokeAll")
                }
            }
            if devices.isEmpty {
                Text("remote.pairing.noDevices")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
                    .accessibilityIdentifier("remote.pairing.noDevices")
            } else {
                ForEach(devices) { device in
                    DeviceRow(device: device) { remote.revoke(deviceID: device.id) }
                }
            }
        }
    }

    private func footer(enabled: Bool) -> some View {
        HStack {
            Button("remote.pairing.openSettings") {
                environment.settingsTab = .remote
                openSettings()
                dismiss()
            }
            .buttonStyle(.link)
            .accessibilityIdentifier("remote.pairing.openSettings")
            Spacer()
            Button(enabled ? "remote.pairing.turnOff" : "remote.pairing.turnOn") {
                remote.setEnabled(!enabled)
            }
            .accessibilityIdentifier("remote.pairing.toggle")
            Button("remote.pairing.done") { dismiss() }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("remote.pairing.done")
        }
    }
}

/// A paired device: name, online or idle, when its session expires, and Revoke. The address stays in
/// Settings, hidden until revealed.
private struct DeviceRow: View {
    let device: RemoteDeviceInfo
    let revoke: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.space(.m)) {
            Circle()
                .fill(device.online ? theme[.statusActive] : theme[.statusIdle])
                .frame(width: metrics.size(6), height: metrics.size(6))
            VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                Text(verbatim: device.name).font(metrics.font(.body))
                Text(String(format: String(localized: device.online ? "remote.pairing.online" : "remote.pairing.idle"),
                            device.expiresAt.formatted(date: .omitted, time: .shortened)))
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textTertiary])
            }
            Spacer()
            Button("remote.pairing.revoke", role: .destructive, action: revoke)
                .accessibilityIdentifier("remote.pairing.revoke.\(device.id)")
        }
        .padding(.vertical, metrics.space(.xxs))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote.pairing.device.\(device.id)")
    }
}
