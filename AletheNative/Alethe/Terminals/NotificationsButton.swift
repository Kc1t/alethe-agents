import AletheDesign
import AletheModel
import SwiftUI

/// Toolbar bell with the recent notifications (upstream notifications list): a count of the ones not
/// seen yet; clicking an entry jumps to its tab.
struct NotificationsButton: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var showsList = false

    private var notifier: AgentNotifier { environment.notifier }

    var body: some View {
        Button {
            showsList.toggle()
            notifier.markSeen()
        } label: {
            Image(systemName: notifier.log.unseen > 0 ? "bell.badge" : "bell")
        }
        .help(Text("notifications.title"))
        .accessibilityLabel(Text(notifier.log.unseen > 0
            ? String(format: String(localized: "notifications.unseen"), notifier.log.unseen)
            : String(localized: "notifications.title")))
        .accessibilityIdentifier("notifications.button")
        .popover(isPresented: $showsList, arrowEdge: .bottom) {
            NotificationList()
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
    }
}

/// The recent notifications, newest first; also shown on Home (P3-15).
struct NotificationList: View {
    var isHome = false
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let entries = environment.notifier.log.entries
        VStack(alignment: .leading, spacing: metrics.space(.s)) {
            HStack {
                Text("notifications.title").font(metrics.font(.headline))
                if !entries.isEmpty { AletheCountPill(entries.count) }
                Spacer()
                if !entries.isEmpty {
                    Button("notifications.clear") { environment.notifier.clear() }
                        .buttonStyle(.link)
                }
            }
            if entries.isEmpty {
                Label("notifications.none", systemImage: "checkmark.circle.fill")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.statusActive])
                Text("home.notifications.emptyDetail")
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textTertiary])
            }
            ForEach(entries.prefix(isHome ? 5 : entries.count)) { entry in
                Button {
                    if let tab = entry.tab { environment.notifier.open(tab) }
                    dismiss()
                } label: {
                    HStack(alignment: .top, spacing: metrics.space(.s)) {
                        Image(systemName: entry.agent == nil ? "bell" : "sparkles")
                            .foregroundStyle(theme[entry.agent.map { AgentTokens.accent(for: $0) } ?? .textTertiary])
                            .frame(width: metrics.size(20))
                        VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                            HStack {
                                Text(verbatim: entry.title).font(metrics.font(.body).weight(.medium))
                                Spacer()
                                Text(entry.createdAt, format: .relative(presentation: .named))
                                    .font(metrics.font(.caption))
                                    .foregroundStyle(theme[.textTertiary])
                            }
                            Text(verbatim: entry.body)
                                .font(metrics.font(.footnote))
                                .foregroundStyle(theme[.textSecondary])
                                .lineLimit(2)
                        }
                    }
                    .padding(metrics.space(.s))
                    .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("notifications.entry")
            }
        }
        .padding(metrics.space(.l))
        .frame(width: isHome ? nil : metrics.size(340))
        .frame(maxWidth: isHome ? .infinity : nil)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notifications.list")
    }
}
