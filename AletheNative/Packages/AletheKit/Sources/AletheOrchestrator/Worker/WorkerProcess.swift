import Darwin
import Foundation
import AletheFoundation
import AletheIntegrations

public enum WorkerProcessError: Error, Hashable, Sendable, CustomStringConvertible {
    case pipe(errno: Int32)
    case spawn(errno: Int32)

    /// Upstream's wording (`worker spawn failed: …`).
    public var description: String {
        switch self {
        case .pipe(let code): "worker spawn failed: \(String(cString: strerror(code)))"
        case .spawn(let code): "worker spawn failed: \(String(cString: strerror(code)))"
        }
    }
}

/// One worker CLI (upstream: the `Child` a job holds). Started in the job's folder as the leader of
/// its own process group, stdin and stdout on close-on-exec pipes, stderr discarded like upstream.
/// Its stdout arrives as `lines`, one JSON value per line (invalid lines skipped, EOF ends it); its
/// stdin is `writer`, which never blocks the caller's isolation. `terminate()` always ends and reaps
/// the whole group; a process dropped without it is killed as a last resort.
public actor WorkerProcess {
    /// SIGTERM, then SIGKILL after this long (upstream kills at once; the grace lets a CLI save its
    /// session so an interrupted job can resume).
    public static let terminationGrace: Duration = .seconds(2)

    public nonisolated let pid: pid_t
    public nonisolated let kind: String
    public nonisolated let jobID: String?
    public nonisolated let lines: AsyncStream<OrderedJSON>
    public nonisolated let writer: WorkerLineWriter

    private let registry: WorkerRegistry?
    private let grace: Duration
    /// The leader's wait status once reaped.
    public private(set) var exitStatus: Int32?
    private var stopping = false
    private var stopped = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private init(pid: pid_t, kind: String, jobID: String?, lines: AsyncStream<OrderedJSON>, writer: WorkerLineWriter,
                 registry: WorkerRegistry?, grace: Duration) {
        self.pid = pid
        self.kind = kind
        self.jobID = jobID
        self.lines = lines
        self.writer = writer
        self.registry = registry
        self.grace = grace
    }

    deinit {
        guard !stopped, exitStatus == nil else { return }
        // Dropped without `terminate()`: nothing may outlive its owner. Reaped off-thread.
        WorkerProcessTable.killTree(leader: pid, leaderAlive: true)
        let pid = pid
        DispatchQueue.global(qos: .utility).async {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0, errno == EINTR {}
        }
        registry?.remove(pid: pid)
    }

    /// Starts `launcher` in `directory`. `arguments` defaults to the launcher's own; `environment` is
    /// the whole environment of the child (see `WorkerEnvironment.make`). The spawn is recorded in the
    /// spawn log with variable names only, and in `registry` so a crash never leaves it running.
    public static func spawn(
        _ launcher: Launcher,
        in directory: URL,
        arguments: [String]? = nil,
        environment: [String: String],
        jobID: String? = nil,
        registry: WorkerRegistry? = nil,
        grace: Duration = WorkerProcess.terminationGrace
    ) throws(WorkerProcessError) -> WorkerProcess {
        let arguments = arguments ?? launcher.arguments
        let program = launcher.program.path(percentEncoded: false)
        let cwd = directory.path(percentEncoded: false)
        // Names only: values may be tokens.
        let names = launcher.environment.keys.sorted().joined(separator: ",")
        let summary = "kind=\(launcher.kind) job=\(jobID ?? "-") cwd=\(cwd) executable=\(program) "
            + "args=[\(arguments.joined(separator: " "))] env=[\(names)]"

        let spawned: (pid: pid_t, stdin: Int32, stdout: Int32)
        do {
            spawned = try spawnGroupLeader(program: program, arguments: arguments, directory: cwd, environment: environment)
        } catch {
            Diagnostics.shared.recordSpawn("worker failed \(summary) error=\(error)", domain: .orchestrator)
            AppLog.record(.error, .orchestrator, "\(launcher.kind) worker did not start: \(error)")
            throw error
        }
        Diagnostics.shared.recordSpawn("worker started pid=\(spawned.pid) \(summary)", domain: .orchestrator)

        let live = WorkerProcessTable.process(spawned.pid)
        if let registry {
            registry.add(WorkerRecord(
                pid: spawned.pid, groupID: spawned.pid,
                executables: Array(Set([live?.executable, URL(filePath: program).resolvingSymlinksInPath().path]
                    .compactMap { $0 })).sorted(),
                startTime: live?.startTime ?? ProcessStartTime(seconds: 0, microseconds: 0),
                jobID: jobID))
        }
        let pid = spawned.pid
        let lines = WorkerLineReader.stream(descriptor: spawned.stdout, label: "\(pid)") { [registry] in
            // By its first line the CLI has settled into its final image (a shebang script is node now).
            if let registry, let executable = WorkerProcessTable.executable(of: pid) {
                registry.noteExecutable(executable, for: pid)
            }
        }
        return WorkerProcess(pid: pid, kind: launcher.kind, jobID: jobID, lines: lines,
                             writer: WorkerLineWriter(descriptor: spawned.stdin, label: "\(pid)"),
                             registry: registry, grace: grace)
    }

    /// Whether the leader still runs (reaps it once it exited). Other members of its group may
    /// outlive it; `terminate()` ends them too.
    public var isRunning: Bool {
        reapIfExited()
        return exitStatus == nil
    }

    /// SIGTERM to the group, SIGKILL to the whole tree after the grace period, then the leader is
    /// reaped (upstream `teardown`: kill + wait). Runs to the end even when the calling task is
    /// cancelled; concurrent calls wait for the same teardown.
    public func terminate() async {
        if stopped { return }
        if stopping {
            await withCheckedContinuation { waiters.append($0) }
            return
        }
        stopping = true
        // An unstructured task does not inherit the caller's cancellation. Not
        // `withTaskCancellationShield`: the compiler references its runtime entry points
        // (`swift_task_cancellationShieldPush/Pop`) strongly, so even behind `#available` the app
        // fails to launch on macOS 26, whose Swift runtime lacks them.
        await Task { await self.teardown() }.value
        stopped = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    private func teardown() async {
        writer.close()
        reapIfExited()
        if exitStatus == nil {
            Darwin.kill(-pid, SIGTERM)
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: grace)
            while clock.now < deadline {
                try? await Task.sleep(for: .milliseconds(25))
                reapIfExited()
                if exitStatus != nil, !groupAlive { break }
            }
        }
        // Survivors: a leader that ignored SIGTERM, or children that outlived it or left the group.
        if exitStatus == nil || groupAlive {
            WorkerProcessTable.killTree(leader: pid, leaderAlive: exitStatus == nil)
        }
        if exitStatus == nil {
            // Right after SIGKILL: this wait is brief.
            var status: Int32 = 0
            var result: pid_t
            repeat { result = waitpid(pid, &status, 0) } while result < 0 && errno == EINTR
            exitStatus = result == pid ? status : -1
        }
        registry?.remove(pid: pid)
        Diagnostics.shared.recordSpawn("worker ended pid=\(pid) kind=\(kind) job=\(jobID ?? "-") status=\(exitStatus ?? -1)",
                                       domain: .orchestrator)
    }

    /// Anyone left in the group once the leader is gone.
    private var groupAlive: Bool {
        Darwin.kill(-pid, 0) == 0
    }

    private func reapIfExited() {
        guard exitStatus == nil else { return }
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid {
            exitStatus = status
        } else if result < 0, errno == ECHILD {
            exitStatus = -1
        }
    }

    /// `posix_spawn` with a new process group led by the child, stdin/stdout on pipes whose parent
    /// ends are close-on-exec (and never raise SIGPIPE), stderr on `/dev/null`, no other inherited
    /// descriptor, default signal dispositions and an empty mask.
    static func spawnGroupLeader(program: String, arguments: [String], directory: String,
                                 environment: [String: String]) throws(WorkerProcessError) -> (pid: pid_t, stdin: Int32, stdout: Int32) {
        var input: [Int32] = [-1, -1]
        var output: [Int32] = [-1, -1]
        guard pipe(&input) == 0 else { throw .pipe(errno: errno) }
        guard pipe(&output) == 0 else {
            let code = errno
            Darwin.close(input[0]); Darwin.close(input[1])
            throw .pipe(errno: code)
        }
        for fd in input + output { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        _ = fcntl(input[1], F_SETNOSIGPIPE, 1)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, input[0], 0)
        posix_spawn_file_actions_adddup2(&actions, output[1], 1)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addchdir(&actions, directory)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setpgroup(&attributes, 0)
        var noSignals = sigset_t()
        sigemptyset(&noSignals)
        posix_spawnattr_setsigmask(&attributes, &noSignals)
        var allSignals = sigset_t()
        sigfillset(&allSignals)
        posix_spawnattr_setsigdefault(&attributes, &allSignals)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK
                                                    | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT))

        let argv = [program] + arguments
        let envp = environment.map { "\($0.key)=\($0.value)" }
        var pid: pid_t = 0
        let result = withCStrings(argv) { cArgv in
            withCStrings(envp) { cEnvp in posix_spawn(&pid, program, &actions, &attributes, cArgv, cEnvp) }
        }
        Darwin.close(input[0])
        Darwin.close(output[1])
        guard result == 0 else {
            Darwin.close(input[1])
            Darwin.close(output[0])
            throw .spawn(errno: result)
        }
        return (pid, input[1], output[0])
    }
}

/// Reads a worker's stdout on its own thread: one JSON value per line, blank and invalid lines
/// skipped, the stream finished at EOF. `onFirstLine` runs once, before the first value is yielded.
enum WorkerLineReader {
    static func stream(descriptor: Int32, label: String,
                       onFirstLine: @escaping @Sendable () -> Void) -> AsyncStream<OrderedJSON> {
        let (stream, continuation) = AsyncStream.makeStream(of: OrderedJSON.self)
        let thread = Thread {
            var pending: [UInt8] = []
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            var first = true
            func emit(_ line: ArraySlice<UInt8>) {
                if first { first = false; onFirstLine() }
                guard let value = parse(line) else { return }
                continuation.yield(value)
            }
            while true {
                let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { break }
                pending.append(contentsOf: buffer.prefix(count))
                var start = pending.startIndex
                while let newline = pending[start...].firstIndex(of: 0x0A) {
                    emit(pending[start..<newline])
                    start = newline + 1
                }
                pending.removeSubrange(..<start)
            }
            if !pending.isEmpty { emit(pending[...]) }
            Darwin.close(descriptor)
            continuation.finish()
        }
        thread.name = "alethe.orchestrator.stdout.\(label)"
        thread.start()
        return stream
    }

    static func parse(_ line: ArraySlice<UInt8>) -> OrderedJSON? {
        let text = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return try? OrderedJSON.parse(text)
    }
}

/// Calls `body` with a NULL-terminated C array of `strings`, valid for the call's duration.
private func withCStrings<R>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
    let pointers = strings.map { strdup($0) } + [nil]
    defer { pointers.forEach { free($0) } }
    return body(pointers)
}
