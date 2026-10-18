import AletheFoundation
import AletheGit
import AletheIntegrations
import AletheOrchestrator
import Foundation
import Observation

/// Multi-agent services of the app (ORC-3; upstream `event_bus.rs`, `telemetry.rs` and the
/// `.planning/` watchers and audit of `planning.rs`): owns the event bus and its telemetry, publishes
/// `PlanningUpdated` for the projects the scheduler or autocommit follow, and runs the planning audit
/// and its opt-in autocommit. The scheduler (P6-20, P6-22) and autocommit subscribe to `bus` themselves.
/// Settings › Multiagent picks the project both work on (`focus`).
@Observable
@MainActor
final class MultiagentController {
    /// Who asked for a project's `.planning/` to be watched; the watcher stops when nobody does.
    enum PlanningFollower: Hashable, Sendable {
        case scheduler, autocommit, projectPreference
    }

    enum FollowError: Error, Equatable {
        /// Upstream `repository_root` fails outside a git checkout.
        case notARepository
    }

    let bus = EventBus()
    @ObservationIgnored private(set) var telemetry = Telemetry()
    @ObservationIgnored private var telemetryTask: Task<Void, Never>?
    @ObservationIgnored private let watchers = PlanningWatchers()
    /// Per watched `(project, repository root)`: its followers and the task forwarding its changes.
    @ObservationIgnored private var followed: [WatchKey: (followers: Set<PlanningFollower>, task: Task<Void, Never>)] = [:]
    private(set) var isStarted = false
    /// Planning audit commits and history, publishing `PlanningCommitted` on `bus`.
    @ObservationIgnored let planningAudit: PlanningAudit
    @ObservationIgnored private var autocommit: PlanningAutocommit?
    /// Off at every launch, like upstream; not a preference.
    private(set) var isAutocommitEnabled = false
    /// `.planning/task.md` chains per project, in memory like upstream; ticks on request and, once
    /// started, on `PlanningUpdated`.
    @ObservationIgnored let scheduler: Scheduler
    /// The project Settings › Multiagent works on: the scheduler follows its `.planning/`, and
    /// autocommit does too while on. Kept when the Settings window closes, like upstream's watchers.
    private(set) var focusedProject: FocusedProject?

    struct FocusedProject: Equatable, Sendable {
        var id: String
        var folder: URL
    }

    init() {
        planningAudit = PlanningAudit(bus: bus)
        scheduler = Scheduler(bus: bus)
    }

    private struct WatchKey: Hashable {
        var projectID: String
        var root: URL
    }

    /// Starts telemetry, writing `telemetry.jsonl` into `logs`.
    func start(logs: URL) async {
        guard !isStarted else { return }
        isStarted = true
        telemetry = Telemetry(logsDirectory: logs)
        telemetryTask = await telemetry.follow(bus)
        let autocommit = PlanningAutocommit(bus: bus, audit: planningAudit)
        self.autocommit = autocommit
        await autocommit.start()
        await scheduler.startAutoTick(on: bus)
    }

    /// Turns planning autocommit on or off for this launch (upstream `set_planning_autocommit`).
    /// The focused project's `.planning/` is followed for autocommit while it is on.
    func setAutocommit(_ enabled: Bool) async {
        isAutocommitEnabled = enabled
        await autocommit?.setEnabled(enabled)
        guard let project = focusedProject else { return }
        if enabled {
            try? await follow(projectID: project.id, folder: project.folder, by: .autocommit)
        } else {
            await unfollow(projectID: project.id, folder: project.folder, by: .autocommit)
        }
    }

    /// Makes `project` the one the scheduler (and autocommit, while on) follows, dropping the
    /// previous one; nil drops both. Throws `FollowError.notARepository` outside a git checkout,
    /// with the project still focused so its (empty) queue and history show.
    func focus(_ project: FocusedProject?) async throws {
        guard project != focusedProject else { return }
        if let previous = focusedProject {
            await unfollow(projectID: previous.id, folder: previous.folder, by: .scheduler)
            await unfollow(projectID: previous.id, folder: previous.folder, by: .autocommit)
        }
        focusedProject = project
        guard let project else { return }
        try await follow(projectID: project.id, folder: project.folder, by: .scheduler)
        if isAutocommitEnabled {
            try await follow(projectID: project.id, folder: project.folder, by: .autocommit)
        }
    }

    func stop() async {
        await scheduler.stopAutoTick()
        focusedProject = nil
        await autocommit?.stop()
        autocommit = nil
        isAutocommitEnabled = false
        for entry in followed.values { entry.task.cancel() }
        followed.removeAll()
        let watchers = watchers
        await Task.detached { watchers.stopAll() }.value
        await bus.finishAll()
        telemetryTask = nil
        isStarted = false
    }

    /// Watches the `.planning/` folder of the checkout containing `folder` for `follower`
    /// (upstream `start_gsd_watcher`). Each burst of changes publishes `PlanningUpdated` with the
    /// project as task id and `{action, planning_dir}` as data, like upstream.
    func follow(projectID: String, folder: URL, by follower: PlanningFollower) async throws {
        let watchers = watchers
        let started = try await Task.detached { () throws -> (root: URL, watcher: GitWatcher) in
            guard let root = PlanningGate.repositoryRoot(containing: folder) else { throw FollowError.notARepository }
            return (root, try watchers.start(projectID: projectID, root: root))
        }.value
        let key = WatchKey(projectID: projectID, root: started.root)
        if var entry = followed[key] {
            entry.followers.insert(follower)
            followed[key] = entry
            return
        }
        let planningDir = PlanningGate.planningFolder(of: started.root).standardizedFileURL.path
        let bus = bus
        let events = started.watcher.events
        let task = Task.detached {
            for await _ in events {
                await bus.publish(BusEventType.planningUpdated, correlationID: BusEvent.correlationID(prefix: "gsd"),
                                  taskID: projectID,
                                  data: .object(["action": .string("Modify"), "planning_dir": .string(planningDir)]))
            }
        }
        followed[key] = ([follower], task)
    }

    /// Drops `follower`'s interest; the watcher stops when no follower is left (upstream `stop_gsd_watcher`).
    func unfollow(projectID: String, folder: URL, by follower: PlanningFollower) async {
        let root = await Task.detached { PlanningGate.repositoryRoot(containing: folder) }.value
        guard let root else { return }
        let key = WatchKey(projectID: projectID, root: root)
        guard var entry = followed[key] else { return }
        entry.followers.remove(follower)
        guard entry.followers.isEmpty else {
            followed[key] = entry
            return
        }
        followed.removeValue(forKey: key)
        entry.task.cancel()
        let watchers = watchers
        await Task.detached { watchers.stop(projectID: projectID, root: root) }.value
    }

    func isFollowing(projectID: String, by follower: PlanningFollower) -> Bool {
        followed.contains { $0.key.projectID == projectID && $0.value.followers.contains(follower) }
    }
}
