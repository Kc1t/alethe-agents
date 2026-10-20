import AletheDesign
import AppKit
import SwiftUI

// Themed replacement for AppKit menus in the web interface. It mirrors the web's
// `ProjectSidebar/ContextMenu.tsx` + `ContextMenu.module.css`: a fixed-position panel on
// `--bg-elevated` with a 1px `--border`, `--radius-md`, `--shadow-md`, 180px min width, 4px padding,
// 13px items with 6/10 padding, an 8px gap to a 15px icon column, `--panel-hover` hover, a danger
// colour, 1px separators with 4/2 margins, kept 8px inside the window, closed by Escape or an outside
// click. Everything is drawn only when `metrics.isWebInterface`; `.mac` keeps `.contextMenu`/`Menu`.

// MARK: - Session (per open panel)

/// One open panel (or flyout): the registry of its items, the highlighted row and the open flyout.
@MainActor @Observable
final class WebMenuSession {
    struct Entry {
        let id: UUID
        let enabled: Bool
        /// Submenu rows open their flyout instead of closing the menu.
        let opensSubmenu: Bool
        let trigger: () -> Void
    }

    @ObservationIgnored var entries: [Entry] = []
    @ObservationIgnored weak var parent: WebMenuSession?
    var highlighted: UUID?
    /// Row whose flyout is open, and the flyout's own session.
    var openSubmenu: UUID?
    @ObservationIgnored var child: WebMenuSession?

    func register(_ entry: Entry) {
        entries.removeAll { $0.id == entry.id }
        entries.append(entry)
    }

    func unregister(_ id: UUID) {
        entries.removeAll { $0.id == id }
        if highlighted == id { highlighted = nil }
    }

    /// The deepest session whose flyout chain is open: keyboard input goes there.
    var active: WebMenuSession {
        if openSubmenu != nil, let child { return child.active }
        return self
    }

    func move(_ delta: Int) {
        let enabled = entries.filter(\.enabled)
        guard !enabled.isEmpty else { return }
        if let current = enabled.firstIndex(where: { $0.id == highlighted }) {
            highlighted = enabled[(current + delta + enabled.count) % enabled.count].id
        } else {
            highlighted = delta > 0 ? enabled.first?.id : enabled.last?.id
        }
    }

    func activateHighlighted() {
        guard let entry = entries.first(where: { $0.id == highlighted && $0.enabled }) else { return }
        entry.trigger()
    }
}

extension EnvironmentValues {
    @Entry var webMenuSession: WebMenuSession?
    @Entry var webMenuItemDanger = false
}

// MARK: - Host (one presentation at a time)

@MainActor @Observable
final class WebMenuHost {
    static let shared = WebMenuHost()

    enum Placement {
        case point(CGPoint)
        case anchor(CGRect, trailing: Bool)
    }

    struct Presentation: Identifiable {
        let id = UUID()
        let placement: Placement
        var content: AnyView
        var usesDefaultChrome = true
    }

    var presentation: Presentation?
    @ObservationIgnored var session: WebMenuSession?
    /// Layer geometry, in the SwiftUI global space.
    @ObservationIgnored var layerOrigin: CGPoint = .zero
    @ObservationIgnored weak var layerView: NSView?

    func present(at point: CGPoint, content: AnyView, usesDefaultChrome: Bool = true) {
        presentation = Presentation(placement: .point(point), content: content, usesDefaultChrome: usesDefaultChrome)
    }

    /// `rect` is in the SwiftUI global space (a trigger's `frame(in: .global)`).
    func present(anchor rect: CGRect, trailing: Bool, content: AnyView) {
        let local = rect.offsetBy(dx: -layerOrigin.x, dy: -layerOrigin.y)
        presentation = Presentation(placement: .anchor(local, trailing: trailing), content: content)
    }

    func dismiss() {
        guard presentation != nil else { return }
        presentation = nil
        session = nil
    }

    /// Closes the menu, then runs the item on the next turn so modal prompts do not sit under it.
    func activate(_ trigger: @escaping () -> Void) {
        dismiss()
        DispatchQueue.main.async(execute: trigger)
    }
}

// MARK: - Items

/// `PrimitiveButtonStyle` so every existing `Button` in a menu body becomes a themed row, with its
/// action reachable (`trigger`) for keyboard activation.
struct WebMenuButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        WebMenuItemView(configuration: configuration)
    }
}

private struct WebMenuItemView: View {
    let configuration: PrimitiveButtonStyleConfiguration
    @Environment(\.webMenuSession) private var session
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @State private var id = UUID()

    private var danger: Bool { configuration.role == .destructive }
    private var highlighted: Bool { isEnabled && session?.highlighted == id }

    var body: some View {
        let clean = metrics.style == .clean
        configuration.label
            .labelStyle(WebMenuLabelStyle())
            .environment(\.webMenuItemDanger, danger)
            .font(metrics.font(size: 13))
            .foregroundStyle(danger ? theme[.statusOffline] : theme[.fg])
            .lineLimit(1)
            .frame(maxWidth: .infinity, minHeight: clean ? metrics.size(30) : nil, alignment: .leading)
            .padding(.horizontal, metrics.size(clean ? 9 : 10))
            .padding(.vertical, metrics.size(clean ? 5 : 6))
            .background(
                RoundedRectangle(cornerRadius: clean ? metrics.size(4) : metrics.radius(.sm))
                    .fill(highlighted ? (danger ? theme[.statusOffline].opacity(0.12) : theme[.panelHover]) : .clear))
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.5)
            .onHover { inside in
                guard isEnabled, let session else { return }
                if inside {
                    session.highlighted = id
                    if session.openSubmenu != nil { session.openSubmenu = nil }
                } else if session.highlighted == id {
                    session.highlighted = nil
                }
            }
            .onTapGesture {
                guard isEnabled else { return }
                run()
            }
            .onAppear {
                session?.register(.init(id: id, enabled: isEnabled, opensSubmenu: false, trigger: run))
            }
            .onChange(of: isEnabled) {
                session?.register(.init(id: id, enabled: isEnabled, opensSubmenu: false, trigger: run))
            }
            .onDisappear { session?.unregister(id) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if isEnabled { run() } }
    }

    private func run() {
        let trigger = configuration.trigger
        WebMenuHost.shared.activate(trigger)
    }
}

/// 15px icon column in `--fg-muted` (inherits the danger colour), an 8px gap, then the title.
struct WebMenuLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.webMenuItemDanger) private var danger

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(8)) {
            configuration.icon
                .frame(width: metrics.size(15), height: metrics.size(15))
                .foregroundStyle(danger ? theme[.statusOffline] : theme[.fgMuted])
            configuration.title
        }
    }
}

/// 1px `--border` separator with 4px / 2px margins.
struct WebMenuDivider: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        if metrics.isWebInterface {
            theme[.border]
                .frame(height: metrics.size(1))
                .padding(.vertical, metrics.size(4))
                .padding(.horizontal, metrics.size(2))
                .accessibilityHidden(true)
        } else {
            Divider()
        }
    }
}

/// A submenu: the native `Menu` in `.mac`, a hover/arrow-key flyout row in the web interface.
struct WebSubmenu<Content: View>: View {
    let title: LocalizedStringKey
    let symbol: String?
    @ViewBuilder let content: () -> Content
    @Environment(\.webMenuSession) private var session
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @State private var id = UUID()
    @State private var flyout = WebMenuSession()
    @State private var frame: CGRect = .zero
    @State private var flyoutSize: CGSize = .zero

    init(_ title: LocalizedStringKey, symbol: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.symbol = symbol
        self.content = content
    }

    private var isOpen: Bool { session?.openSubmenu == id }

    var body: some View {
        if metrics.isWebInterface, let session {
            row(session)
        } else {
            Menu(title, content: content)
        }
    }

    private func row(_ session: WebMenuSession) -> some View {
        let highlighted = isEnabled && (session.highlighted == id || isOpen)
        return HStack(spacing: metrics.size(8)) {
            if let symbol {
                Image(systemName: symbol).webProfileSized(14)
                    .frame(width: metrics.size(15), height: metrics.size(15))
                    .foregroundStyle(theme[.fgMuted])
            }
            Text(title).lineLimit(1)
            Spacer(minLength: metrics.size(12))
            Image(systemName: "chevron.right").webProfileSized(11)
                .foregroundStyle(theme[.fgMuted])
        }
        .font(metrics.font(size: 13))
        .foregroundStyle(theme[.fg])
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, metrics.size(10))
        .padding(.vertical, metrics.size(6))
        .background(RoundedRectangle(cornerRadius: metrics.radius(.sm))
            .fill(highlighted ? theme[.panelHover] : .clear))
        .contentShape(Rectangle())
        .opacity(isEnabled ? 1 : 0.5)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
        .onHover { inside in
            guard isEnabled else { return }
            if inside { session.highlighted = id; open(session) }
        }
        .onTapGesture { if isEnabled { open(session) } }
        .onAppear { session.register(.init(id: id, enabled: isEnabled, opensSubmenu: true, trigger: { open(session) })) }
        .onDisappear { session.unregister(id) }
        .overlay(alignment: .topLeading) {
            if isOpen {
                flyoutPanel
                    .onGeometryChange(for: CGSize.self) { $0.size } action: { flyoutSize = $0 }
                    .offset(x: flyoutOffsetX, y: -metrics.size(5))
                    .opacity(flyoutSize == .zero ? 0 : 1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if isEnabled { open(session) } }
    }

    private var flyoutOffsetX: CGFloat {
        let host = WebMenuHost.shared
        let windowWidth = host.layerView?.bounds.width ?? .greatestFiniteMagnitude
        let right = frame.maxX - host.layerOrigin.x + metrics.size(2) + flyoutSize.width
        return right + metrics.size(8) > windowWidth ? -flyoutSize.width - metrics.size(2) : frame.width + metrics.size(2)
    }

    private var flyoutPanel: some View {
        WebMenuChrome {
            content()
        }
        .environment(\.webMenuSession, flyout)
    }

    private func open(_ session: WebMenuSession) {
        flyout.parent = session
        session.child = flyout
        session.openSubmenu = id
        flyout.highlighted = nil
        DispatchQueue.main.async { flyout.move(1) }
    }
}

/// The panel surface shared by the root menu and flyouts.
struct WebMenuChrome<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        let clean = metrics.style == .clean
        let radius = clean ? metrics.size(4) : metrics.radius(.md)
        let shadow = theme.shadow(.md)
        VStack(alignment: .leading, spacing: 0) { content() }
            .buttonStyle(WebMenuButtonStyle())
            .labelStyle(WebMenuLabelStyle())
            .padding(metrics.size(4))
            .frame(minWidth: metrics.size(180), alignment: .leading)
            .fixedSize()
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            .shadow(color: clean ? .clear : shadow.color.color, radius: metrics.size(shadow.blur / 2),
                    x: metrics.size(shadow.x), y: metrics.size(shadow.y))
    }
}

/// A menu row with a trailing check for the current choice (replaces `Picker(.inline)` and `Toggle`).
struct WebMenuCheckRow: View {
    let title: Text
    let symbol: String
    let selected: Bool
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.size(12)) {
            Label { title } icon: { Image(systemName: symbol).webProfileSized(14) }
            Spacer(minLength: 0)
            if selected { Image(systemName: "checkmark").webProfileSized(11) }
        }
    }
}

// MARK: - Layer

/// Lifts the open menu above the whole window (the web portals to `body`, z-index 2000).
struct WebContextMenuLayer: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay { WebContextMenuLayerBody() }
    }
}

private struct WebContextMenuLayerBody: View {
    private let host = WebMenuHost.shared
    @State private var origin: CGPoint = .zero

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                if let presentation = host.presentation {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { host.dismiss() }
                        .accessibilityHidden(true)
                    WebMenuPanel(presentation: presentation, bounds: geometry.size)
                        .id(presentation.id)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            .onGeometryChange(for: CGPoint.self) { $0.frame(in: .global).origin } action: {
                origin = $0
                host.layerOrigin = $0
            }
        }
        .background(WebMenuMonitor())
        .allowsHitTesting(host.presentation != nil)
    }
}

private struct WebMenuPanel: View {
    let presentation: WebMenuHost.Presentation
    let bounds: CGSize
    @Environment(\.metrics) private var metrics
    @State private var session = WebMenuSession()
    @State private var size: CGSize = .zero
    @State private var shown = false

    var body: some View {
        let margin = metrics.size(presentation.usesDefaultChrome ? 8 : 10)
        let spot = position(margin: margin)
        let clean = metrics.style == .clean
        panelContent
            .environment(\.webMenuSession, session)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .scaleEffect(clean && !shown ? 0.96 : 1, anchor: .topLeading)
            .opacity(size == .zero || (clean && !shown) ? 0 : 1)
            .offset(x: spot.x, y: spot.y)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("web.contextMenu")
            .onAppear {
                WebMenuHost.shared.session = session
                withAnimation(metrics.reducesMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.18)) { shown = true }
            }
    }

    @ViewBuilder private var panelContent: some View {
        if presentation.usesDefaultChrome {
            WebMenuChrome { presentation.content }
        } else {
            presentation.content
        }
    }

    /// The web clamps to an 8px margin on every side (`ContextMenu.tsx`).
    private func position(margin: CGFloat) -> CGPoint {
        var x: CGFloat
        var y: CGFloat
        switch presentation.placement {
        case let .point(point):
            x = point.x
            y = point.y
        case let .anchor(rect, trailing):
            x = trailing ? rect.maxX - size.width : rect.minX
            y = rect.maxY + metrics.size(4)
            if y + size.height + margin > bounds.height, rect.minY - metrics.size(4) - size.height >= margin {
                y = rect.minY - metrics.size(4) - size.height
            }
        }
        x = max(margin, min(x, bounds.width - size.width - margin))
        y = max(margin, min(y, bounds.height - size.height - margin))
        return CGPoint(x: x, y: y)
    }
}

// MARK: - Triggers

/// Right-click source: registers an AppKit view whose bounds receive the menu request.
final class WebMenuTriggerView: NSView {
    var content: (() -> AnyView)?
    nonisolated(unsafe) static let registry = NSHashTable<WebMenuTriggerView>.weakObjects()

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { Self.registry.add(self) } else { Self.registry.remove(self) }
    }
}

private struct WebMenuTrigger: NSViewRepresentable {
    let content: () -> AnyView
    func makeNSView(context: Context) -> WebMenuTriggerView {
        let view = WebMenuTriggerView()
        view.content = content
        return view
    }
    func updateNSView(_ view: WebMenuTriggerView, context: Context) { view.content = content }
}

/// Window-wide event monitor: right clicks open the smallest registered trigger under the cursor;
/// while a menu is open, Escape/arrows/Return drive it.
private struct WebMenuMonitor: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = MonitorView()
        context.coordinator.view = view
        context.coordinator.install()
        WebMenuHost.shared.layerView = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) { WebMenuHost.shared.layerView = view }

    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.remove() }

    final class MonitorView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    @MainActor final class Coordinator {
        weak var view: NSView?
        private var monitor: Any?
        private var resign: NSObjectProtocol?

        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown, .keyDown]) { [weak self] event in
                nonisolated(unsafe) let unsafeEvent = event
                let consumed = MainActor.assumeIsolated { self?.handle(unsafeEvent) ?? false }
                return consumed ? nil : event
            }
            resign = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification,
                                                            object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { WebMenuHost.shared.dismiss() }
            }
        }

        func remove() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            if let resign { NotificationCenter.default.removeObserver(resign) }
            monitor = nil
            resign = nil
        }

        private func handle(_ event: NSEvent) -> Bool {
            guard let view, let window = view.window, event.window === window else { return false }
            let host = WebMenuHost.shared
            switch event.type {
            case .keyDown:
                return host.presentation != nil && key(event, host: host)
            case .rightMouseDown:
                return rightClick(event, view: view, window: window, host: host)
            case .leftMouseDown where event.modifierFlags.contains(.control):
                return rightClick(event, view: view, window: window, host: host)
            default:
                return false
            }
        }

        private func rightClick(_ event: NSEvent, view: NSView, window: NSWindow, host: WebMenuHost) -> Bool {
            host.dismiss()
            var best: (WebMenuTriggerView, CGFloat)?
            for trigger in WebMenuTriggerView.registry.allObjects where trigger.window === window && !trigger.isHiddenOrHasHiddenAncestor {
                let local = trigger.convert(event.locationInWindow, from: nil)
                guard trigger.visibleRect.contains(local) else { continue }
                let area = trigger.bounds.width * trigger.bounds.height
                if best == nil || area < best!.1 { best = (trigger, area) }
            }
            guard let trigger = best?.0, let content = trigger.content else { return false }
            let point = view.convert(event.locationInWindow, from: nil)
            host.present(at: CGPoint(x: point.x, y: view.isFlipped ? point.y : view.bounds.height - point.y),
                         content: content())
            return true
        }

        private func key(_ event: NSEvent, host: WebMenuHost) -> Bool {
            guard let root = host.session else { return false }
            let active = root.active
            switch event.keyCode {
            case 53:
                if let parent = active.parent { parent.openSubmenu = nil } else { host.dismiss() }
            case 125: active.move(1)
            case 126: active.move(-1)
            case 48: active.move(event.modifierFlags.contains(.shift) ? -1 : 1)
            case 36, 76, 49: active.activateHighlighted()
            case 124:
                if let entry = active.entries.first(where: { $0.id == active.highlighted && $0.opensSubmenu }) { entry.trigger() }
            case 123:
                if let parent = active.parent { parent.openSubmenu = nil }
            default: return false
            }
            return true
        }
    }
}

// MARK: - Public API

private struct WebContextMenuModifier<Menu: View>: ViewModifier {
    @ViewBuilder let menu: () -> Menu
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.background(WebMenuTrigger { AnyView(menu()) })
        } else {
            content.contextMenu { menu() }
        }
    }
}

extension View {
    /// Right-click menu: the themed web panel in the web interface, `.contextMenu` otherwise.
    func webContextMenu<Menu: View>(@ViewBuilder _ menu: @escaping () -> Menu) -> some View {
        modifier(WebContextMenuModifier(menu: menu))
    }
}

/// A button that opens its menu below itself: the themed panel in the web interface, `Menu` otherwise.
struct WebMenu<Content: View, Label: View>: View {
    @ViewBuilder let content: () -> Content
    @ViewBuilder let label: () -> Label
    var trailing = false
    @Environment(\.metrics) private var metrics
    @State private var frame: CGRect = .zero

    var body: some View {
        if metrics.isWebInterface {
            Button {
                WebMenuHost.shared.present(anchor: frame, trailing: trailing, content: AnyView(content()))
            } label: { label() }
            .buttonStyle(.plain)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
        } else {
            Menu(content: content, label: label)
        }
    }
}
