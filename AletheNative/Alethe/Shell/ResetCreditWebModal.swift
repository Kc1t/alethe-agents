import AletheAgents
import AletheDesign
import SwiftUI

/// `ResetCreditModal.tsx` / `ResetCreditModal.module.css`: the nested 560-point dialog opened from
/// the Codex card of the AI usage modal. Each credit has its own "Use reset credit" action.
struct ResetCreditWebModal: View {
    let finish: (WebDialogCenter.Outcome) -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var busy = false
    @State private var failure: String?

    private var credits: [CodexResetCredit] { environment.usage.usage[.codex]?.resetCredits ?? [] }

    var body: some View {
        GitWebModal(close: { finish(.cancelled) }, closeIdentifier: "usage.credit.close") {
            Text("usage.web.credit.heading")
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: format("usage.web.credit.info", credits.count))
                    .font(metrics.font(size: 13)).foregroundStyle(theme[.fgMuted])
                    .lineSpacing(metrics.size(3))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, metrics.size(14))
                VStack(spacing: metrics.size(10)) {
                    if credits.isEmpty {
                        useButton(nil)
                    } else {
                        ForEach(credits) { credit in item(credit) }
                    }
                }
                if let failure {
                    Text(verbatim: failure).font(metrics.font(size: 12))
                        .foregroundStyle(theme[.statusOffline]).padding(.top, metrics.size(10))
                        .accessibilityIdentifier("usage.credit.failed")
                }
            }
        } footer: { EmptyView() }
    }

    private func item(_ credit: CodexResetCredit) -> some View {
        HStack(spacing: metrics.size(16)) {
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                Text(verbatim: credit.title.isEmpty ? String(localized: "usage.web.credit.defaultTitle") : credit.title)
                    .font(metrics.font(size: 13)).foregroundStyle(theme[.fg])
                Text(verbatim: credit.detail.isEmpty ? String(localized: "usage.web.credit.defaultDetail") : credit.detail)
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                Text(verbatim: format("usage.web.credit.expires", expiry(credit.expiresAt)))
                    .font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            useButton(credit)
        }
        .padding(metrics.size(12))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private func useButton(_ credit: CodexResetCredit?) -> some View {
        Button {
            guard !busy, !credits.isEmpty || credit == nil else { return }
            busy = true
            failure = nil
            Task {
                let ok = await environment.usage.consumeResetCredit(credit)
                busy = false
                if !ok { failure = String(localized: "usage.web.credit.failedTitle") }
            }
        } label: {
            if busy { Text("usage.web.credit.working") } else { Text("usage.web.credit.use") }
        }
        .buttonStyle(AletheButtonStyle(.primary))
        .disabled(busy)
        .accessibilityIdentifier("usage.credit.use")
    }

    private func expiry(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(.dateTime.day(.twoDigits).month(.abbreviated).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }
}
