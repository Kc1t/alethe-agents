import AletheAgents
import AletheDesign
import AletheModel
import AletheTerminal
import AppKit
import Observation
import SwiftUI

/// One pane: a header, the sub-tabs lane when shown, and the active tab's terminal (owned by
/// `TerminalRegistry`, only re-parented here), plus the ended/not-found overlay when the process is
/// not running.
@MainActor
final class PaneView: NSView {
    let paneID: PaneID
    private(set) var tabID: TabID?
    private let header = NSHostingView(rootView: AnyView(EmptyView()))
    private var lane: NSHostingView<AnyView>?
    private let content = NSView()
    private var overlay: NSHostingView<AnyView>?
    private var findBar: NSHostingView<AnyView>?
    private var offerBar: NSHostingView<AnyView>?
    /// The project whose terminal this pane shows (for the page offer's "Open in Pane").
    private var projectID: ProjectID?
    /// The terminal whose find bar this pane follows (the active tab's).
    private weak var searchedTerminal: TerminalPaneView?
    private var context: PaneHostContext?
    private var lastStyle: (focused: Bool, dropTarget: Bool)?
    nonisolated(unsafe) private var defaultsObserver: NSObjectProtocol?

    deinit {
        if let defaultsObserver { NotificationCenter.default.removeObserver(defaultsObserver) }
    }

    init(paneID: PaneID) {
        self.paneID = paneID
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        addSubview(content)
        addSubview(header)
        content.setAccessibilityElement(true)
        content.setAccessibilityRole(.group)
        content.setAccessibilityLabel(String(localized: "terminal.accessibilityLabel"))
        content.setAccessibilityIdentifier("terminal.pane")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let context = self.context, let last = self.lastStyle else { return }
                self.style(focused: last.focused, dropTarget: last.dropTarget, context: context)
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }

    private var webTopbarPinned = true
    private var headerHeight: CGFloat = 28
    private var laneWidth: CGFloat = 36
    private let focusInset = CALayer()
    private var hoverTracking: NSTrackingArea?
    private var pointerInside = false
    private var onPaneDrag: (CGSize?) -> Void = { _ in }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        hoverTracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        pointerInside = true
        updateHeaderVisibility()
    }

    override func mouseExited(with event: NSEvent) {
        pointerInside = false
        updateHeaderVisibility()
    }

    private func updateHeaderVisibility() {
        guard let context, context.metrics.isWebInterface else { return }
        header.alphaValue = webTopbarPinned || pointerInside ? 1 : 0
    }

    private func style(focused: Bool, dropTarget: Bool, context: PaneHostContext) {
        lastStyle = (focused, dropTarget)
        let web = context.metrics.isWebInterface
        let focusEnabled = PaneFocusBorder.enabled
        let focusOpacity = CGFloat(PaneFocusBorder.opacity)
        let media = context.workspace?.document.pane(paneID)?.pane.content.kind
        layer?.cornerRadius = web ? (media == .image || media == .video ? context.metrics.radius(.md) : 0)
            : context.metrics.radius(.md)
        layer?.borderWidth = web ? context.metrics.size(dropTarget ? 2 : 1) : (dropTarget ? 2 : 1)
        let focusToken: ThemeToken = web && context.metrics.style != .clean
            ? (media == .image || media == .video ? .accent : .focusRing) : context.focusBorder
        let isMedia = media == .image || media == .video
        let showFocus = focusEnabled && focused && (!web || isMedia || context.environment.focusModePaneID != paneID)
        let frameColor = context.theme.nsColor(dropTarget ? (web ? .focusRing : .accent) : showFocus ? focusToken : .border)
        layer?.borderColor = (showFocus && !dropTarget ? frameColor.withAlphaComponent(frameColor.alphaComponent * focusOpacity) : frameColor).cgColor
        layer?.backgroundColor = context.theme.nsColor(.bgSunken).cgColor
        if web && focusEnabled && focused && context.environment.focusModePaneID != paneID {
            if focusInset.superlayer == nil { layer?.addSublayer(focusInset) }
            focusInset.borderColor = context.theme.nsColor(focusToken).withAlphaComponent((context.metrics.style == .clean ? 1 : 0.7) * focusOpacity).cgColor
            focusInset.borderWidth = context.metrics.size(1)
            focusInset.zPosition = 10
        } else { focusInset.removeFromSuperlayer() }
    }
    /// A file or page pane (Markdown…): one SwiftUI view in place of header, lane and terminal.
    private var contentHost: NSHostingView<AnyView>?

    func configure(pane: Pane, project: Project, focused: Bool, dropTarget: Bool, context: PaneHostContext,
                   onDrag: @escaping (CGSize?) -> Void) {
        if !pane.content.isTerminal {
            configureContent(pane: pane, project: project, focused: focused, dropTarget: dropTarget, context: context,
                             onDrag: onDrag)
            return
        }
        contentHost?.removeFromSuperview()
        contentHost = nil
        header.isHidden = false
        guard let tab = pane.activeTab else { return }
        self.context = context
        let environment = context.environment
        webTopbarPinned = !UserDefaults.standard.bool(forKey: "pane.web.unpinned." + pane.id.rawValue)
        headerHeight = context.metrics.size(context.metrics.isWebInterface ? (webTopbarPinned ? 32 : 0) : 28)
        header.alphaValue = 1
        alphaValue = context.metrics.isWebInterface && pane.isDisabled ? 0.85 : 1
        laneWidth = context.metrics.size(36)
        let isIsolated = context.workspace?.document.workspace.isolatedPaneID == pane.id
        header.rootView = context.hosted(PaneHeader(
            tab: tab, isFocused: focused, isLaneVisible: pane.isLaneVisible, canHideLane: pane.tabs.count == 1,
            isIsolated: isIsolated,
            onClose: { context.closePane(pane.id) },
            onNewSubTab: { context.newSubTab(in: pane.id) },
            onToggleLane: { context.setLaneVisible(!pane.isLaneVisible, for: pane.id) },
            onToggleIsolation: { context.isolate(isIsolated ? nil : pane.id) },
            onFillFreeSpace: canFill(pane: pane, project: project) ? { context.fillFreeSpace(pane.id) } : nil,
            gridTargets: GridTarget.all(for: pane, in: project),
            onMoveToGrid: { context.movePane(pane.id, toGrid: $0) },
            isInFocusMode: context.environment.focusModePaneID == pane.id,
            onToggleFocus: { context.setFocusMode(context.environment.focusModePaneID == pane.id ? nil : pane.id) },
            onDisable: { context.setDisabled(pane.id, true) },
            isRemoteShared: pane.isRemoteShared,
            onToggleRemoteShared: { environment.remoteControl.setShared(pane.id, !pane.isRemoteShared) },
            onSessionCost: tab.sessionID == nil ? nil : { context.environment.editorRequest = .sessionCost(tab.id) },
            onHandoff: Handoff.supports(AgentKind(rawValue: tab.agent)) ? { context.environment.editorRequest = .handoff(tab.id) } : nil,
            onDrag: onDrag,
            topbarPinned: webTopbarPinned,
            canDragPane: project.visiblePanes.count > 1 && environment.focusModePaneID != pane.id,
            onToggleTopbar: { [weak self] in
                guard let self else { return }
                UserDefaults.standard.set(self.webTopbarPinned, forKey: "pane.web.unpinned." + pane.id.rawValue)
                self.configure(pane: pane, project: project, focused: focused, dropTarget: dropTarget, context: context, onDrag: onDrag)
            }))
        updateHeaderVisibility()
        onPaneDrag = onDrag
        configureLane(pane: pane, project: project, focused: focused, context: context)

        style(focused: focused, dropTarget: dropTarget, context: context)

        let switched = tabID != nil && tabID != tab.id
        tabID = tab.id
        setAccessibilityIdentifier("pane.\(tab.title ?? tab.agent)")
        // A disabled pane runs nothing (P2-23): no process, only the enable overlay.
        if !pane.isDisabled { environment.terminals.ensureStarted(tab, in: project, environment: environment) }
        attachTerminal(pane.isDisabled ? nil : environment.terminals.view(for: tab.id))
        followSearch(of: pane.isDisabled ? nil : environment.terminals.view(for: tab.id))
        projectID = project.id
        observeOffer(for: tab.id)

        if pane.isDisabled || TerminalOverlay.isNeeded(for: environment.terminals.states[tab.id]) {
            let root = pane.isDisabled
                ? context.hosted(DisabledPaneOverlay(agent: tab.agent, onEnable: { context.setDisabled(pane.id, false) }))
                : context.hosted(TerminalOverlay(tab: tab, project: project))
            if let overlay {
                overlay.rootView = root
            } else {
                let overlay = NSHostingView(rootView: root)
                addSubview(overlay, positioned: .above, relativeTo: content)
                self.overlay = overlay
            }
        } else {
            overlay?.removeFromSuperview()
            overlay = nil
        }
        // A sub-tab switch in the focused pane hands the keyboard to the newly shown terminal.
        if switched && focused { DispatchQueue.main.async { [weak self] in self?.focusTerminal() } }
        needsLayout = true
    }

    private func configureContent(pane: Pane, project: Project, focused: Bool, dropTarget: Bool,
                                  context: PaneHostContext, onDrag: @escaping (CGSize?) -> Void) {
        self.context = context
        tabID = nil
        header.isHidden = true
        attachTerminal(nil)
        followSearch(of: nil)
        offerObservation += 1
        offerBar?.removeFromSuperview()
        offerBar = nil
        lane?.removeFromSuperview()
        lane = nil
        overlay?.removeFromSuperview()
        overlay = nil
        style(focused: focused, dropTarget: dropTarget, context: context)

        let view: AnyView
        switch pane.content {
        case .markdown(let path):
            setAccessibilityIdentifier("pane.\((path as NSString).lastPathComponent)")
            let file = context.environment.contentPanes.markdown(for: pane.id, path: path)
            view = context.hosted(MarkdownPaneView(file: file, isFocused: focused,
                                                   onClose: { context.closePane(pane.id) }, onDrag: onDrag))
        case .image(let path):
            setAccessibilityIdentifier("pane.\((path as NSString).lastPathComponent)")
            let file = context.environment.contentPanes.image(for: pane.id, path: path)
            view = context.hosted(ImagePaneView(file: file, isFocused: focused,
                                                onClose: { context.closePane(pane.id) }, onDrag: onDrag))
        case .video(let path):
            setAccessibilityIdentifier("pane.\((path as NSString).lastPathComponent)")
            let player = context.environment.contentPanes.player(for: pane.id, path: path)
            view = context.hosted(VideoPaneView(url: URL(filePath: path), player: player, isFocused: focused,
                                                onClose: { context.closePane(pane.id) }, onDrag: onDrag))
        case .diff(let path, let staged):
            setAccessibilityIdentifier("pane.diff")
            let model = context.environment.contentPanes.diff(for: pane.id, folder: project.folder, path: path, staged: staged)
            view = context.hosted(DiffPaneView(
                model: model, isFocused: focused,
                onStagedChange: { context.setContent(.diff(path: path, staged: $0), for: pane.id) },
                onClose: { context.closePane(pane.id) }, onDrag: onDrag))
        case .web(let url, let options):
            setAccessibilityIdentifier("pane.web")
            let page = context.environment.contentPanes.page(for: pane.id, url: url, options: options)
            page.onAddressChange = { [weak page] address in
                context.setContent(.web(url: address.absoluteString, options: page?.options ?? options), for: pane.id)
            }
            view = context.hosted(WebPaneView(
                page: page, isFocused: focused,
                onOptionsChange: { [weak page] in
                    context.setContent(.web(url: page?.url?.absoluteString ?? url, options: $0), for: pane.id)
                },
                onClose: { context.closePane(pane.id) }, onDrag: onDrag))
        case .graphify:
            setAccessibilityIdentifier("pane.graphify")
            let graphify = context.environment.graphify
            let model = context.environment.contentPanes.graph(for: pane.id, root: graphify.root(for: project.folder),
                                                                controller: graphify)
            view = context.hosted(GraphifyPaneView(model: model, project: project.id, isFocused: focused,
                                                   onClose: { context.closePane(pane.id) }, onDrag: onDrag))
        case .orchestrator:
            setAccessibilityIdentifier("pane.orchestrator")
            view = context.hosted(OrchestratorPaneView(project: project.id, isFocused: focused,
                                                       onClose: { context.closePane(pane.id) },
                                                       onDrag: onDrag))
        case .terminal:
            view = AnyView(EmptyView())
        }
        let identified = AnyView(view.environment(\.contentPaneID, pane.id))
        if let contentHost {
            contentHost.rootView = identified
        } else {
            let host = NSHostingView(rootView: identified)
            addSubview(host)
            contentHost = host
        }
        needsLayout = true
    }

    private func configureLane(pane: Pane, project: Project, focused: Bool, context: PaneHostContext) {
        guard pane.isLaneVisible else {
            lane?.removeFromSuperview()
            lane = nil
            return
        }
        let root = context.hosted(SubTabsLane(
            pane: pane, isFocused: focused,
            canDragPane: project.visiblePanes.count > 1 && context.environment.focusModePaneID != pane.id,
            onDrag: onPaneDrag,
            onActivate: { context.activateTab($0) },
            onClose: { context.closeTab($0) },
            onRestart: { context.restart($0, in: project) },
            onAdd: { context.newSubTab(in: pane.id) }))
        if let lane {
            lane.rootView = root
        } else {
            let lane = NSHostingView(rootView: root)
            addSubview(lane)
            self.lane = lane
        }
    }

    // MARK: - Page offer

    private var offerObservation = 0

    /// Shows the page offer of the visible tab, and follows it as it appears or goes.
    private func observeOffer(for tab: TabID) {
        offerObservation += 1
        let generation = offerObservation
        updateOfferBar(for: tab)
        watchOffer(tab, generation)
    }

    private func watchOffer(_ tab: TabID, _ generation: Int) {
        guard let terminals = context?.environment.terminals else { return }
        withObservationTracking {
            _ = terminals.pageOffers[tab]
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, generation == self.offerObservation else { return }
                self.updateOfferBar(for: tab)
                self.watchOffer(tab, generation)
            }
        }
    }

    private func updateOfferBar(for tab: TabID) {
        guard let context, let url = context.environment.terminals.pageOffers[tab], let projectID else {
            offerBar?.removeFromSuperview()
            offerBar = nil
            needsLayout = true
            return
        }
        let environment = context.environment
        let root = context.hosted(PageOfferBar(
            url: url,
            onOpenInPane: {
                environment.terminals.dismissPageOffer(for: tab)
                environment.open(.web(url: url.absoluteString, options: WebPaneOptions()), in: projectID)
            },
            onOpenInBrowser: {
                environment.terminals.dismissPageOffer(for: tab)
                NSWorkspace.shared.open(url)
            },
            onDismiss: { environment.terminals.dismissPageOffer(for: tab) }))
        if let offerBar {
            offerBar.rootView = root
        } else {
            let bar = NSHostingView(rootView: root)
            addSubview(bar, positioned: .above, relativeTo: content)
            offerBar = bar
        }
        needsLayout = true
    }

    // MARK: - Find bar

    private func followSearch(of terminal: TerminalPaneView?) {
        guard terminal !== searchedTerminal else {
            updateFindBar()
            return
        }
        searchedTerminal = terminal
        searchObservation += 1
        observeSearch(searchObservation)
        updateFindBar()
    }

    /// Bumped when the pane starts following another terminal, so an older observation stops.
    private var searchObservation = 0

    /// Shows or hides the find bar whenever the terminal's search opens or closes (⌘F from the menu,
    /// or Ghostty's own `start_search` / `end_search`).
    private func observeSearch(_ generation: Int) {
        guard let terminal = searchedTerminal else { return }
        withObservationTracking {
            _ = terminal.search.isPresented
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, generation == self.searchObservation else { return }
                self.updateFindBar()
                self.observeSearch(generation)
            }
        }
    }

    private func updateFindBar() {
        guard let terminal = searchedTerminal, terminal.search.isPresented, let context else {
            findBar?.removeFromSuperview()
            findBar = nil
            return
        }
        let root = context.hosted(TerminalFindBar(terminal: terminal))
        if let findBar {
            findBar.rootView = root
        } else {
            let bar = NSHostingView(rootView: root)
            addSubview(bar, positioned: .above, relativeTo: content)
            findBar = bar
        }
        needsLayout = true
    }

    func focusTerminal() {
        (content.subviews.first as? TerminalPaneView)?.focus()
    }

    private func attachTerminal(_ terminal: TerminalPaneView?) {
        guard content.subviews.first !== terminal else { return }
        content.subviews.forEach { $0.removeFromSuperview() }
        guard let terminal else { return }
        terminal.removeFromSuperview()
        terminal.frame = content.bounds
        terminal.autoresizingMask = [.width, .height]
        content.addSubview(terminal)
        terminal.syncSurfaceSize()
    }

    override func layout() {
        super.layout()
        let edge = context?.metrics.size(1) ?? 1
        focusInset.frame = bounds.insetBy(dx: edge, dy: edge)
        if let contentHost {
            contentHost.frame = bounds
            return
        }
        let web = context?.metrics.isWebInterface == true
        let floating = web && !webTopbarPinned
        header.frame = CGRect(x: 0, y: floating ? context?.metrics.size(4) ?? 4 : 0,
                              width: bounds.width, height: floating ? context?.metrics.size(26) ?? 26 : headerHeight)
        // A floating (unpinned) web header overlays the terminal and reserves no strip.
        let top = floating ? 0 : headerHeight
        let body = CGRect(x: 0, y: top, width: bounds.width, height: max(0, bounds.height - top))
        let leading = lane == nil ? 0 : min(laneWidth, body.width)
        lane?.frame = CGRect(x: 0, y: body.minY, width: leading, height: body.height)
        let padding = context?.metrics
        content.frame = CGRect(x: leading + (web ? padding?.size(8) ?? 8 : 0),
                               y: body.minY + (web ? padding?.size(4) ?? 4 : 0),
                               width: max(0, body.width - leading - (web ? padding?.size(14) ?? 14 : 0)),
                               height: max(0, body.height - (web ? padding?.size(6) ?? 6 : 0)))
        overlay?.frame = content.frame
        // The content frame just changed; refit explicitly instead of relying on autoresizing.
        (content.subviews.first as? TerminalPaneView)?.syncSurfaceSize()
        if let offerBar {
            let height = offerBar.fittingSize.height
            offerBar.frame = CGRect(x: content.frame.minX, y: content.frame.minY, width: content.frame.width, height: height)
        }
        if let findBar {
            let inset = context?.metrics.space(.m) ?? 8
            let size = findBar.fittingSize
            let width = min(size.width, max(0, content.frame.width - inset * 2))
            findBar.frame = CGRect(x: content.frame.maxX - width - inset, y: content.frame.minY + inset,
                                   width: width, height: size.height)
        }
    }

    private func canFill(pane: Pane, project: Project) -> Bool {
        guard project.layout == .grid else { return false }
        let grid = project.effectiveGrid, ids = project.visiblePanes.map(\.id.rawValue)
        return grid.fillingFreeSpace(ids, pane.id.rawValue) != grid
    }
}
