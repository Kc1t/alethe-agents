import AletheAgents
import AletheModel
import AppKit
import Observation
import UserNotifications

/// Agent notifications (upstream `notifications.ts`, `notifyAgentDone`): when an agent finishes or
/// needs an answer and its tab is not in front, an entry joins the in-app list; when Alethe itself is
/// in the background, macOS shows a notification too. Clicking either jumps to the tab.
@Observable
@MainActor
final class AgentNotifier: NSObject, UNUserNotificationCenterDelegate {
    private(set) var log = NotificationLog()
    /// Ephemeral in-app banners (upstream `uiStore.toasts`): the newest four.
    private(set) var toasts: [InAppToast] = []
    static let maximumToasts = 4
    @ObservationIgnored private weak var environment: AppEnvironment?
    @ObservationIgnored private var permission: Bool?

    func start(environment: AppEnvironment) {
        self.environment = environment
        UNUserNotificationCenter.current().delegate = self
        environment.terminals.onActivityChange = { [weak self] tab, activity, event in
            self?.agent(tab, became: activity, event: event)
        }
    }

    private func agent(_ tab: TabID, became activity: AgentActivity, event: AgentHookEvent?) {
        guard activity == .done || activity == .needsInput, let environment,
              environment.preferences?.document.notifyAgents != false,
              !environment.terminals.isInFront(tab),
              let document = environment.workspace?.document, let (project, pane) = document.paneHolding(tab),
              let item = pane.tabs.first(where: { $0.id == tab }) else { return }
        let agent = AgentLabels.name(for: item.agent)
        let title = String(format: String(localized: activity == .done ? "notify.done" : "notify.needsInput"), agent)
        let name = environment.terminals.displayName(of: item)
        let body = event?.message.flatMap { $0.isEmpty ? nil : String($0.prefix(200)) }
            ?? String(format: String(localized: "notify.body"), name, project.name)
        let entry = AppNotification(title: title, body: body, tab: tab, agent: item.agent)
        guard log.post(entry) else { return }
        pushToast(entry, actions: [])
        if !NSApp.isActive { Task { await deliver(entry) } }
    }

    /// Any other notification (a limit reset, a remote device's message): the list, and macOS when
    /// Alethe is in the background. With `tab`, clicking it jumps there.
    func post(title: String, body: String, agent: String? = nil, tab: TabID? = nil,
              actions: [InAppToast.Action] = [], silent: Bool = false) {
        let entry = AppNotification(title: title, body: body, tab: tab, agent: agent)
        guard log.post(entry) else { return }
        if !silent { pushToast(entry, actions: actions) }
        if !NSApp.isActive { Task { await deliver(entry) } }
    }

    private func pushToast(_ entry: AppNotification, actions: [InAppToast.Action]) {
        let toast = InAppToast(id: entry.id, title: entry.title, body: entry.body, agent: entry.agent, actions: actions)
        toasts = Array((toasts + [toast]).suffix(Self.maximumToasts))
    }

    func dismissToast(_ id: UUID) { toasts.removeAll { $0.id == id } }

    private func deliver(_ entry: AppNotification) async {
        let center = UNUserNotificationCenter.current()
        if permission == nil {
            permission = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        }
        guard permission == true else { return }
        let content = UNMutableNotificationContent()
        content.title = entry.title
        content.body = entry.body
        content.sound = .default
        content.threadIdentifier = entry.tab?.rawValue ?? "alethe"
        if let tab = entry.tab { content.userInfo = ["tab": tab.rawValue] }
        try? await center.add(UNNotificationRequest(identifier: entry.id.uuidString, content: content, trigger: nil))
    }

    /// Shows a notification's tab: its project's tab, the tab in its pane, focused.
    func open(_ tab: TabID) {
        environment?.workspace?.update { doc in
            guard let project = doc.paneHolding(tab)?.project else { return }
            doc.openInTab(project.id)
            doc.activateTab(tab)
        }
        environment?.terminals.markRead(tab)
        NSApp.activate()
    }

    func markSeen() { log.markSeen() }
    func clear() { log.clear() }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let raw = response.notification.request.content.userInfo["tab"] as? String else { return }
        await MainActor.run { open(TabID(rawValue: raw)) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // In front, the in-app list already has it.
        []
    }
}
