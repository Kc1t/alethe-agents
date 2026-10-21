import AppKit
import AletheDesign
import SwiftUI

/// `RowSelect.module.css`: keep the brand artwork inside the same 20-point icon slot.
struct NewTerminalRowSelect<Selection: Hashable, Icon: View>: View {
    @Binding var selection: Selection
    let options: [Selection]
    let title: (Selection) -> String
    var detail: (Selection) -> String? = { _ in nil }
    var side: (Selection) -> String? = { _ in nil }
    var autofocus = false
    @ViewBuilder let icon: (Selection) -> Icon
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @State private var open = false
    @State private var active = 0
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        Button {
            if open { open = false } else { showOptions() }
        } label: {
            HStack(spacing: metrics.size(11)) {
                icon(selection).frame(width: metrics.size(20), height: metrics.size(20)).clipped()
                Text(verbatim: title(selection))
                    .font(metrics.font(size: 13.5)).lineLimit(1)
                Spacer(minLength: 0)
                if let text = side(selection) {
                    Text(verbatim: text).font(metrics.font(size: 11.5))
                        .foregroundStyle(theme[.fgFaint]).lineLimit(1)
                        .frame(maxWidth: metrics.size(210), alignment: .trailing)
                }
                Image(systemName: "chevron.down").font(metrics.font(size: 13))
                    .foregroundStyle(theme[.fgFaint])
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .padding(.horizontal, metrics.size(12))
            .frame(height: metrics.size(44))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme[.fg])
        .background(theme[open || hovering ? .panelHover : .bgSunken],
                    in: RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 12)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 12))
            .strokeBorder(theme[open || focused ? .accent : hovering ? .borderStrong : .border],
                          lineWidth: metrics.size(1)))
        .accessibilityIdentifier("newTerminal.rowSelect")
        .focused($focused)
        .opacity(enabled ? 1 : 0.55)
        .onDisappear { open = false }
        .onChange(of: enabled) { _, value in if !value { open = false } }
        .onKeyPress(.space) {
            if open { chooseActive() } else { showOptions() }
            return .handled
        }
        .onKeyPress(.home) { guard open else { return .ignored }; active = 0; return .handled }
        .onKeyPress(.end) { guard open else { return .ignored }; active = options.count - 1; return .handled }
        .onHover { hovering = $0 && enabled }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.return) {
            if open { chooseActive() } else { showOptions() }
            return .handled
        }
        .onKeyPress(.escape) {
            guard open else { return .ignored }
            open = false
            return .handled
        }
        .onKeyPress(.tab) { open = false; return .ignored }
        .onAppear { if autofocus { focused = true } }
        .background {
            WebDropdownPortal(open: open && enabled, height: dropdownHeight, metrics: metrics,
                minimumWidth: 0, maximumWidth: .infinity, gap: 6, rowSelect: true,
                content: AnyView(dropdown.environment(\.metrics, metrics).environment(\.theme, theme).environment(\.locale, locale).environment(\.colorScheme, colorScheme)),
                dismiss: { restoreFocus in open = false; if restoreFocus { focused = true } })
        }
        .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: open)
    }

    private var dropdownHeight: CGFloat {
        metrics.size(min(320, CGFloat(options.count) * (detail(selection) == nil ? 38 : 52) + 10))
    }

    private var dropdown: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: metrics.size(2)) {
                    ForEach(Array(options.enumerated()), id: \.offset) { index, value in
                        Button {
                            selection = value
                            open = false
                            focused = true
                        } label: {
                            HStack(spacing: metrics.size(11)) {
                                icon(value).frame(width: metrics.size(20), height: metrics.size(20)).clipped()
                                VStack(alignment: .leading, spacing: metrics.size(2)) {
                                    Text(verbatim: title(value)).font(metrics.font(size: 13))
                                    if let description = detail(value) {
                                        Text(verbatim: description).font(metrics.font(size: 11))
                                            .foregroundStyle(theme[.fgFaint])
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                if value == selection {
                                    Image(systemName: "checkmark").font(metrics.font(size: 13))
                                        .foregroundStyle(theme[.accent])
                                }
                            }
                            .lineLimit(1)
                            .padding(.horizontal, metrics.size(10))
                            .padding(.vertical, metrics.size(9))
                            .background(theme[value == selection ? .accentSoft : .panelHover]
                                .opacity(value == selection || active == index ? 1 : 0),
                                in: RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 9)))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onHover { if $0 { active = index } }
                        .accessibilityAddTraits(value == selection ? [.isSelected] : [])
                        .id(index)
                        .accessibilityIdentifier("newTerminal.rowSelect.option.\(index)")
                    }
                }.padding(metrics.size(5))
            }
            .frame(maxHeight: dropdownHeight)
            .foregroundStyle(theme[.fg])
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 14)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(metrics.style == .clean ? 4 : 14))
                .strokeBorder(theme[metrics.style == .clean ? .border : .borderStrong], lineWidth: metrics.size(1)))
            .shadow(color: theme.shadow(.lg).color.color.opacity(metrics.style == .clean ? 0 : 1), radius: metrics.size(16), y: metrics.size(8))
            .onAppear { proxy.scrollTo(active) }
            .onChange(of: active) { _, index in proxy.scrollTo(index) }
        }
    }

    private func showOptions() {
        guard enabled else { return }
        active = options.firstIndex(of: selection) ?? 0
        focused = true
        open = true
    }

    private func move(_ direction: Int) {
        guard !options.isEmpty else { return }
        if !open { showOptions() } else { active = (active + direction + options.count) % options.count }
    }

    private func chooseActive() {
        guard options.indices.contains(active) else { return }
        selection = options[active]
        open = false
    }
}

/// A window-local overlay; the `.mac` presentation continues to use the existing system sheet.
struct NewTerminalWebOverlay<Content: View>: View {
    let onClose: () -> Void
    @ViewBuilder let content: (@escaping () -> Void) -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var visible = false
    @State private var closing = false

    // CSS has no minimum: keep the footer usable, then let the body scroll.
    var defaultWidth: CGFloat = 500
    var minimumWidth: CGFloat = 440
    var minimumHeight: CGFloat = 240
    @State private var resized: CGSize?
    @State private var measuredHeight: CGFloat = 440
    @State private var displacement = CGSize.zero
    @State private var dragOrigin: CGSize?
    @State private var resizeOrigin: CGRect?

    init(onClose: @escaping () -> Void, defaultWidth: CGFloat = 500,
         minimumWidth: CGFloat = 440, minimumHeight: CGFloat = 240,
         @ViewBuilder content: @escaping (@escaping () -> Void) -> Content) {
        self.onClose = onClose
        self.defaultWidth = defaultWidth
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.content = content
    }

    var body: some View {
        GeometryReader { geometry in
            let maximum = CGSize(width: max(0, geometry.size.width - metrics.size(48)),
                                 height: max(0, geometry.size.height - metrics.size(80)))
            let size = CGSize(width: min(resized?.width ?? metrics.size(defaultWidth), maximum.width),
                              height: min(resized?.height ?? measuredHeight, maximum.height))
            ZStack {
                theme[.bgSunken].opacity(0.68)
                    .webModalBackdropMotion(visible: visible)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)
                content(close)
                    .environment(\.newTerminalModalHeight, resized == nil ? maximum.height : size.height)
                    .environment(\.webModalHasExplicitHeight, resized != nil)
                    .environment(\.webModalMove, { translation in move(translation, size: size, window: geometry.size) })
                    .environment(\.webModalEndMove, { dragOrigin = nil })
                    .environment(\.webModalReset, reset)
                    .frame(width: size.width)
                    .frame(height: resized == nil ? nil : size.height)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measuredHeight = $0 }
                    .overlay { resizeHandles(size: size, window: geometry.size, maximum: maximum) }
                    .shadow(color: theme.shadow(.lg).color.color, radius: metrics.size(40), y: metrics.size(16))
                    .webModalContentMotion(visible: visible, closing: closing)
                    .position(x: geometry.size.width / 2 + displacement.width,
                              y: geometry.size.height / 2 + displacement.height)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .onChange(of: geometry.size) { _, _ in reset() }
        }
        .backgroundPreferenceValue(NewTerminalDropdownKey.self) { menus in
            WebModalEscapeHandler {
                if let menu = menus.last { menu.dismiss() } else { close() }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .onAppear { reset(); visible = true }
        .onExitCommand(perform: close)
        .accessibilityAddTraits(.isModal)
    }

    private func reset() {
        resized = nil
        displacement = .zero
        dragOrigin = nil
        resizeOrigin = nil
    }

    private func move(_ translation: CGSize, size: CGSize, window: CGSize) {
        if dragOrigin == nil { dragOrigin = displacement }
        let origin = dragOrigin ?? .zero
        let x = max(0, (window.width - size.width) / 2 - metrics.size(24))
        let y = max(0, (window.height - size.height) / 2 - metrics.size(40))
        displacement = CGSize(width: min(x, max(-x, origin.width + translation.width)),
                              height: min(y, max(-y, origin.height + translation.height)))
    }

    private func resizeHandles(size: CGSize, window: CGSize, maximum: CGSize) -> some View {
        ForEach(0..<8) { index in
            let x: CGFloat = [0, 0.5, 1, 1, 1, 0.5, 0, 0][index]
            let y: CGFloat = [0, 0, 0, 0.5, 1, 1, 1, 0.5][index]
            Rectangle().fill(.clear)
                .frame(width: x == 0.5 ? max(0, size.width - metrics.size(24)) : metrics.size(8),
                       height: y == 0.5 ? max(0, size.height - metrics.size(24)) : metrics.size(8))
                .contentShape(Rectangle())
                .onHover { inside in
                    if inside {
                        (x == 0.5 ? NSCursor.resizeUpDown : y == 0.5 ? NSCursor.resizeLeftRight : NSCursor.crosshair).push()
                    } else { NSCursor.pop() }
                }
                .gesture(DragGesture(coordinateSpace: .global)
                    .onChanged { value in
                        if resizeOrigin == nil {
                            resizeOrigin = CGRect(x: (window.width - size.width) / 2 + displacement.width,
                                                  y: (window.height - size.height) / 2 + displacement.height,
                                                  width: size.width, height: size.height)
                        }
                        guard let original = resizeOrigin else { return }
                        let marginX = metrics.size(24), marginY = metrics.size(40)
                        let minWidth = min(metrics.size(minimumWidth), maximum.width)
                        let minHeight = min(metrics.size(minimumHeight), maximum.height)
                        var left = original.minX, right = original.maxX
                        var top = original.minY, bottom = original.maxY
                        if x == 0 { left = max(marginX, min(right - minWidth, original.minX + value.translation.width)) }
                        if x == 1 { right = min(window.width - marginX, max(left + minWidth, original.maxX + value.translation.width)) }
                        if y == 0 { top = max(marginY, min(bottom - minHeight, original.minY + value.translation.height)) }
                        if y == 1 { bottom = min(window.height - marginY, max(top + minHeight, original.maxY + value.translation.height)) }
                        resized = CGSize(width: right - left, height: bottom - top)
                        displacement = CGSize(width: (left + right - window.width) / 2,
                                              height: (top + bottom - window.height) / 2)
                    }
                    .onEnded { _ in resizeOrigin = nil })
                .position(x: size.width * x, y: size.height * y)
                .accessibilityHidden(true)
        }
    }

    private func close() {
        guard !closing else { return }
        closing = true
        visible = false
        Task { @MainActor in
            if !metrics.reducesMotion { try? await Task.sleep(for: .milliseconds(150)) }
            onClose()
        }
    }
}

// Lift menus out of the scrolling modal body, as the web's RowSelect portal does.
struct NewTerminalDropdown {
    let anchor: Anchor<CGRect>
    let content: AnyView
    let height: CGFloat
    let dismiss: () -> Void
    /// Width clamp in points before zoom (the web `Dropdown` menu is 220...320 wide).
    var minimumWidth: CGFloat = 0
    var maximumWidth: CGFloat = .infinity
}

struct NewTerminalDropdownKey: PreferenceKey {
    static var defaultValue: [NewTerminalDropdown] { [] }
    static func reduce(value: inout [NewTerminalDropdown], nextValue: () -> [NewTerminalDropdown]) {
        value.append(contentsOf: nextValue())
    }
}

struct NewTerminalDropdownLayer: ViewModifier {
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        content.overlayPreferenceValue(NewTerminalDropdownKey.self) { menus in
            GeometryReader { geometry in
                ForEach(Array(menus.enumerated()), id: \.offset) { _, menu in
                    let rect = geometry[menu.anchor]
                    let height = min(menu.height, max(0, geometry.size.height - metrics.size(16)))
                    let below = rect.maxY + metrics.size(6)
                    let top = below + height <= geometry.size.height
                        ? below : max(metrics.size(8), rect.minY - height - metrics.size(6))
                    let width = min(min(max(rect.width, metrics.size(menu.minimumWidth)), metrics.size(menu.maximumWidth)),
                                    max(0, geometry.size.width - metrics.size(16)))
                    let left = min(max(metrics.size(8), rect.minX), max(metrics.size(8), geometry.size.width - width - metrics.size(8)))
                    let outsideTrigger = Path { path in
                        path.addRect(CGRect(origin: .zero, size: geometry.size))
                        path.addRect(rect)
                    }
                    outsideTrigger.fill(.clear, style: FillStyle(eoFill: true))
                        .contentShape(outsideTrigger, eoFill: true)
                        .onTapGesture(perform: menu.dismiss)
                        .accessibilityHidden(true)
                    menu.content
                        .frame(width: width, height: height)
                        .onExitCommand(perform: menu.dismiss)
                        .position(x: left + width / 2, y: top + height / 2)
                }
            }
        }
    }
}

extension View {
    func newTerminalDropdownLayer() -> some View { modifier(NewTerminalDropdownLayer()) }
}

extension EnvironmentValues {
    @Entry var newTerminalModalHeight: CGFloat = 600
}

/// Apply to a modal header; the existing overlay supplies window-local movement and reset.
private struct WebModalHeader: ViewModifier {
    @Environment(\.webModalMove) private var move
    @Environment(\.webModalEndMove) private var endMove
    @Environment(\.webModalReset) private var reset

    func body(content: Content) -> some View {
        content.contentShape(Rectangle())
            .simultaneousGesture(DragGesture(coordinateSpace: .global)
                .onChanged { move($0.translation) }.onEnded { _ in endMove() })
            .onTapGesture(count: 2, perform: reset)
    }
}

extension View {
    func webModalHeader() -> some View { modifier(WebModalHeader()) }
}

extension EnvironmentValues {
    @Entry var webModalHasExplicitHeight = false
    @Entry var webModalMove: (CGSize) -> Void = { _ in }
    @Entry var webModalEndMove: () -> Void = {}
    @Entry var webModalReset: () -> Void = {}
}

/// Match the web modal's capture-phase Escape handling even when an AppKit text editor consumes it.
private struct WebModalEscapeHandler: NSViewRepresentable {
    let action: () -> Void
    func makeNSView(context: Context) -> WebModalEscapeView { WebModalEscapeView(action: action) }
    func updateNSView(_ view: WebModalEscapeView, context: Context) { view.action = action }
    static func dismantleNSView(_ view: WebModalEscapeView, coordinator: ()) { view.stop() }
}

@MainActor
private final class WebModalEscapeView: NSView {
    private struct Layer { weak var view: WebModalEscapeView? }
    private static var layers: [Layer] = []
    private var monitor: Any?
    var action: () -> Void

    init(action: @escaping () -> Void) {
        self.action = action
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stop()
        guard window != nil else { return }
        Self.layers.append(Layer(view: self))
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window, event.keyCode == 53,
                  Self.layers.compactMap(\.view).last === self else { return event }
            self.action()
            return nil
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        Self.layers.removeAll { $0.view == nil || $0.view === self }
    }
}
