import AletheAgents
import AletheModel
import Foundation
import Observation

/// AI usage of Claude Code, Codex and Antigravity (upstream `*UsageCache.ts`, `limitResetWatch.ts`):
/// fetched every 5 minutes for the providers the user shows, and whenever the AI Usage sheet opens. A
/// window that was at its limit and has reset raises a notification.
@Observable
@MainActor
final class UsageMonitor {
    static let providers: [AgentKind] = [.claude, .codex, .antigravity]

    private(set) var usage: [AgentKind: ProviderUsage] = [:]
    private(set) var refreshing: Set<AgentKind> = []
    private(set) var authenticated: Set<AgentKind> = []
    private(set) var stale: Set<AgentKind> = []
    @ObservationIgnored private var lastRefresh: [AgentKind: Date] = [:]
    @ObservationIgnored private weak var environment: AppEnvironment?
    @ObservationIgnored private var loop: Task<Void, Never>?

    func start(environment: AppEnvironment) {
        self.environment = environment
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                if let self {
                    let providers = self.shownProviders
                    let detected = await Task.detached {
                        Set(providers.filter { AIUsage.isAuthenticated($0) })
                    }.value
                    let newlySignedIn = detected.subtracting(self.authenticated)
                    self.authenticated = detected
                    for provider in Self.providers where !detected.contains(provider) {
                        self.usage[provider] = nil
                        self.stale.remove(provider)
                        self.lastRefresh[provider] = nil
                    }
                    await self.refresh(providers.filter {
                        detected.contains($0) && (newlySignedIn.contains($0) ||
                            Date().timeIntervalSince(self.lastRefresh[$0] ?? .distantPast) >= 300)
                    })
                }
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    /// The persisted toolbar choice also gates credential discovery and network access.
    var shownProviders: [AgentKind] {
        let shown = Set(environment?.preferences?.document.usagePillProviders ?? [])
        return Self.providers.filter { shown.contains($0.rawValue) }
    }

    func refresh(_ providers: [AgentKind] = UsageMonitor.providers) async {
        guard let environment else { return }
        var jobs: [(AgentKind, String?)] = []
        for provider in providers where shownProviders.contains(provider) && !refreshing.contains(provider) {
            refreshing.insert(provider)
            let executable = AgentRegistry.builtin.descriptor(for: provider)?.cliCommand.flatMap {
                environment.launchers.resolve($0, override: environment.preferences?.document.cliPaths?[provider.rawValue])
            }
            jobs.append((provider, executable))
        }
        await withTaskGroup(of: ProviderUsage.self) { group in
            for (provider, executable) in jobs {
                group.addTask { await Self.fetch(provider, executable: executable) }
            }
            for await fresh in group { store(fresh) }
        }
    }

    nonisolated private static func fetch(_ provider: AgentKind, executable: String?) async -> ProviderUsage {
        switch provider {
        case .claude: await AIUsage.claude()
        case .codex: await AIUsage.codex(executable: executable)
        default: await AIUsage.antigravity(executable: executable)
        }
    }

    func showsPill(_ provider: AgentKind) -> Bool {
        AIUsage.showsPill(authenticated: authenticated.contains(provider), enabled: shownProviders.contains(provider))
    }

    func consumeResetCredit(_ credit: CodexResetCredit?) async -> Bool {
        guard let environment, let executable = environment.launchers.resolve("codex", override: environment.preferences?.document.cliPaths?["codex"]),
              let fresh = await AIUsage.consumeCodexResetCredit(executable: executable, credit: credit?.id) else { return false }
        store(fresh)
        return true
    }

    private func store(_ fresh: ProviderUsage) {
        refreshing.remove(fresh.agent)
        guard shownProviders.contains(fresh.agent) else { return }
        lastRefresh[fresh.agent] = Date()
        if fresh.status == .ready { authenticated.insert(fresh.agent) }
        if case .unavailable = fresh.status { stale.insert(fresh.agent) }
        else { stale.remove(fresh.agent) }
        if let previous = usage[fresh.agent], fresh.status == .ready,
           environment?.preferences?.document.notifyLimitReset != false {
            for window in AIUsage.resets(from: previous, to: fresh) {
                environment?.notifier.post(
                    title: String(format: String(localized: "usage.limitReset"), AgentLabels.name(for: fresh.agent.rawValue)),
                    body: String(format: String(localized: "usage.limitReset.body"), window.label), agent: fresh.agent.rawValue)
            }
        }
        // A failed refresh keeps the last good figures.
        usage[fresh.agent] = AIUsage.retainedReading(previous: usage[fresh.agent], fresh: fresh)
    }
}
