import AletheDesign
import SwiftUI

/// Keep the existing native control while giving every web select the same themed listbox.
struct InterfaceSelect<Value: Hashable, Label: View>: View {
    @Binding var selection: Value
    let options: [Value]
    var appearance = WebSelectAppearance.standard
    var optionDisabled: (Value) -> Bool = { _ in false }
    var searchText: (Value) -> String = { String(describing: $0) }
    @ViewBuilder let label: (Value) -> Label
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface {
            WebDropdown(selection: $selection, options: options, appearance: appearance, searchText: searchText, optionDisabled: optionDisabled, label: label)
        } else {
            AletheSelect(selection: $selection, options: options, label: label)
        }
    }
}

/// Values from the raw select rules; their opened lists share Dropdown's listbox.
/// reset.css's 32px minimum wins over filter/sort's 28px height. Their background shorthands
/// also remove reset.css's arrow image; controls.module.css explicitly restores it for shortcuts.
struct WebSelectAppearance: Sendable {
    var height: CGFloat = 32
    var fontSize: CGFloat = 13
    var leading: CGFloat = 10
    var trailing: CGFloat = 9
    var background: ThemeToken = .bgSunken
    var radius: Metrics.Radius = .sm
    var raw = false
    var showsChevron = true

    static let standard = Self()
    static let input = Self(fontSize: 14, trailing: 10, radius: .md)
    static let pluginFilter = Self(fontSize: 12, leading: 6, trailing: 6, background: .bgElevated, raw: true, showsChevron: false)
    static let marketSort = Self(fontSize: 11, leading: 8, trailing: 8, raw: true, showsChevron: false)
    static let customAgent = Self(fontSize: 12, trailing: 10, background: .panel, radius: .md, raw: true, showsChevron: false)
    static let shortcut = Self(fontSize: 14, trailing: 10, radius: .md, raw: true)
}

/// The web has compact Home and Todo choice lists in addition to the standard select.
enum WebDropdownMenuStyle: Equatable, Sendable {
    case standard, todo, homeAgent, homeMode

    var isHome: Bool { self == .homeAgent || self == .homeMode }
    var minimumWidth: CGFloat { self == .homeAgent ? 176 : self == .homeMode ? 132 : 220 }
    var maximumWidth: CGFloat { self == .homeAgent ? 176 : self == .todo ? 300 : 320 }
    var maximumHeight: CGFloat { self == .todo ? 240 : 280 }
    var optionHeight: CGFloat { self == .homeAgent ? 36 : self == .homeMode ? 28 : 30 }
    var gap: CGFloat { self == .todo ? 0 : self == .standard ? 1 : 3 }
    var padding: CGFloat { self == .homeAgent || self == .homeMode ? 5 : 4 }
}

/// Action menus opened by modal content must be above the modal as well as pane chrome.
struct WebChoiceActionLayer: ViewModifier {
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        if metrics.isWebInterface { content.modifier(WebContextMenuLayer()) } else { content }
    }
}

struct WebDropdownTriggerState: Sendable {
    let open: Bool
    let hovering: Bool
    let focused: Bool
}
