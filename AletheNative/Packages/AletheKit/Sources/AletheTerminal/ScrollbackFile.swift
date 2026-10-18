import Foundation

/// A terminal's output on disk, so it survives relaunch (upstream `pty.rs`: `push_scrollback`,
/// `load_scrollback`, `append_and_maybe_compact`). Output is appended in batches at most every
/// `flushInterval`; once the file passes twice the cap it is compacted to its last `cap` bytes, so
/// writes stay appends and a busy terminal never rewrites its whole history per batch.
///
/// Every file operation runs on one private serial queue; callers never block on disk except
/// `flush()`, which waits for pending bytes (quit).
public final class ScrollbackFile: @unchecked Sendable {
    public static let cap = 4 * 1024 * 1024
    public static let flushInterval: Duration = .milliseconds(250)

    public let url: URL
    private let cap: Int
    private let flushInterval: Duration
    private let queue = DispatchQueue(label: "alethe.scrollback", qos: .utility)
    private var pending = Data()
    private var flushScheduled = false

    public init(url: URL, cap: Int = ScrollbackFile.cap, flushInterval: Duration = ScrollbackFile.flushInterval) {
        self.url = url
        self.cap = cap
        self.flushInterval = flushInterval
    }

    /// The last `cap` bytes on disk (nothing when there is no file).
    public func load() -> Data {
        queue.sync {
            readTail() ?? Data()
        }
    }

    /// Queues output; written within `flushInterval`.
    public func append(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [self] in
            pending.append(data)
            // Bound each disk batch even when a terminal outpaces the timer.
            if pending.count >= cap {
                let scheduled = flushScheduled
                writePending()
                flushScheduled = scheduled
                return
            }
            guard !flushScheduled else { return }
            flushScheduled = true
            queue.asyncAfter(deadline: .now() + flushInterval.timeInterval) { [self] in writePending() }
        }
    }

    /// Writes pending bytes now and waits for them (quit).
    public func flush() {
        queue.sync { writePending() }
    }

    /// Empties the file (Clear Scrollback, restart).
    public func clear() {
        queue.async { [self] in
            pending.removeAll()
            try? Data().write(to: url, options: .atomic)
        }
    }

    /// Removes the file (the tab was closed).
    public func delete() {
        queue.async { [self] in
            pending.removeAll()
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func writePending() {
        flushScheduled = false
        guard !pending.isEmpty else { return }
        let bytes = pending
        pending.removeAll(keepingCapacity: true)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd(), (try? handle.write(contentsOf: bytes)) != nil else { return }
        if Int(end) + bytes.count > cap * 2 { compact() }
    }

    private func compact() {
        guard let data = readTail() else { return }
        try? data.write(to: url, options: .atomic)
    }

    private func readTail() -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return nil }
        do {
            try handle.seek(toOffset: end > UInt64(cap) ? end - UInt64(cap) : 0)
            return try handle.read(upToCount: cap) ?? Data()
        } catch { return nil }
    }

    /// Replayed output without the queries a program sent the terminal (device attributes,
    /// XTVERSION, kitty keyboard and graphics, DECRQM, status and window reports, OSC color and DCS
    /// capability queries). Replayed as-is, the terminal answers each one to the NEW process, which —
    /// still in cooked mode while it starts — echoes the answers as text.
    public static func withoutQueries(_ data: Data) -> Data {
        // ISO Latin-1 maps every byte to one character, so matching and re-encoding keep bytes intact.
        guard let text = String(data: data, encoding: .isoLatin1) else { return data }
        let stripped = text.replacingOccurrences(of: queryPattern, with: "", options: .regularExpression)
        return stripped.data(using: .isoLatin1) ?? data
    }

    static let queryPattern = [
        #"\x{1B}\[[>=]?[0-9;]*c"#,                              // DA1 / DA2 / DA3
        #"\x{1B}\[>[0-9;]*q"#,                                  // XTVERSION
        #"\x{1B}\[\?u"#,                                        // kitty keyboard flags query
        #"\x{1B}\[\??[0-9;]*\$p"#,                              // DECRQM
        #"\x{1B}\[\??[0-9;]*n"#,                                 // DSR (status, cursor position, color scheme)
        #"\x{1B}\[(?:11|13|14|15|16|18|19|20|21)(?:;[0-9]*)*t"#,  // XTWINOPS reports
        #"\x{1B}\][0-9;]*;\?(?:\x{07}|\x{1B}\\)"#,             // OSC color queries (`;?`)
        #"\x{1B}P[$+]q[^\x{1B}]*\x{1B}\\"#,                      // DECRQSS / XTGETTCAP
        #"\x{1B}_G[^\x{1B}]*\x{1B}\\"#,                          // kitty graphics (answers with OK)
    ].joined(separator: "|")

    /// Sequences that undo what a dead program left on: alternate screen, mouse reporting,
    /// bracketed paste, focus reporting, application cursor keys and keypad, the kitty keyboard
    /// protocol and xterm's modifyOtherKeys, hidden cursor, colors, then a clean screen. Written after a replay, before
    /// the new process draws, so a restored TUI's modes do not leak into the fresh shell or agent
    /// (a leaked focus-reporting mode made the terminal send `ESC [ O` to a process still in cooked
    /// mode, which echoed it as `^[[O`).
    public static let replayReset = Data((
        "\u{1b}[?1049l\u{1b}[?1000l\u{1b}[?1002l\u{1b}[?1003l\u{1b}[?1006l\u{1b}[?2004l"
            + "\u{1b}[?1004l\u{1b}[?1l\u{1b}>\u{1b}[<99u\u{1b}[=0;1u\u{1b}[>4;0m"
            // Last: the old screen scrolls into the history (ED 22) and the new program starts on a
            // clear screen at the top. Drawn over the replayed screen, an inline TUI such as Claude
            // Code moves the cursor up into the old lines and garbles both.
            + "\u{1b}[?25h\u{1b}[0m\u{1b}[22J\u{1b}[H").utf8)
}

extension Duration {
    var timeInterval: TimeInterval {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}
