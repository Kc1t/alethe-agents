import AletheDesign
import SwiftUI

/// `ui/Dropdown.tsx` + `Dropdown.module.css`: a 32-point sunken trigger and a themed listbox
/// lifted into the modal's dropdown layer, in place of the system pop-up menu.
struct WebDropdown<Value: Hashable, Label: View>: View {
    @Binding var selection: Value
    let options: [Value]
    var isDisabled = false
    @ViewBuilder let label: (Value) -> Label
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var accessibilityID = "web.dropdown"
    @State private var open = false
    @State private var active = 0
    @State private var hovering = false
    @FocusState private var focused: Bool

    init(selection: Binding<Value>, options: [Value], isDisabled: Bool = false,
         @ViewBuilder label: @escaping (Value) -> Label) {
        _selection = selection
        self.options = options
        self.isDisabled = isDisabled
        self.label = label
    }

    var body: some View {
        let radius = metrics.radius(.sm)
        Button {
            if open { open = false } else { show() }
        } label: {
            HStack(spacing: metrics.size(8)) {
                label(selection).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down").font(metrics.font(size: 14))
                    .foregroundStyle(theme[.fgFaint])
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .font(metrics.font(size: 13))
            .padding(.leading, metrics.size(10)).padding(.trailing, metrics.size(9))
            .frame(height: metrics.size(metrics.style == .clean ? 30 : 32))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: radius))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityID)
        .foregroundStyle(theme[open || hovering || focused ? .fg : .fgMuted])
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: radius))
        .overlay(RoundedRectangle(cornerRadius: radius)
            .strokeBorder(theme[open || hovering || focused ? .accent : .border], lineWidth: metrics.size(1)))
        .opacity(isDisabled ? 0.55 : 1)
        .disabled(isDisabled)
        .focused($focused)
        .onHover { hovering = $0 && !isDisabled }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.return) {
            if open { chooseActive() } else { show() }
            return .handled
        }
        .onKeyPress(.escape) {
            guard open else { return .ignored }
            open = false
            return .handled
        }
        .onKeyPress(.tab) { open = false; return .ignored }
        .anchorPreference(key: NewTerminalDropdownKey.self, value: .bounds) { anchor in
            open ? [NewTerminalDropdown(anchor: anchor, content: AnyView(menu), height: menuHeight,
                                        dismiss: { open = false }, minimumWidth: 220, maximumWidth: 320)] : []
        }
        .onChange(of: isDisabled) { _, disabled in if disabled { open = false } }
        .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: open)
    }

    /// `estimatedHeight`: 32 per option plus 8, between 40 and 280.
    private var menuHeight: CGFloat { metrics.size(min(280, max(40, CGFloat(options.count) * 32 + 8))) }

    private var menu: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: metrics.size(1)) {
                    ForEach(Array(options.enumerated()), id: \.offset) { index, value in
                        let selected = value == selection
                        Button {
                            selection = value
                            open = false
                            focused = true
                        } label: {
                            label(value).lineLimit(1)
                                .font(metrics.font(size: 11))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, metrics.size(8))
                                .frame(minHeight: metrics.size(30))
                                .foregroundStyle(theme[selected ? .accent : active == index ? .fg : .fgMuted])
                                .background(theme[.panelHover].opacity(selected || active == index ? 1 : 0),
                                            in: RoundedRectangle(cornerRadius: metrics.size(4)))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onHover { if $0 { active = index } }
                        .accessibilityAddTraits(selected ? [.isSelected] : [])
                        .id(index)
                        .accessibilityIdentifier("\(accessibilityID).option.\(index)")
                    }
                }
                .padding(metrics.size(4))
            }
            .frame(maxHeight: menuHeight)
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
            .shadow(color: theme.shadow(.md).color.color, radius: metrics.size(15), y: metrics.size(12))
            .onAppear { proxy.scrollTo(active) }
            .onChange(of: active) { _, index in proxy.scrollTo(index) }
        }
    }

    private func show() {
        active = options.firstIndex(of: selection) ?? 0
        focused = true
        open = true
    }

    private func move(_ direction: Int) {
        guard !options.isEmpty else { return }
        if !open { show() } else { active = (active + direction + options.count) % options.count }
    }

    private func chooseActive() {
        guard options.indices.contains(active) else { return }
        selection = options[active]
        open = false
    }
}

/// A settings-style row: title (and optional help) on the left, a `WebDropdown` on the right.
struct WebSelectRow<Value: Hashable>: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?
    @Binding var selection: Value
    let options: [Value]
    let optionTitle: (Value) -> String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .center, spacing: metrics.size(16)) {
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Text(title).font(metrics.font(size: 13))
                if let detail {
                    Text(detail).font(metrics.font(size: 10)).foregroundStyle(theme[.textSecondary])
                }
            }
            Spacer(minLength: 0)
            WebDropdown(selection: $selection, options: options) { Text(verbatim: optionTitle($0)) }
                .frame(width: metrics.size(220))
        }
    }
}
