import AletheDesign
import SwiftUI

/// VoiceHistoryPanel.module.css: 44px header, 10px content inset, 8px card gap.
struct WebVoiceHistoryPanel: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        if metrics.isWebInterface { history }
        else { NativeVoiceHistoryPanel() }
    }

    private var history: some View {
        let jev = environment.dictation.jev
        return VStack(spacing: 0) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "mic").font(metrics.font(size: 15))
                Text("rightSidebar.jev").font(metrics.font(size: 14, weight: .medium))
                Spacer(minLength: 0)
                Button { jev.clear() } label: {
                    Label("rightSidebar.jev.clear", systemImage: "trash").font(metrics.font(size: 14))
                }
                .buttonStyle(AletheSidebarUtilityStyle())
                .disabled(jev.entries.isEmpty).help(Text("rightSidebar.jev.clear"))
                .accessibilityIdentifier("jev.clear")
            }
            .foregroundStyle(theme[.fg]).padding(.horizontal, metrics.size(10))
            .frame(height: metrics.size(44))
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            ScrollView {
                if jev.entries.isEmpty {
                    VStack(spacing: metrics.size(7)) {
                        Image(systemName: "mic").font(metrics.font(size: 18))
                            .foregroundStyle(theme[.fgFaint])
                            .frame(width: metrics.size(38), height: metrics.size(38))
                            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                            .padding(.bottom, metrics.size(3))
                        Text("rightSidebar.jev.empty").font(metrics.font(size: 12, weight: .bold)).foregroundStyle(theme[.fg])
                        Text("jev.history.emptyBody").font(metrics.font(size: 11))
                            .frame(maxWidth: metrics.size(210))
                    }
                    .multilineTextAlignment(.center).foregroundStyle(theme[.fgMuted])
                    .padding(metrics.size(24)).frame(maxWidth: .infinity, minHeight: metrics.size(220))
                } else {
                    VStack(spacing: metrics.size(8)) {
                        ForEach(jev.entries) { entry in card(entry) }
                    }
                }
            }.padding(metrics.size(10))
        }
        .background(theme[.bg])
        .accessibilityIdentifier("jev.panel")
    }

    private func status(_ status: JevController.Status) -> LocalizedStringKey {
        switch status {
        case .deciding: "jev.history.deciding"
        case .ran: "jev.history.ran"
        case .waiting: "jev.history.waiting"
        case .blocked: "jev.history.blocked"
        case .failed: "jev.history.failed"
        }
    }

    private func card(_ entry: JevController.Entry) -> some View {
        let color: ThemeToken = entry.status == .ran ? .statusWorking : entry.status == .failed ? .statusOffline : .statusWaiting
        return VStack(alignment: .leading, spacing: metrics.size(6)) {
            HStack(spacing: metrics.size(8)) {
                Text(status(entry.status)).textCase(.uppercase)
                    .font(metrics.monoFont(size: 10, weight: .regular))
                    .foregroundStyle(theme[color])
                    .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                    .background(theme[color].opacity(0.12), in: Capsule())
                Spacer(minLength: 0)
                Text(entry.at, format: .dateTime.hour().minute())
                    .font(metrics.monoFont(size: 10, weight: .regular)).foregroundStyle(theme[.fgFaint])
            }
            Text(verbatim: entry.summary).font(metrics.font(size: 13, weight: .medium)).foregroundStyle(theme[.fg])
            Text(verbatim: entry.spoken).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            ForEach(Array(entry.actions.enumerated()), id: \.offset) { _, action in
                HStack(alignment: .top, spacing: metrics.size(6)) {
                    Image(systemName: "checkmark").font(metrics.font(size: 11)).foregroundStyle(theme[.statusWorking])
                    Text(verbatim: action).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10))
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}
