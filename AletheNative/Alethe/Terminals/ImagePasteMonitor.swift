import AletheDesign
import AletheTerminal
import AppKit

/// Terminal-only web input routing. Ordinary text, Option/dead keys and IME composition continue
/// through Ghostty. The macOS profile retains the original image-only clipboard interception.
@MainActor
enum ImagePasteMonitor {
    private static var monitor: Any?
    private static weak var hoverTerminal: TerminalPaneView?
    private static var consumedLinkDown = false
    private static weak var rightClickTerminal: TerminalPaneView?

    static func install(metrics: @escaping @MainActor () -> Metrics? = { nil }) {
        TerminalPaneView.inputMetrics = metrics
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .rightMouseDown, .rightMouseUp, .leftMouseDown, .leftMouseUp, .mouseMoved, .scrollWheel]) { event in
            let handled = MainActor.assumeIsolated { handle(event) }
            return handled ? nil : event
        }
    }

    private static func handle(_ event: NSEvent) -> Bool {
        let metrics = TerminalPaneView.inputMetrics()
        let web = metrics?.isWebInterface == true
        if web, event.type == .leftMouseUp, consumedLinkDown {
            consumedLinkDown = false
            return true
        }
        if web, [.mouseMoved, .scrollWheel, .leftMouseDown].contains(event.type) {
            guard WebMenuHost.shared.presentation == nil else {
                hoverTerminal?.highlightWebLink(at: nil)
                return false
            }
            let content = event.window?.contentView
            let terminal = content.flatMap { $0.hitTest($0.convert(event.locationInWindow, from: nil))?.enclosingTerminal }
            if hoverTerminal !== terminal { hoverTerminal?.highlightWebLink(at: nil) }
            hoverTerminal = terminal
            if event.type == .scrollWheel { terminal?.highlightWebLink(at: nil); return false }
            terminal?.highlightWebLink(at: event.locationInWindow)
            if event.type == .leftMouseDown, let terminal,
               let hit = terminal.webLink(at: event.locationInWindow) {
                terminal.terminalView.performBindingAction("clear_selection")
                terminal.terminalDidRequestOpenURL(hit.link.target, kind: .text)
                terminal.highlightWebLink(at: nil)
                consumedLinkDown = true
                return true
            }
            return false
        }
        if event.type == .rightMouseDown || event.type == .rightMouseUp {
            guard web else { return false }
            if event.type == .rightMouseDown {
                guard let content = event.window?.contentView,
                      let terminal = content.hitTest(content.convert(event.locationInWindow, from: nil))?.enclosingTerminal
                else { return false }
                rightClickTerminal = terminal
                terminal.focus()
                return true
            }
            guard let terminal = rightClickTerminal else { return false }
            rightClickTerminal = nil
            if event.modifierFlags.contains(.shift), let metrics {
                TerminalInputMenu(terminal: terminal, metrics: metrics).show(with: event)
            } else {
                terminal.copyOrPaste()
            }
            return true
        }
        guard event.type == .keyDown else { return false }
        guard let responder = event.window?.firstResponder as? NSView,
              let terminal = responder.enclosingTerminal else { return false }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let key = event.charactersIgnoringModifiers?.lowercased()
        if !web {
            return event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command
                && event.charactersIgnoringModifiers == "v" && terminal.pasteImageIfNeeded()
        }
        // A composing input method owns its keys until it commits the marked text.
        guard !terminal.terminalView.hasMarkedText() else { return false }
        if flags == .command {
            switch key {
            case "c": terminal.copyOrInterrupt(); return true
            case "v": terminal.pasteClipboard(); return true
            case "a": terminal.terminalView.performBindingAction("select_all"); return true
            case "f": terminal.showSearch(); return true
            default: break
            }
        }
        // Upstream accepts Ctrl or Cmd for prompt recall. Keep Cmd+arrows for the app's existing
        // prompt-mark navigation and provide the web's Ctrl+arrows without sending them to the CLI.
        if flags == .control {
            if key == "c" { terminal.copyOrInterrupt(); return true }
            if key == "v" { terminal.pasteClipboard(); return true }
            if event.keyCode == 126 { terminal.recallPrompt(.older); return true }
            if event.keyCode == 125 { terminal.recallPrompt(.newer); return true }
        }
        return false
    }
}

/// Shift+right-click exposes explicit actions while plain right-click keeps the web's copy/paste
/// shortcut. Menu targets remain alive for the complete synchronous AppKit menu tracking loop.
@MainActor
private final class TerminalInputMenu: NSObject {
    let terminal: TerminalPaneView
    let metrics: Metrics
    private var actions: [() -> Void] = []

    init(terminal: TerminalPaneView, metrics: Metrics) {
        self.terminal = terminal
        self.metrics = metrics
    }

    func show(with event: NSEvent) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        add(menu, "terminal.input.copy", symbol: "doc.on.doc", enabled: terminal.hasSelection) { [terminal] in
            terminal.copySelection()
        }
        add(menu, "terminal.input.paste", symbol: "doc.on.clipboard") { [terminal] in terminal.pasteClipboard() }
        add(menu, "terminal.input.selectAll", symbol: "selection.pin.in.out") { [terminal] in
            terminal.terminalView.performBindingAction("select_all")
        }
        menu.addItem(.separator())
        add(menu, "terminal.input.clear", symbol: "trash") { [terminal] in terminal.clearScrollback() }
        add(menu, "terminal.input.search", symbol: "magnifyingglass") { [terminal] in terminal.showSearch() }
        let link = terminal.hoveredLink
        add(menu, "terminal.input.openLink", symbol: "arrow.up.right.square", enabled: link != nil) {
            [terminal] in
            if let link { terminal.terminalDidRequestOpenURL(link, kind: .text) }
        }
        NSMenu.popUpContextMenu(menu, with: event, for: terminal.terminalView)
    }

    private func add(_ menu: NSMenu, _ key: String.LocalizationValue, symbol: String, enabled: Bool = true,
                     action: @escaping () -> Void) {
        let item = NSMenuItem(title: String(localized: key), action: #selector(run(_:)), keyEquivalent: "")
        item.target = self
        item.tag = actions.count
        item.isEnabled = enabled
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: metrics.size(14), weight: .regular))
        actions.append(action)
        menu.addItem(item)
    }

    @objc private func run(_ item: NSMenuItem) { actions[item.tag]() }
}

private extension NSView {
    var enclosingTerminal: TerminalPaneView? {
        var view: NSView? = self
        while let current = view {
            if let terminal = current as? TerminalPaneView { return terminal }
            view = current.superview
        }
        return nil
    }
}
