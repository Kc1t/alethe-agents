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
    @State private var open = false
    @State private var active = 0
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        Button {
            if open { open = false } else { showOptions() }
        } label: {
            HStack(spacing: metrics.size(11)) {
                icon(selection).frame(width: metrics.size(20), height: metrics.size(20))
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
                    in: RoundedRectangle(cornerRadius: metrics.size(12)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(12))
            .strokeBorder(theme[open || focused ? .accent : hovering ? .borderStrong : .border],
                          lineWidth: metrics.size(1)))
        .focused($focused)
        .onHover { hovering = $0 }
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
        .anchorPreference(key: NewTerminalDropdownKey.self, value: .bounds) { anchor in
            open ? [NewTerminalDropdown(anchor: anchor, content: AnyView(dropdown), height: dropdownHeight, dismiss: { open = false })] : []
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
                                icon(value).frame(width: metrics.size(20), height: metrics.size(20))
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
                                in: RoundedRectangle(cornerRadius: metrics.size(9)))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onHover { if $0 { active = index } }
                        .accessibilityAddTraits(value == selection ? [.isSelected] : [])
                        .id(index)
                    }
                }.padding(metrics.size(5))
            }
            .frame(height: dropdownHeight)
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.size(14)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(14))
                .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
            .shadow(color: theme.shadow(.lg).color.color, radius: metrics.size(16), y: metrics.size(8))
            .onAppear { proxy.scrollTo(active) }
            .onChange(of: active) { _, index in proxy.scrollTo(index) }
        }
    }

    private func showOptions() {
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

extension Motion {
    /// CSS modalSpringPop timing, without transforming the layout for interface zoom.
    fileprivate static var terminalEntrance: Animation { .timingCurve(0.175, 0.885, 0.32, 1.275, duration: 0.25) }
    fileprivate static var terminalExit: Animation { .timingCurve(0.4, 0, 0.2, 1, duration: 0.15) }
}

/// A window-local overlay; the `.mac` presentation continues to use the existing system sheet.
struct NewTerminalWebOverlay<Content: View>: View {
    let onClose: () -> Void
    @ViewBuilder let content: (@escaping () -> Void) -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var visible = false
    @State private var closing = false

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                theme[.bgSunken].opacity(visible ? 0.68 : 0)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)
                    .animation(metrics.reducesMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.2), value: visible)
                content(close)
                    .environment(\.newTerminalModalHeight, max(0, geometry.size.height - metrics.size(80)))
                    .frame(width: min(metrics.size(500), max(0, geometry.size.width - metrics.size(48))))
                    .frame(maxHeight: max(0, geometry.size.height - metrics.size(80)))
                    .shadow(color: theme.shadow(.lg).color.color, radius: metrics.size(40), y: metrics.size(16))
                    .opacity(visible ? 1 : 0)
                    .offset(y: visible || metrics.reducesMotion ? 0 : metrics.size(20))
                    .animation(metrics.reducesMotion ? nil : closing ? Motion.terminalExit : Motion.terminalEntrance, value: visible)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .ignoresSafeArea()
        .onAppear { visible = true }
        .onExitCommand(perform: close)
        .accessibilityAddTraits(.isModal)
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
                    let below = rect.maxY + metrics.size(6)
                    let top = below + menu.height <= geometry.size.height
                        ? below : max(metrics.size(8), rect.minY - menu.height - metrics.size(6))
                    Rectangle().fill(.clear).contentShape(Rectangle()).onTapGesture(perform: menu.dismiss)
                    menu.content
                        .frame(width: rect.width)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .offset(x: rect.minX, y: top)
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
