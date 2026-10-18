import AletheFoundation
import AletheModel
import AletheTerminal
import Dispatch
import Foundation
import Observation

/// Watches memory (upstream `useResourceSupervisor` + `resources.rs`): every 5 s — and at once when
/// macOS reports memory pressure — it measures each terminal's process tree, rates the system's
/// pressure, lowers the priority of terminals kept off screen and, when the user's policy allows,
/// hibernates idle hidden ones.
@Observable
@MainActor
final class ResourceMonitor {
    struct TerminalUsage: Identifiable, Equatable {
        let tab: TabID
        let memoryMB: Double
        var id: TabID { tab }
    }

    /// One supervision reading, kept for the memory analytics history (web `MemorySample`).
    struct Sample: Identifiable, Equatable {
        let timestamp: Date
        let appMB: Double
        let terminalsMB: Double
        let systemAvailableMB: Double
        let systemTotalMB: Double
        let processCount: Int
        var totalMB: Double { appMB + terminalsMB }
        var id: Date { timestamp }
    }

    /// The latest readings, oldest first (web `MAX_MEMORY_HISTORY`).
    private(set) var history: [Sample] = []
    static let historyLimit = 720

    func clearHistory() { history = [] }

    private(set) var pressure: MemoryPressure = .normal
    private(set) var system = SystemResources.Memory(totalMB: 0, availableMB: 0)
    private(set) var appMB: Double = 0
    /// Running terminals, largest first.
    private(set) var terminals: [TerminalUsage] = []
    /// Terminals that could be hibernated now under the current policy's idle limits.
    private(set) var candidateCount = 0

    var terminalsMB: Double { terminals.reduce(0) { $0 + $1.memoryMB } }

    static let interval: Duration = .seconds(5)

    @ObservationIgnored private weak var environment: AppEnvironment?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var pressureSource: DispatchSourceMemoryPressure?
    @ObservationIgnored private var sampling = false
    @ObservationIgnored private var background: Set<TabID> = []
    @ObservationIgnored private var lastUsed: [TabID: Date] = [:]
    /// Pressure level changes so far (upstream `policy_trigger_count`).
    @ObservationIgnored private var pressureChanges = 0
    /// `ResourceMetricsUpdated` after every pass (P6-19).
    @ObservationIgnored private let events = EventOutbox()

    func start(environment: AppEnvironment) {
        guard loop == nil else { return }
        self.environment = environment
        events.attach(environment.multiagent.bus)
        loop = Task { [weak self] in
            while !Task.isCancelled {
                self?.check()
                try? await Task.sleep(for: Self.interval)
            }
        }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.check() }
        }
        source.resume()
        pressureSource = source
    }

    /// One supervision pass (upstream `run_cycle`).
    func check() {
        guard !sampling, let environment, let workspace = environment.workspace else { return }
        sampling = true
        let processes = environment.terminals.running.map { $0.view.processID }
        Task {
            defer { sampling = false }
            let sample = await Task.detached(priority: .utility) {
                let parents = ProcessTree.currentParents()
                var memory: [pid_t: Double] = [:]
                var counts: [pid_t: Int] = [:]
                for pid in processes where pid > 0 {
                    let descendants = ProcessTree.descendants(of: pid, parents: parents)
                    counts[pid] = descendants.count
                    memory[pid] = descendants.reduce(0) { $0 + SystemResources.footprintMB(of: $1) }
                }
                return Reading(parents: parents, memory: memory, counts: counts,
                              system: SystemResources.memory(), appMB: SystemResources.footprintMB(of: getpid()))
            }.value
            guard environment.workspace === workspace else { return }
            apply(sample, environment: environment, document: workspace.document)
        }
    }

    private struct Reading: Sendable {
        let parents: [pid_t: pid_t]
        let memory: [pid_t: Double]
        let counts: [pid_t: Int]
        let system: SystemResources.Memory
        let appMB: Double
    }

    private func apply(_ sample: Reading, environment: AppEnvironment, document: WorkspaceDocument) {
        let policy = environment.preferences?.document.resources ?? ResourcePolicy()
        let running = environment.terminals.running
        let parents = sample.parents
        let mounted = document.mountedTabIDs
        let focused = document.workspace.focusedPaneID.flatMap { document.pane($0)?.pane.activeTab?.id }
        let now = Date()
        for tab in mounted { lastUsed[tab] = now }

        var runtimes: [TerminalRuntime] = []
        var usage: [TerminalUsage] = []
        var processCount = 1  // the app, like upstream's walk
        for (tab, view) in running {
            // A terminal spawned during sampling belongs to the next pass.
            guard view.processID <= 0 || sample.memory[view.processID] != nil else { continue }
            let memory = sample.memory[view.processID] ?? 0
            if view.processID > 0 { processCount += sample.counts[view.processID] ?? 0 }
            usage.append(TerminalUsage(tab: tab, memoryMB: memory))
            let quiet = Double(view.quietFor.components.seconds)
            runtimes.append(TerminalRuntime(
                tab: tab, isShell: document.paneHolding(tab)?.pane.tabs.first { $0.id == tab }?.agent == "shell",
                isMounted: mounted.contains(tab), isFocused: tab == focused,
                lastOutput: now.timeIntervalSince1970 - quiet, startedAt: view.startedAt.timeIntervalSince1970,
                lastUsed: (lastUsed[tab] ?? view.startedAt).timeIntervalSince1970, memoryMB: memory))

            // Off-screen terminals run in the background band; shown again, they get full priority.
            let off = !mounted.contains(tab)
            if off != background.contains(tab) {
                SystemResources.setBackground(off, tree: view.processID, parents: parents)
                if off { background.insert(tab) } else { background.remove(tab) }
            }
        }
        let runningTabs = Set(running.map(\.tab))
        background.formIntersection(runningTabs)
        lastUsed = lastUsed.filter { runningTabs.contains($0.key) }

        system = sample.system
        appMB = sample.appMB
        let previous = pressure
        pressure = MemoryPressure.level(availableMB: system.availableMB, totalMB: system.totalMB, previous: pressure)
        if pressure != previous { pressureChanges += 1 }
        terminals = usage.sorted { $0.memoryMB > $1.memoryMB }
        history.append(Sample(timestamp: now, appMB: appMB, terminalsMB: terminalsMB,
                              systemAvailableMB: system.availableMB, systemTotalMB: system.totalMB,
                              processCount: processCount))
        if history.count > Self.historyLimit { history.removeFirst(history.count - Self.historyLimit) }
        let candidates = ResourceSupervision.candidates(runtimes, policy: policy, now: now.timeIntervalSince1970)
        candidateCount = candidates.count
        events.publish(.resourceMetrics(
            memoryPressure: Self.upstreamLevel(pressure), systemAvailableMB: system.availableMB,
            systemTotalMB: system.totalMB, appMB: appMB, ptysMB: terminalsMB, processCount: processCount,
            policyTriggerCount: pressureChanges))

        guard ResourceSupervision.mayHibernate(pressure, policy: policy) else { return }
        // Under pressure one per pass, like upstream; in idle mode every candidate.
        for tab in policy.mode == .idle ? candidates : Array(candidates.prefix(1)) {
            environment.terminals.hibernate(tab)
        }
    }

    /// Upstream's level name for each of the three native levels.
    static func upstreamLevel(_ pressure: MemoryPressure) -> String {
        switch pressure {
        case .normal: "Ok"
        case .warning: "Medium"
        case .critical: "Critical"
        }
    }
}
