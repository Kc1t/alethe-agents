import CAlethePTY
import Darwin
import Foundation

public struct PTYSize: Hashable, Sendable {
    public var columns: UInt16
    public var rows: UInt16
    public var widthPixels: UInt16
    public var heightPixels: UInt16

    public init(columns: UInt16, rows: UInt16, widthPixels: UInt16 = 0, heightPixels: UInt16 = 0) {
        self.columns = columns
        self.rows = rows
        self.widthPixels = widthPixels
        self.heightPixels = heightPixels
    }
}

public struct PTYLaunch: Sendable {
    public var executable: String
    /// argv, including argv[0].
    public var arguments: [String]
    public var environment: [String: String]
    public var workingDirectory: String?
    public var size: PTYSize

    public init(executable: String, arguments: [String], environment: [String: String],
                workingDirectory: String?, size: PTYSize) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
        self.workingDirectory = workingDirectory
        self.size = size
    }
}

public enum PTYError: Error, Equatable {
    case spawnFailed(errno: Int32)
}

/// A child process on a pseudo-terminal owned by the app (not by the terminal renderer).
///
/// Output is read on a private queue and delivered in chunks of up to 64 KiB — batching before
/// crossing into the renderer is what keeps throughput high. All callbacks run on that queue.
public final class PTYProcess: @unchecked Sendable {
    /// 0 until the child is spawned (see `init(_:spawnNow:)`); never signalled while 0, since
    /// `kill(-0, …)` would hit the app's own process group.
    public private(set) var pid: pid_t = 0
    private var masterFD: Int32 = -1
    private let launch: PTYLaunch
    /// Written before the spawn (typed ahead); flushed once the child exists.
    private var pendingInput: [Data] = []
    /// Terminated before it was ever spawned.
    private var cancelled = false
    private let queue: DispatchQueue
    private var readSource: DispatchSourceRead?
    private var exitSource: DispatchSourceProcess?
    private var scrollback: ScrollbackRing
    private var exited = false

    public var onOutput: (@Sendable (Data) -> Void)?
    public var onExit: (@Sendable (Int32) -> Void)?

    /// `spawnNow: false` waits for `spawn(size:)`, so the child starts at its view's real size: a TUI
    /// that first draws at a placeholder size and then redraws on SIGWINCH leaves fragments behind.
    public init(_ launch: PTYLaunch, scrollbackCapacity: Int = ScrollbackRing.defaultCapacity, spawnNow: Bool = true) throws {
        queue = DispatchQueue(label: "alethe.pty", qos: .userInteractive)
        queue.setSpecific(key: Self.queueKey, value: ObjectIdentifier(queue))
        scrollback = ScrollbackRing(capacity: scrollbackCapacity)
        self.launch = launch
        if spawnNow { try spawnChild(size: launch.size) }
    }

    public var isSpawned: Bool { onQueue { pid > 0 } }

    private static let queueKey = DispatchSpecificKey<ObjectIdentifier>()

    /// Runs on `queue`, directly when already there (callbacks such as `onOutput` run on it).
    private func onQueue<T>(_ body: () -> T) -> T {
        DispatchQueue.getSpecific(key: Self.queueKey) == ObjectIdentifier(queue) ? body() : queue.sync(execute: body)
    }

    /// Spawns the child at `size` and starts reading; no-op once spawned or after `terminate`.
    /// Call after `onOutput`/`onExit` are set.
    public func spawn(size: PTYSize) throws {
        let go = onQueue { pid == 0 && !cancelled }
        guard go else { return }
        try spawnChild(size: size)
        start()
    }

    private func spawnChild(size: PTYSize) throws {
        var master: Int32 = -1
        let env = launch.environment.map { "\($0.key)=\($0.value)" }
        let launch = launch
        let spawned: pid_t = withCStringArray(launch.arguments) { argv in
            withCStringArray(env) { envp in
                alethe_pty_spawn(
                    launch.executable, argv, envp, launch.workingDirectory,
                    size.columns, size.rows, &master
                )
            }
        }
        guard spawned > 0 else { throw PTYError.spawnFailed(errno: errno) }
        onQueue {
            pid = spawned
            masterFD = master
            lastSent = size
            if size.widthPixels > 0 {
                _ = alethe_pty_resize(master, size.columns, size.rows, size.widthPixels, size.heightPixels)
            }
        }
        // Typed ahead of the spawn.
        queue.async { [self] in
            let pending = pendingInput
            pendingInput = []
            pending.forEach(writeNow)
        }
    }

    /// Starts reading. Call after `onOutput`/`onExit` are set so no early output is lost.
    public func start() {
        guard pid > 0 else { return }
        let read = DispatchSource.makeReadSource(fileDescriptor: masterFD, queue: queue)
        read.setEventHandler { [weak self] in self?.drain() }
        read.resume()
        readSource = read

        let exit = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
        exit.setEventHandler { [weak self] in self?.reap() }
        exit.resume()
        exitSource = exit
        // A child that exited before the source was registered never raises its event.
        queue.async { [weak self] in self?.reapIfExited() }
    }

    /// Reaps the child if it already exited; `WNOWAIT` leaves it for `reap`'s `waitpid`.
    private func reapIfExited() {
        guard pid > 0, !exited else { return }
        var info = siginfo_t()
        if waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT) == 0, info.si_pid == pid {
            reap()
        }
    }

    public func write(_ data: Data) {
        queue.async { [self] in
            guard masterFD >= 0 else {
                if !cancelled { pendingInput.append(data) }
                return
            }
            if !pendingInput.isEmpty {
                let pending = pendingInput
                pendingInput = []
                pending.forEach(writeNow)
            }
            // A focus report (`ESC [ I` / `ESC [ O`) reaches a program that asked for them, but one still
            // in cooked mode with echo — starting up — only echoes it back as `^[[I`.
            if Self.isFocusReport(data), echoesInput() { return }
            writeNow(data)
        }
    }

    static func isFocusReport(_ data: Data) -> Bool {
        data == Data([0x1B, 0x5B, 0x49]) || data == Data([0x1B, 0x5B, 0x4F])
    }

    /// The line discipline is canonical and echoing (a shell reading a line, a program before raw mode).
    func echoesInput() -> Bool {
        var attributes = termios()
        guard masterFD >= 0, tcgetattr(masterFD, &attributes) == 0 else { return false }
        return attributes.c_lflag & tcflag_t(ICANON) != 0 && attributes.c_lflag & tcflag_t(ECHO) != 0
    }

    private func writeNow(_ data: Data) {
        let masterFD = masterFD
            data.withUnsafeBytes { raw in
                guard var pointer = raw.baseAddress else { return }
                var remaining = raw.count
                while remaining > 0 {
                    let written = Darwin.write(masterFD, pointer, remaining)
                    if written > 0 {
                        remaining -= written
                        pointer += written
                    } else if written < 0, errno == EAGAIN || errno == EINTR {
                        continue
                    } else {
                        return
                    }
                }
            }
    }

    public func resize(_ size: PTYSize) {
        queue.async { [self] in
            guard masterFD >= 0 else { return }
            applyOnQueue(size)
        }
    }

    private var pendingResize = 0
    /// The size last written to the PTY (spawn or resize). On `queue` only.
    private var lastSent: PTYSize?

    /// On `queue` only. TIOCSWINSZ, then SIGWINCH to the group when the grid changed.
    private func applyOnQueue(_ size: PTYSize) {
        guard masterFD >= 0, !exited else { return }
        let changed = lastSent.map { $0.columns != size.columns || $0.rows != size.rows } ?? false
        lastSent = size
        TerminalResizeLog.write("pty \(pid) TIOCSWINSZ \(size.columns)x\(size.rows)")
        _ = alethe_pty_resize(masterFD, size.columns, size.rows, size.widthPixels, size.heightPixels)
        // The child is a session leader that only gets a controlling terminal if it asks for one
        // (a shell does, an agent started directly does not), and without one the kernel never raises
        // SIGWINCH: the agent would keep drawing at its launch size. Signal the group ourselves.
        if changed, pid > 0 {
            let group = tcgetpgrp(masterFD)
            kill(group > 0 ? -group : -pid, SIGWINCH)
        }
    }

    /// Safety net once a size has settled: writes `size` again (idempotent) and, when it differs
    /// from what the PTY was last given, also signals SIGWINCH to the foreground process group, so
    /// a program that missed or ignored an earlier notification still redraws at the final size.
    public func reassertSize(_ size: PTYSize) {
        queue.async { [self] in
            guard masterFD >= 0, !exited, pid > 0, size.columns > 0, size.rows > 0 else { return }
            TerminalResizeLog.write("pty \(pid) reassert \(size.columns)x\(size.rows) last=\(lastSent.map { "\($0.columns)x\($0.rows)" } ?? "nil")")
            let differs = lastSent.map { $0.columns != size.columns || $0.rows != size.rows } ?? true
            applyOnQueue(size)
            if differs {
                let group = tcgetpgrp(masterFD)
                kill(group > 0 ? -group : -pid, SIGWINCH)
            }
        }
    }

    /// Applies only the last of a burst of sizes, once none arrived for `quiet`. A live split drag
    /// or a spring animation changes the size every frame; each change is a SIGWINCH, and shells
    /// redraw their prompt at every intermediate width, leaving fragments behind.
    public func resizeCoalesced(_ size: PTYSize, quiet: Duration = .milliseconds(80)) {
        let seconds = Double(quiet.components.seconds) + Double(quiet.components.attoseconds) / 1e18
        queue.async { [weak self] in
            guard let self else { return }
            pendingResize += 1
            let ticket = pendingResize
            queue.asyncAfter(deadline: .now() + seconds) { [weak self] in
                guard let self, ticket == pendingResize else { return }
                applyOnQueue(size)
            }
        }
    }

    /// Sends a signal to the child's whole process group (the shell and what it runs).
    public func signal(_ signal: Int32 = SIGHUP) {
        onQueue { signalOnQueue(signal) }
    }

    /// On `queue` only.
    private func signalOnQueue(_ signal: Int32) {
        guard pid > 0 else {
            cancelled = true
            pendingInput = []
            return
        }
        kill(-pid, signal)
    }

    /// Hangs up the process group, then kills it if it is still alive after `grace` (agents that
    /// trap SIGHUP to save state get that long).
    public func terminate(grace: Duration = .seconds(2)) {
        signal(SIGHUP)
        let seconds = Double(grace.components.seconds) + Double(grace.components.attoseconds) / 1e18
        queue.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, !self.exited else { return }
            self.signalOnQueue(SIGKILL)
        }
    }

    public var scrollbackContents: Data {
        queue.sync { scrollback.contents }
    }

    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(masterFD, $0.baseAddress, $0.count) }
            if count > 0 {
                let chunk = Data(buffer[0..<count])
                scrollback.append(chunk)
                onOutput?(chunk)
            } else if count < 0, errno == EINTR {
                continue
            } else {
                // EAGAIN: drained for now. 0 / EIO: the slave side closed, so the child is exiting.
                if count == 0 || errno == EIO { queue.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.reapIfExited() } }
                return
            }
        }
    }

    private func reap() {
        guard !exited else { return }
        exited = true
        drain()
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        readSource?.cancel()
        exitSource?.cancel()
        close(masterFD)
        let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        onExit?(code)
    }

    deinit {
        if !exited, pid > 0 {
            kill(-pid, SIGHUP)
            readSource?.cancel()
            exitSource?.cancel()
            close(masterFD)
        }
    }
}

private func withCStringArray<R>(_ strings: [String], _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) -> R) -> R {
    let pointers = strings.map { strdup($0) } + [nil]
    defer { pointers.forEach { free($0) } }
    return pointers.withUnsafeBufferPointer { body($0.baseAddress!) }
}
