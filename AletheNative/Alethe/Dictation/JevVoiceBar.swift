import AppKit
import AletheDesign
import SwiftUI

/// VoiceCommand.module.css: 58px microphone orb, 21px icon, 12px caption gap, 44px bottom inset.
struct JevVoiceBar: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    @State private var appeared = false

    var body: some View {
        let jev = environment.dictation.jev
        VStack(spacing: metrics.size(12)) {
            if !jev.message.isEmpty {
                VStack(spacing: metrics.size(6)) {
                    Text(verbatim: jev.message).font(metrics.font(size: 13, weight: .semibold))
                        .foregroundStyle(theme[jev.pendingID == nil ? .statusWaiting : .accent])
                    if environment.dictation.machine.phase == .failed(.microphoneDenied) {
                        Button("dictation.openSettings") {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
                            environment.dictation.cancelSession()
                        }
                        .buttonStyle(AletheButtonStyle())
                        .accessibilityIdentifier("dictation.openSettings")
                    }
                    HStack(spacing: metrics.size(8)) {
                        if jev.pendingID != nil {
                            Button("jev.run") { jev.confirm() }.buttonStyle(AletheButtonStyle(.primary))
                                .accessibilityIdentifier("jev.run")
                        }
                        Button("jev.cancel") { environment.dictation.cancelSession() }
                            .buttonStyle(AletheButtonStyle())
                            .accessibilityIdentifier("jev.cancel")
                    }
                }
                .padding(.vertical, metrics.size(20)).padding(.horizontal, metrics.size(24))
                .frame(minWidth: metrics.size(280), maxWidth: metrics.size(420))
                .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(32)))
                .overlay(RoundedRectangle(cornerRadius: metrics.size(32)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .overlay { JevVoiceBorder() }
            }
            Button { environment.dictation.toggleVoice() } label: {
                Image(systemName: "mic").font(metrics.font(size: 21))
                    .foregroundStyle(theme[jev.listening ? .accent : .fg])
                    .frame(width: metrics.size(58), height: metrics.size(58))
                    .background(theme[.bgElevated], in: Circle())
                    .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            }
            .buttonStyle(.plain)
            .disabled(!environment.dictation.settings.enabled || environment.dictation.machine.phase == .finishing)
            .accessibilityLabel(Text(jev.listening ? "jev.stop" : "jev.listen"))
            .accessibilityIdentifier("jev.microphone")
            if !environment.dictation.settings.enabled {
                Text("jev.enable").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            } else if !environment.dictation.liveText.isEmpty || !jev.heard.isEmpty {
                Text(verbatim: environment.dictation.liveText.isEmpty ? jev.heard : environment.dictation.liveText)
                    .font(metrics.font(size: 11)).lineLimit(2).foregroundStyle(theme[.fgMuted])
            } else {
                Text("jev.hint").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            }
        }
        .frame(maxWidth: metrics.size(520))
        .padding(.bottom, metrics.size(44))
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : metrics.size(8))
        .animation(metrics.reducesMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.28), value: appeared)
        .onAppear { appeared = true }
        .accessibilityIdentifier("jev.voiceBar")
    }
}
