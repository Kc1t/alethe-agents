import AletheDesign
import SwiftUI

/// `ui/Dropdown.tsx` + `Dropdown.module.css`: a 32-point sunken trigger and a themed listbox
/// presented in the owning window, in place of the system pop-up menu.
struct WebDropdown<Value: Hashable, Label: View>: View {
    @Binding var selection: Value
    let options: [Value]
    var isDisabled = false
    @ViewBuilder let label: (Value) -> Label
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var menuStyle = WebDropdownMenuStyle.standard
    var appearance = WebSelectAppearance.standard
    var trigger: ((Value, WebDropdownTriggerState) -> AnyView)?
    var accessibilityID = "web.dropdown"
    var searchable = false
    var searchPlaceholder = ""
    var emptyLabel: (String) -> String = { _ in "" }
    var searchText: (Value) -> String = { String(describing: $0) }
    var customValue: ((String) -> Value)?
    var customOptionLabel: (String) -> String = { $0 }
    var displayValue: String?
    var placeholder: String?
    var optionDisabled: (Value) -> Bool = { _ in false }
    @Environment(\.isEnabled) private var enabled
    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @State private var typeAhead = ""
    @State private var typeAheadTime = Date.distantPast
    @State private var search = ""
    @FocusState private var searchFocused: Bool
    @State private var optionsHeight: CGFloat = 0
    @State private var searchHeight: CGFloat = 0
    @State private var open = false
    @State private var active = 0
    @State private var hovering = false
    @FocusState private var focused: Bool

    init(selection: Binding<Value>, options: [Value], isDisabled: Bool = false,
         accessibilityID: String = "web.dropdown", appearance: WebSelectAppearance = .standard,
         menuStyle: WebDropdownMenuStyle = .standard, searchable: Bool = false,
         searchPlaceholder: String = "", emptyLabel: @escaping (String) -> String = { _ in "" },
         searchText: @escaping (Value) -> String = { String(describing: $0) },
         customValue: ((String) -> Value)? = nil, customOptionLabel: @escaping (String) -> String = { $0 },
         displayValue: String? = nil, placeholder: String? = nil,
         optionDisabled: @escaping (Value) -> Bool = { _ in false },
         trigger: ((Value, WebDropdownTriggerState) -> AnyView)? = nil,
         @ViewBuilder label: @escaping (Value) -> Label) {
        _selection = selection
        self.options = options
        self.isDisabled = isDisabled
        self.accessibilityID = accessibilityID
        self.label = label
        self.menuStyle = menuStyle
        self.appearance = appearance
        self.searchable = searchable
        self.searchPlaceholder = searchPlaceholder
        self.emptyLabel = emptyLabel
        self.searchText = searchText
        self.customValue = customValue
        self.customOptionLabel = customOptionLabel
        self.displayValue = displayValue
        self.placeholder = placeholder
        self.optionDisabled = optionDisabled
        self.trigger = trigger
    }

    var body: some View {
        let radius = metrics.style == .clean ? metrics.size(4) : metrics.radius(appearance.radius)
        Button {
            if open { open = false } else { show() }
        } label: {
            if let trigger { trigger(selection, WebDropdownTriggerState(open: open, hovering: hovering, focused: focused)) } else {
                HStack(spacing: metrics.size(8)) {
                    Group {
                        if let displayValue { Text(verbatim: displayValue) }
                        else if !options.contains(selection), let placeholder { Text(verbatim: placeholder) }
                        else { label(selection) }
                    }.lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if appearance.showsChevron {
                    Image(systemName: "chevron.down").resizable().scaledToFit()
                        .frame(width: metrics.size(appearance.raw ? 10 : 14), height: metrics.size(appearance.raw ? 6 : 14))
                        .foregroundStyle(theme[.fgFaint])
                        .rotationEffect(.degrees(open && !appearance.raw ? 180 : 0))
                    }
                }
                .font(metrics.font(size: appearance.fontSize))
                .padding(.leading, metrics.size(appearance.leading)).padding(.trailing, metrics.size(appearance.trailing))
                .frame(height: metrics.size(metrics.style == .clean ? min(30, appearance.height) : appearance.height))
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(RoundedRectangle(cornerRadius: radius))
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityID)
        .foregroundStyle(theme[appearance.raw || open || hovering || focused ? .fg : .fgMuted])
        .background(theme[appearance.raw && hovering ? .panelHover : appearance.background].opacity(trigger == nil ? 1 : 0), in: RoundedRectangle(cornerRadius: radius))
        .overlay(RoundedRectangle(cornerRadius: radius)
            .strokeBorder(theme[open ? (metrics.style == .clean ? .borderStrong : .accent) : focused ? .accent : hovering ? (appearance.raw ? .borderStrong : .accent) : .border].opacity(trigger == nil ? 1 : 0), lineWidth: metrics.size(1)))
        .opacity(isDisabled || !enabled ? 0.55 : 1)
        .disabled(isDisabled)
        .focused($focused)
        .onHover { hovering = $0 && !isDisabled && enabled }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.space) {
            if open { if !searchable { chooseActive() } } else { show() }
            return .handled
        }
        .onKeyPress(.home) { guard open else { return .ignored }; active = enabledIndex(from: 0, direction: 1); return .handled }
        .onKeyPress(.end) { guard open else { return .ignored }; active = enabledIndex(from: choices.count - 1, direction: -1); return .handled }
        .onKeyPress(.return) {
            if open { if !searchable { chooseActive() } } else { show() }
            return .handled
        }
        .onKeyPress(.escape) {
            guard open else { return .ignored }
            open = false
            return .handled
        }
        .onKeyPress(.tab) { open = false; return .ignored }
        .onKeyPress(characters: .alphanumerics) { press in
            guard appearance.raw, !searchable, enabled && !isDisabled else { return .ignored }
            selectByTyping(press.characters)
            return .handled
        }
        .background {
            WebDropdownPortal(open: open && enabled && !isDisabled, height: menuHeight, metrics: metrics,
                minimumWidth: menuStyle.minimumWidth, maximumWidth: menuStyle.maximumWidth, gap: menuStyle == .standard || menuStyle == .todo ? 5 : 6,
                content: AnyView(menu.environment(\.metrics, metrics).environment(\.theme, theme).environment(\.locale, locale).environment(\.colorScheme, colorScheme)),
                dismiss: { restoreFocus in open = false; if restoreFocus { focused = true } })
        }
        .onDisappear { open = false }
        .onChange(of: enabled) { _, value in if !value { open = false } }
        .onChange(of: search) { _, _ in resetActive() }
        .onChange(of: options) { _, _ in resetActive() }
        .onChange(of: isDisabled) { _, disabled in if disabled { open = false } }
        .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: open)
    }

    private var visibleOptions: [Value] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? options : options.filter { searchText($0).localizedCaseInsensitiveContains(query) }
    }
    private var custom: Value? {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2, !options.contains(where: {
            searchText($0).localizedCaseInsensitiveCompare(query) == .orderedSame ||
            String(describing: $0).localizedCaseInsensitiveCompare(query) == .orderedSame
        }) else { return nil }
        return customValue?(query)
    }
    private var choices: [Value] { visibleOptions + (custom.map { [$0] } ?? []) }
    private var menuHeight: CGFloat {
        let limit = metrics.size(menuStyle.maximumHeight)
        guard optionsHeight > 0 else { return limit }
        return min(limit, optionsHeight + metrics.size(menuStyle.padding * 2)
                   + (searchable ? searchHeight + metrics.size(4) : 0))
    }

    private var menu: some View {
        ScrollViewReader { proxy in
            VStack(spacing: metrics.size(4)) {
                if searchable {
                    searchBox
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { searchHeight = $0 }
                }
                ScrollView {
                    VStack(spacing: metrics.size(menuStyle.gap)) {
                        ForEach(Array(choices.enumerated()), id: \.offset) { index, value in
                            optionRow(index, value: value)
                        }
                        if choices.isEmpty {
                            Text(verbatim: emptyLabel(search.trimmingCharacters(in: .whitespacesAndNewlines)))
                                .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                                .multilineTextAlignment(.center).padding(.vertical, metrics.size(12))
                                .padding(.horizontal, metrics.size(8)).frame(maxWidth: .infinity)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { optionsHeight = $0 }
                }.webScrollStyle()
            }
            .padding(metrics.size(menuStyle.padding))
            .frame(maxHeight: .infinity)
            .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.md))
                .strokeBorder(theme[metrics.style == .clean || menuStyle == .homeAgent ? .border : .borderStrong], lineWidth: metrics.size(1)))
            .shadow(color: (menuStyle.isHome ? theme.shadow(.md).color.color : theme[.bg].opacity(0.6))
                        .opacity(metrics.style == .clean ? 0 : 1),
                    radius: metrics.size(menuStyle.isHome ? theme.shadow(.md).blur / 2 : 15),
                    x: metrics.size(menuStyle.isHome ? theme.shadow(.md).x : 0),
                    y: metrics.size(menuStyle.isHome ? theme.shadow(.md).y : 12))
            .onAppear { proxy.scrollTo(active); searchFocused = searchable }
            .onChange(of: active) { _, index in proxy.scrollTo(index) }
        }
    }

    private var searchBox: some View {
        HStack(spacing: metrics.size(7)) {
            Image(systemName: "magnifyingglass").font(metrics.font(size: 13))
                .foregroundStyle(theme[.fgFaint])
            TextField(text: $search, prompt: Text(verbatim: searchPlaceholder)) { Text(verbatim: searchPlaceholder) }
                .textFieldStyle(.plain).font(metrics.font(size: 11))
                .foregroundStyle(theme[.fg]).focused($searchFocused)
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.home) { active = enabledIndex(from: 0, direction: 1); return .handled }
                .onKeyPress(.end) { active = enabledIndex(from: choices.count - 1, direction: -1); return .handled }
                .onSubmit { chooseActive() }
        }
        .padding(.horizontal, metrics.size(8)).frame(minHeight: metrics.size(30))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.sm)))
        .overlay(RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.sm))
            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }

    private func optionRow(_ index: Int, value: Value) -> some View {
        let selected = value == selection
        return Button {
            selection = value
            open = false
            focused = true
        } label: {
            Group {
                if index == visibleOptions.count, custom != nil {
                    Text(verbatim: customOptionLabel(search.trimmingCharacters(in: .whitespacesAndNewlines)))
                } else { label(value) }
            }.lineLimit(1)
                .font(menuStyle == .homeAgent || menuStyle == .homeMode ? metrics.monoFont(size: 10) : metrics.font(size: 11))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, metrics.size(menuStyle == .homeAgent ? 9 : 8))
                .frame(minHeight: metrics.size(menuStyle.optionHeight))
                .overlay(alignment: .top) {
                    if index == visibleOptions.count, custom != nil {
                        theme[.border].frame(height: metrics.size(1))
                    }
                }
                .padding(.top, index == visibleOptions.count && custom != nil ? metrics.size(3) : 0)
                .foregroundStyle(theme[index == visibleOptions.count && custom != nil ? .accent : selected ? (metrics.style == .clean || menuStyle == .homeMode || menuStyle == .homeAgent ? .fg : .accent) : active == index ? .fg : .fgMuted])
                .background(theme[.panelHover].opacity(selected || active == index ? 1 : 0),
                            in: RoundedRectangle(cornerRadius: menuStyle == .standard ? metrics.size(4) : metrics.radius(.sm)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(optionDisabled(value))
        .opacity(optionDisabled(value) ? 0.45 : 1)
        .onHover { if $0 && !optionDisabled(value) { active = index } }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .id(index)
        .accessibilityIdentifier("\(accessibilityID).option.\(index)")
    }

    private func selectByTyping(_ characters: String) {
        let now = Date()
        let previous = now.timeIntervalSince(typeAheadTime) < 1 ? typeAhead : ""
        let character = characters.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale)
        typeAhead = previous == character ? character : previous + character
        typeAheadTime = now
        guard !choices.isEmpty else { return }
        let current = open ? active : (options.firstIndex(of: selection) ?? -1)
        let start = typeAhead.count == 1 ? current + 1 : max(0, current)
        for offset in 0..<choices.count {
            let index = (start + offset + choices.count) % choices.count
            let value = choices[index]
            if !optionDisabled(value), searchText(value)
                .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale).hasPrefix(typeAhead) {
                active = index
                if !open { selection = value }
                return
            }
        }
    }

    private func resetActive() {
        active = choices.firstIndex(where: { $0 == selection && !optionDisabled($0) }) ?? enabledIndex(from: 0, direction: 1)
    }

    private func show() {
        guard enabled && !isDisabled else { return }
        search = ""
        active = options.firstIndex(where: { $0 == selection && !optionDisabled($0) }) ?? enabledIndex(from: 0, direction: 1)
        focused = true
        open = true
    }

    private func move(_ direction: Int) {
        if !open { show() } else { active = enabledIndex(from: active + direction, direction: direction) }
    }

    private func enabledIndex(from start: Int, direction: Int) -> Int {
        guard !choices.isEmpty else { return -1 }
        for offset in 0..<choices.count {
            let index = ((start + direction * offset) % choices.count + choices.count) % choices.count
            if !optionDisabled(choices[index]) { return index }
        }
        return -1
    }

    private func chooseActive() {
        guard choices.indices.contains(active), !optionDisabled(choices[active]) else { return }
        selection = choices[active]
        open = false
        focused = true
    }
}

/// A settings-style row: title (and optional help) on the left, a `WebDropdown` on the right.
struct WebSelectRow<Value: Hashable>: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?
    @Binding var selection: Value
    let options: [Value]
    var triggerWidth: CGFloat? = 220
    var titleSize: CGFloat = 13
    var titleWeight: Font.Weight = .regular
    var titleToken: ThemeToken = .fg
    var detailSize: CGFloat = 10
    var spacing: CGFloat = 16
    let optionTitle: (Value) -> String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .center, spacing: metrics.size(spacing)) {
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Text(title).font(metrics.font(size: titleSize, weight: titleWeight)).foregroundStyle(theme[titleToken])
                if let detail {
                    Text(detail).font(metrics.font(size: detailSize)).foregroundStyle(theme[.fgMuted])
                }
            }
            Spacer(minLength: 0)
            WebDropdown(selection: $selection, options: options) { Text(verbatim: optionTitle($0)) }
                .frame(width: triggerWidth.map { metrics.size($0) })
                .fixedSize(horizontal: triggerWidth == nil, vertical: false)
        }
    }
}
