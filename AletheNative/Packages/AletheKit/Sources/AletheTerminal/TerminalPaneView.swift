import AletheDesign
import AppKit
import Foundation
import GhosttyTerminal
import Synchronization

/// A terminal pane: an app-owned PTY rendered by Ghostty in host-managed mode.
///
/// The PTY belongs to `PTYProcess`, not to the renderer, so its output can be kept (scrollback),
/// tapped (remote control, orchestrator) and replayed into a new view.
@MainActor
public final class TerminalPaneView: NSView {
    /// Live UI metrics supplied by the application, including interface changes and UI zoom.
    public static var inputMetrics: @MainActor () -> Metrics? = { nil }
    public let terminalView: TerminalView
    private let controller: TerminalController
    private let session: InMemoryTerminalSession
    private let process: PTYProcess
    public let tap: TerminalIOTap
    private let activity = TerminalActivity()
    private let forceKill = ForceKillState()
    private let forceKillNotice: Data
    private let grid: GridSizeState
    /// Find bar state (⌘F).
    public let search = TerminalSearch()
    private let history: PromptHistoryState
    /// Where this terminal's output is kept across relaunches; nil for throwaway terminals.
    public let scrollback: ScrollbackFile?

    /// Called on the main actor with the new entries whenever a submitted prompt changes the history.
    public var onPromptHistoryChange: (([String]) -> Void)?
    /// A ⌘-clicked link, as Ghostty detected it (URL, path or OSC 8 target). Once set, Ghostty no
    /// longer opens URLs itself.
    public var onOpenLink: ((String) -> Void)?
    /// Current Ghostty hyperlink under the pointer, used by explicit context-menu actions.
    public internal(set) var hoveredLink: String?
    let linkHighlight = TerminalLinkHighlightView()
    var linkGrid: TerminalGridMetrics?
    /// A local development server address printed in the output, reported once per address.
    public var onLocalServer: ((URL) -> Void)? {
        get { servers.onFound }
        set { servers.onFound = newValue }
    }
    private let servers = LocalServerState()
    /// The shell's current folder, from OSC 7 (shell integration); nil until it reports one.
    public private(set) var reportedDirectory: String?

    public var onExit: ((Int32) -> Void)?

    /// Whether the process ended through a double ⌃C, not by itself.
    public var wasForceKilled: Bool { forceKill.triggered }

    /// The shell or agent process at the root of this terminal's process tree.
    public var processID: pid_t { process.pid }
    /// Time since the process last printed anything.
    public var quietFor: Duration { activity.quietFor }
    public let startedAt = Date()
    /// The PTY's grid: the launch size until the view first lays out, then the last resize. Read
    /// from any thread (remote control reports it with the scrollback).
    public nonisolated var gridSize: PTYSize { grid.size }

    /// - Parameter forceKillNotice: line printed in the terminal when a double ⌃C kills the process.
    public init(launch: PTYLaunch, theme: Theme, fontSize: Float = TerminalAppearance.defaultFontSize,
                forceKillNotice: String = "Force kill: process terminated", promptHistory: [String] = [],
                scrollback: ScrollbackFile? = nil) throws {
        // Spawned at the view's real size (first viewport), not the launch's placeholder.
        let process = try PTYProcess(launch, spawnNow: false)
        self.process = process
        let tap = TerminalIOTap()
        self.tap = tap
        let history = PromptHistoryState(PromptHistory(entries: promptHistory))
        self.history = history
        self.scrollback = scrollback
        let forceKill = forceKill
        let spawner = DeferredSpawn()
        let grid = GridSizeState(launch.size)
        self.grid = grid
        let notice = Data("\r\n\u{1b}[33m[\(forceKillNotice)]\u{1b}[0m\r\n".utf8)
        self.forceKillNotice = notice
        session = InMemoryTerminalSession(
            write: { data in
                tap.input(data)
                history.record(data)
                if forceKill.register(data) {
                    forceKill.session?.receive(notice)
                    ProcessTree.kill(process.pid)
                    return
                }
                process.write(data)
            },
            resize: { viewport in
                let size = PTYSize(
                    columns: viewport.columns,
                    rows: viewport.rows,
                    widthPixels: UInt16(clamping: viewport.widthPixels),
                    heightPixels: UInt16(clamping: viewport.heightPixels)
                )
                TerminalResizeLog.write("ghostty resize \(size.columns)x\(size.rows)")
                if size.columns > 0, size.rows > 0 { grid.size = size }
                if spawner.spawnIfNeeded(size) { return }
                process.resizeCoalesced(size)
            }
        )
        controller = TerminalController(theme: TerminalAppearance.terminalTheme(
            for: theme, fontSize: fontSize, metrics: Self.inputMetrics()))
        terminalView = TerminalView(frame: .zero)
        super.init(frame: .zero)
        TerminalResizeLog.enableIfRequested()

        forceKill.session = session
        history.onChange = { [weak self] entries in self?.onPromptHistoryChange?(entries) }
        terminalView.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
        terminalView.delegate = self
        registerForDraggedTypes([.fileURL] + SmartPaste.imageTypes)
        dropHighlight = theme.nsColor(.accent)
        terminalView.controller = controller
        // Frame-based on purpose: the pane host drives this view with frames (spring animation,
        // reparenting for focus mode), and a constraint pass can lag a frame change, leaving the
        // surface at its old size. `syncSurfaceSize()` pins and fits it on every size change.
        terminalView.translatesAutoresizingMaskIntoConstraints = true
        terminalView.autoresizingMask = [.width, .height]
        addSubview(terminalView)
        linkHighlight.color = theme.nsColor(.accent)
        linkHighlight.thickness = Self.inputMetrics()?.size(1) ?? 1
        addSubview(linkHighlight)

        let session = session
        let activity = activity
        // The previous run's output first, then a reset of the modes it left on, then the new
        // process (upstream `attach_pty` replay). The session buffers it until the view attaches.
        if let restored = scrollback?.load(), !restored.isEmpty {
            session.receive(ScrollbackFile.withoutQueries(restored) + ScrollbackFile.replayReset)
            scrollback?.append(ScrollbackFile.replayReset)
        }
        let servers = servers
        process.onOutput = { data in
            activity.touch()
            servers.scan(data)
            tap.output(data)
            scrollback?.append(data)
            session.receive(data)
        }
        // The session is deliberately not `finish`ed: Ghostty would print its own "Process exited.
        // Press any key to close" line, and the app shows the ended state (with Restart) itself.
        process.onExit = { [weak self] code in
            activity.finish()
            Task { @MainActor in self?.onExit?(code) }
        }
        spawner.configure(process: process, fallback: launch.size) { [weak self] code in
            session.receive(Data("\r\n\u{1b}[31m[\(String(cString: strerror(code)))]\u{1b}[0m\r\n".utf8))
            Task { @MainActor in self?.onExit?(127) }
        }
        // A view that is never shown (a hidden tab) still starts, at the launch's size.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { spawner.spawnIfNeeded(nil) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override public func layout() {
        super.layout()
        syncSurfaceSize()
    }

    override public func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        syncSurfaceSize()
    }

    override public func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { syncSurfaceSize() }
    }

    override public func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        if superview != nil { syncSurfaceSize() }
    }

    override public func viewDidUnhide() {
        super.viewDidUnhide()
        syncSurfaceSize()
    }

    /// Pins the surface view to the pane's bounds and refits Ghostty (grid, pixel size, PTY winsize
    /// through the session's resize callback). Safe to call at any time; a zero size is a no-op
    /// until the view regains one.
    public func syncSurfaceSize() {
        let frame = TerminalAppearance.surfaceFrame(in: bounds, metrics: Self.inputMetrics())
        if terminalView.frame != frame { terminalView.frame = frame }
        terminalView.fitToSize()
        scheduleSettle()
    }

    private var settleWork: DispatchWorkItem?

    /// Safety net: 120 ms after the last size change (a drag, a spring animation, a reparent) the
    /// surface is refitted once more and the PTY is told the final grid again, so a lost or
    /// out-of-order resize can never leave the program at an old size.
    private func scheduleSettle() {
        settleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, window != nil, bounds.width > 0, bounds.height > 0 else { return }
            let frame = TerminalAppearance.surfaceFrame(in: bounds, metrics: Self.inputMetrics())
            if terminalView.frame != frame { terminalView.frame = frame }
            terminalView.fitToSize()
            let size = grid.size
            if size.columns > 0, size.rows > 0 { process.reassertSize(size) }
        }
        settleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    public func focus() {
        window?.makeFirstResponder(terminalView)
    }

    public func applyTheme(_ theme: Theme, fontSize: Float = TerminalAppearance.defaultFontSize) {
        _ = controller.setTheme(TerminalAppearance.terminalTheme(
            for: theme, fontSize: fontSize, metrics: Self.inputMetrics()))
        syncSurfaceSize()
        dropHighlight = theme.nsColor(.accent)
        linkHighlight.color = theme.nsColor(.accent)
        linkHighlight.thickness = Self.inputMetrics()?.size(1) ?? 1
        highlightWebLink(at: nil)
    }

    // MARK: - Smart paste and drop

    public var hasSelection: Bool { terminalView.selectionMenuPoint(at: .zero) != nil }

    @discardableResult
    public func copySelection() -> Bool {
        guard terminalView.copySelectedTextToPasteboard() else { return false }
        terminalView.performBindingAction("clear_selection")
        return true
    }

    /// Web copy consumes the selection; without one, the same chord interrupts the foreground
    /// process. Send a key through Ghostty so the existing I/O tap and double-interrupt policy run.
    public func copyOrInterrupt() {
        if !copySelection() {
            terminalView.sendKey(.c, modifiers: .ctrl)
        }
    }

    /// One clipboard resolution and one Ghostty paste, including file and image payloads. Ghostty
    /// applies bracketed-paste framing according to the application's current terminal mode.
    @discardableResult
    public func pasteClipboard(from pasteboard: NSPasteboard = .general) -> Bool {
        let text: String
        switch SmartPaste.payload(from: pasteboard) {
        case .paths(let paths): text = SmartPaste.format(paths: paths)
        case .image(let data):
            guard let path = try? SmartPaste.saveImage(data) else { return false }
            text = SmartPaste.format(paths: [path])
        case .text(let value): text = SmartPaste.normalizeText(value)
        case .empty: return false
        }
        return terminalView.paste(text: text)
    }

    /// Upstream's right-click shortcut: copy a selection, otherwise paste. Do not interrupt when
    /// there is nothing selected (unlike the keyboard's copy chord).
    public func copyOrPaste() {
        if !copySelection() {
            pasteClipboard()
        }
    }

    private var dropHighlight = NSColor.controlAccentColor

    /// The paste Ghostty cannot do on its own: an image with no file behind it (a screenshot, "Copy
    /// Image") is saved as a PNG and its path pasted. False when the pasteboard holds files or text,
    /// which Ghostty's own paste handles (escaped paths, bracketed paste).
    public func pasteImageIfNeeded(from pasteboard: NSPasteboard = .general) -> Bool {
        guard case .image(let data) = SmartPaste.payload(from: pasteboard),
              let path = try? SmartPaste.saveImage(data) else { return false }
        return terminalView.paste(text: SmartPaste.format(paths: [path]))
    }

    override public func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard SmartPaste.payload(from: sender.draggingPasteboard) != .empty else { return [] }
        setDropHighlighted(true)
        return .copy
    }

    override public func draggingExited(_ sender: (any NSDraggingInfo)?) {
        setDropHighlighted(false)
    }

    override public func concludeDragOperation(_ sender: (any NSDraggingInfo)?) {
        setDropHighlighted(false)
    }

    /// Files dropped from Finder paste as their paths; an image dragged out of a browser or a
    /// screenshot thumbnail is saved first (upstream drag-and-drop).
    override public func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        setDropHighlighted(false)
        let text: String
        switch SmartPaste.payload(from: sender.draggingPasteboard) {
        case .paths(let paths):
            text = SmartPaste.format(paths: paths)
        case .image(let data):
            guard let path = try? SmartPaste.saveImage(data) else { return false }
            text = SmartPaste.format(paths: [path])
        case .text(let string):
            text = string
        case .empty:
            return false
        }
        focus()
        return terminalView.paste(text: text)
    }

    private func setDropHighlighted(_ highlighted: Bool) {
        wantsLayer = true
        layer?.borderWidth = highlighted ? 2 : 0
        layer?.borderColor = dropHighlight.cgColor
    }

    /// Types `prompt` into the agent once it is ready (see `PromptDelivery`). True once sent.
    public func deliverPrompt(_ prompt: String, style: PromptDelivery.Style) async -> Bool {
        let clock = ContinuousClock()
        let origin = clock.now
        let activity = activity
        let process = process
        let tap = tap
        let io = PromptDelivery.IO(
            now: { origin.duration(to: clock.now) },
            sleep: { try? await Task.sleep(for: $0) },
            quietFor: { activity.quietFor },
            isRunning: { activity.isRunning },
            readScreen: { [weak self] in await MainActor.run { self?.viewportText() ?? "" } },
            write: { text in
                let data = Data(text.utf8)
                tap.input(data)
                process.write(data)
            })
        return await PromptDelivery.deliver(prompt, style: style, io: io)
    }

    /// Types text as if from the keyboard (dictation), without pressing Enter.
    public func type(_ text: String) {
        let data = Data(text.utf8)
        tap.input(data)
        process.write(data)
    }

    /// Viewport text (visible rows), for tests and diagnostics.
    public func viewportText() -> String? {
        session.readViewportText()
    }

    /// Scrolls to the previous (negative) or next prompt; needs the shell's OSC 133 marks
    /// (`ShellIntegration`) or an agent that emits them.
    @discardableResult
    public func jumpToPrompt(_ delta: Int) -> Bool {
        terminalView.jumpToPrompt(by: Int16(clamping: delta))
    }

    /// Clears the screen and scrollback, on screen and on disk (Terminal › Clear Scrollback).
    public func clearScrollback() {
        terminalView.performBindingAction("clear_screen")
        scrollback?.clear()
    }

    // MARK: - Prompt history

    /// Replaces the line being typed with an older or newer submitted prompt (upstream ⌃↑ / ⌃↓).
    /// False when the tab has no history yet.
    @discardableResult
    public func recallPrompt(_ direction: PromptHistory.Direction) -> Bool {
        guard let entry = history.recall(direction) else { return false }
        let data = Data(PromptHistory.recallInput(entry).utf8)
        tap.input(data)
        process.write(data)
        return true
    }

    // MARK: - Search (Ghostty binding actions)

    /// Opens the find bar (or focuses it again), searching `needle` when given.
    public func showSearch(needle: String? = nil) {
        search.isPresented = true
        search.focusRequest += 1
        if let needle, !needle.isEmpty {
            updateSearch(needle, resetProgress: Self.inputMetrics()?.isWebInterface == true)
        }
    }

    /// Searches as the user types; an empty needle clears the matches but keeps the bar.
    public func updateSearch(_ text: String, resetProgress: Bool = false) {
        let needle = search.setNeedle(text, resetProgress: resetProgress)
        terminalView.performBindingAction("search:\(needle)")
    }

    /// Searches the terminal's selection (⌘E); Ghostty reports it back as a search request.
    public func searchSelection() {
        terminalView.performBindingAction("search_selection")
    }

    @discardableResult
    public func searchNext() -> Bool {
        terminalView.performBindingAction("navigate_search:next")
    }

    @discardableResult
    public func searchPrevious() -> Bool {
        terminalView.performBindingAction("navigate_search:previous")
    }

    /// Closes the find bar, clears the highlights and gives the keyboard back to the terminal.
    public func closeSearch() {
        terminalView.performBindingAction("end_search")
        resetSearch()
        focus()
    }

    private func resetSearch() {
        search.isPresented = false
        search.needle = ""
        search.total = nil
        search.selected = nil
    }

    /// Kills the whole process tree like a double ⌃C does: prints the notice and marks the terminal
    /// force-killed (so it shows the restart overlay instead of restarting by itself).
    public func forceKillTree() {
        guard forceKill.trigger() else { return }
        forceKill.session?.receive(forceKillNotice)
        ProcessTree.kill(process.pid)
    }

    /// Ends the process group: SIGHUP, then SIGKILL if it outlives the grace period.
    public func terminate() {
        process.terminate()
    }
}

extension TerminalPaneView: TerminalSurfaceOpenURLDelegate, TerminalSurfacePwdDelegate, TerminalSurfaceHoverLinkDelegate {
    public func terminalDidUpdateHoverLink(_ url: String?) {
        if Self.inputMetrics()?.isWebInterface != true { hoveredLink = url }
    }

    public func terminalDidRequestOpenURL(_ url: String, kind: TerminalOpenURLKind) {
        if let onOpenLink {
            onOpenLink(url)
        } else if let target = URL(string: url) {
            NSWorkspace.shared.open(target)
        }
    }

    public func terminalDidChangeWorkingDirectory(_ path: String) {
        reportedDirectory = TerminalLink.workingDirectory(fromReported: path) ?? reportedDirectory
    }
}

extension TerminalPaneView: TerminalSurfaceSearchDelegate {
    public func terminalDidRequestSearch(needle: String) {
        showSearch(needle: needle)
    }

    public func terminalDidEndSearch() {
        resetSearch()
    }

    public func terminalDidUpdateSearchTotal(_ total: Int?) {
        search.total = total
    }

    public func terminalDidUpdateSearchSelected(_ selected: Int?) {
        search.selected = selected
    }
}

/// Local server detection on the PTY's output queue; findings are reported on the main actor.
private final class LocalServerState: @unchecked Sendable {
    private let detector = Mutex(LocalServerDetector())
    @MainActor var onFound: ((URL) -> Void)?

    init() {}

    func scan(_ data: Data) {
        let found = detector.withLock { $0.scan(data) }
        guard !found.isEmpty else { return }
        Task { @MainActor [weak self] in found.forEach { self?.onFound?($0) } }
    }
}

/// Prompt history shared with the session's write callback (any thread).
private final class PromptHistoryState: @unchecked Sendable {
    private let state: Mutex<PromptHistory>
    /// Set once after init, read on the main actor.
    @MainActor var onChange: (([String]) -> Void)?

    init(_ history: PromptHistory) { state = Mutex(history) }

    func record(_ input: Data) {
        guard let text = String(data: input, encoding: .utf8) else { return }
        let changed: [String]? = state.withLock { $0.record(text) ? $0.entries : nil }
        guard let changed else { return }
        Task { @MainActor [weak self] in self?.onChange?(changed) }
    }

    func recall(_ direction: PromptHistory.Direction) -> String? {
        state.withLock { $0.recall(direction) }
    }
}

/// Double ⌃C state, shared with the session's write callback (any thread).
private final class ForceKillState: @unchecked Sendable {
    private let state = Mutex<(detector: DoubleInterrupt, triggered: Bool)>((DoubleInterrupt(), false))
    /// Set once, right after the session exists; read by the write callback.
    weak var session: InMemoryTerminalSession?

    func register(_ input: Data) -> Bool {
        state.withLock { state in
            let fire = !state.triggered && state.detector.register(input, at: .now)
            if fire { state.triggered = true }
            return fire
        }
    }

    /// Marks the terminal force-killed; false when it already was.
    func trigger() -> Bool {
        state.withLock { state in
            guard !state.triggered else { return false }
            state.triggered = true
            return true
        }
    }

    var triggered: Bool { state.withLock { $0.triggered } }
}

/// The PTY's current grid, written by the session's resize callback (any thread).
private final class GridSizeState: Sendable {
    private let state: Mutex<PTYSize>

    init(_ size: PTYSize) { state = Mutex(size) }

    var size: PTYSize {
        get { state.withLock { $0 } }
        set { state.withLock { $0 = newValue } }
    }
}

/// When the process last wrote output, and whether it is still running (read from any thread).
private final class TerminalActivity: Sendable {
    private let state = Mutex<(last: ContinuousClock.Instant, running: Bool)>((ContinuousClock.now, true))

    func touch() { state.withLock { $0.last = .now } }
    func finish() { state.withLock { $0.running = false } }
    var quietFor: Duration { state.withLock { $0.last.duration(to: .now) } }
    var isRunning: Bool { state.withLock { $0.running } }
}

/// Starts a view's process once, at the first real size (or the fallback).
private final class DeferredSpawn: @unchecked Sendable {
    private let lock = NSLock()
    private var process: PTYProcess?
    private var fallback = PTYSize(columns: 80, rows: 24)
    private var failed: (@Sendable (Int32) -> Void)?
    private var done = false

    func configure(process: PTYProcess, fallback: PTYSize, failed: @escaping @Sendable (Int32) -> Void) {
        lock.withLock {
            self.process = process
            self.fallback = fallback
            self.failed = failed
        }
    }

    /// True when this call spawned the process (the size is then already applied).
    @discardableResult
    func spawnIfNeeded(_ size: PTYSize?) -> Bool {
        let claim: (PTYProcess, PTYSize, (@Sendable (Int32) -> Void)?)? = lock.withLock {
            guard !done, let process, size.map({ $0.columns > 0 && $0.rows > 0 }) ?? true else { return nil }
            done = true
            return (process, size ?? fallback, failed)
        }
        guard let (process, size, failed) = claim else { return false }
        do {
            try process.spawn(size: size)
        } catch PTYError.spawnFailed(let code) {
            failed?(code)
        } catch {
            failed?(EIO)
        }
        return true
    }
}

extension TerminalPaneView: TerminalSurfaceGridResizeDelegate {
    public func terminalDidResize(_ size: TerminalGridMetrics) {
        linkGrid = size
        highlightWebLink(at: nil)
    }
}
