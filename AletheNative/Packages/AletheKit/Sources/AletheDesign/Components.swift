import AppKit
import SwiftUI

// Shared controls drawn with theme tokens, mirroring the web app's primitives
// (`modals/controls.module.css`, `ui/Dropdown.module.css`, `TitleBar.module.css`). Sizes are the
// web's px values passed through `Metrics`, so they follow the UI scale and the Clean style.

extension Metrics {
    /// A UI font at an exact design size (the web uses sizes such as 12.5 that no text style covers).
    public func font(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size * scale, weight: weight)
    }

    /// CSS numeric font weights, including the sidebar headers' intermediate 650 weight.
    public func font(size: CGFloat, weight: Int) -> Font {
        let stops: [(Int, NSFont.Weight)] = [
            (100, .ultraLight), (200, .thin), (300, .light), (400, .regular), (500, .medium),
            (600, .semibold), (700, .bold), (800, .heavy), (900, .black),
        ]
        let value = min(900, max(100, weight))
        let lower = stops.last { $0.0 <= value } ?? stops[0]
        let upper = stops.first { $0.0 >= value } ?? stops[stops.count - 1]
        let fraction = upper.0 == lower.0 ? 0 : CGFloat(value - lower.0) / CGFloat(upper.0 - lower.0)
        let raw = lower.1.rawValue + (upper.1.rawValue - lower.1.rawValue) * fraction
        return Font(NSFont.systemFont(ofSize: size * scale, weight: NSFont.Weight(rawValue: raw)))
    }

    public func monoFont(size: CGFloat, weight: Font.Weight) -> Font {
        .custom(AletheFonts.terminalFamily, size: size * scale).weight(weight)
    }
}

// MARK: - Buttons

/// Text button (`.btn`, `.btnPrimary`, `.btnDanger`, `.btnSm`).
public struct AletheButtonStyle: ButtonStyle {
    public enum Kind: Sendable { case secondary, primary, danger }
    public enum Size: Sendable { case regular, small }

    let kind: Kind
    let size: Size

    public init(_ kind: Kind = .secondary, size: Size = .regular) {
        self.kind = kind
        self.size = size
    }

    public func makeBody(configuration: Configuration) -> some View {
        AletheButtonBody(configuration: configuration, kind: kind, size: size)
    }
}

private struct AletheButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let kind: AletheButtonStyle.Kind
    let size: AletheButtonStyle.Size
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let small = size == .small
        let radius = metrics.radius(small ? .sm : .md)
        configuration.label
            .font(metrics.font(size: small ? 11.5 : 13, weight: .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, metrics.size(small ? 10 : 14))
            .padding(.vertical, metrics.size(small ? 4 : 7))
            .background(background, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(border))
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .opacity(isEnabled ? 1 : 0.5)
            .pressFeedback(configuration.isPressed, metrics: metrics)
            .onHover { hovering = $0 && isEnabled }
    }

    private var foreground: Color {
        switch kind {
        case .secondary: theme[.fg]
        case .primary: theme[.accentOn]
        case .danger: theme[.fg]
        }
    }

    private var background: Color {
        switch kind {
        case .secondary: theme[hovering ? .panelHover : .panel]
        case .primary: theme[hovering ? .accentStrong : .accent]
        case .danger: theme[.statusOffline].opacity(hovering ? 0.85 : 1)
        }
    }

    private var border: Color {
        switch kind {
        case .secondary: theme[hovering ? .borderStrong : .border]
        case .primary, .danger: .clear
        }
    }
}

/// Square icon-only button (title bar `iconBtn` 28, header actions 24, pane actions 20).
/// `isOn` draws the pressed-in state the web uses for toggles (sunken with an inset strong border).
public struct AletheIconButtonStyle: ButtonStyle {
    let side: CGFloat
    let isOn: Bool

    public init(side: CGFloat = 28, isOn: Bool = false) {
        self.side = side
        self.isOn = isOn
    }

    public func makeBody(configuration: Configuration) -> some View {
        AletheIconButtonBody(configuration: configuration, side: side, isOn: isOn)
    }
}

private struct AletheIconButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let side: CGFloat
    let isOn: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let radius = metrics.radius(.sm)
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 13))
            .foregroundStyle(theme[hovering || isOn ? .fg : .fgMuted])
            .frame(width: metrics.size(side), height: metrics.size(side))
            .background(fill, in: RoundedRectangle(cornerRadius: radius))
            .overlay {
                if isOn { RoundedRectangle(cornerRadius: radius).strokeBorder(theme[.borderStrong]) }
            }
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .opacity(isEnabled ? 1 : 0.28)
            .pressFeedback(configuration.isPressed, metrics: metrics)
            .onHover { hovering = $0 && isEnabled }
    }

    private var fill: Color {
        if isOn { return theme[.bgSunken] }
        return hovering ? theme[.panelHover] : .clear
    }
}

extension View {
    /// Pressed feedback on mouse-down (web `button:active { scale(.97) }`); Clean style stays flat.
    fileprivate func pressFeedback(_ pressed: Bool, metrics: Metrics) -> some View {
        let lifts = metrics.style == .normal && !metrics.reducesMotion
        return scaleEffect(pressed && lifts ? 0.97 : 1)
            .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: pressed)
    }
}

// MARK: - Select

/// The themed select trigger (`ui/Dropdown`): a sunken 32pt field with a chevron. The menu itself
/// is the system menu, which already matches the platform.
public struct AletheSelect<Value: Hashable, Label: View>: View {
    @Binding var selection: Value
    let options: [Value]
    let label: (Value) -> Label
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    public init(selection: Binding<Value>, options: [Value], @ViewBuilder label: @escaping (Value) -> Label) {
        _selection = selection
        self.options = options
        self.label = label
    }

    public var body: some View {
        let radius = metrics.radius(.sm)
        Menu {
            ForEach(options, id: \.self) { option in
                Toggle(isOn: Binding(get: { selection == option }, set: { if $0 { selection = option } })) {
                    label(option)
                }
            }
        } label: {
            HStack(spacing: metrics.space(.s)) {
                label(selection)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(metrics.font(size: 10, weight: .semibold))
                    .foregroundStyle(theme[.fgFaint])
            }
            .font(metrics.font(size: 12))
            .foregroundStyle(theme[hovering ? .fg : .fgMuted])
            .padding(.leading, metrics.size(10))
            .padding(.trailing, metrics.size(9))
            .frame(height: metrics.size(metrics.style == .clean ? 30 : 32))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(theme[hovering ? .accentBorder : .border]))
            .contentShape(RoundedRectangle(cornerRadius: radius))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .onHover { hovering = $0 }
    }
}

// MARK: - Surfaces

/// A content card: card surface, subtle border, large radius (web home and panel cards).
public struct AletheCard: ViewModifier {
    let padding: Metrics.Space
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public func body(content: Content) -> some View {
        let radius = metrics.radius(.lg)
        content
            .padding(metrics.space(padding))
            .background(theme[.surfaceCardDefault], in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(theme[.borderSubtle]))
    }
}

extension View {
    public func aletheCard(padding: Metrics.Space = .xl) -> some View {
        modifier(AletheCard(padding: padding))
    }
}

/// A row that highlights on hover and when selected (sidebar project and terminal rows:
/// 28pt, `radius-md`, `panel-hover`).
public struct AletheRowBackground: ViewModifier {
    let isSelected: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    public func body(content: Content) -> some View {
        let radius = metrics.style == .clean ? 0 : metrics.radius(.md)
        content
            .background(theme[.panelHover].opacity(isSelected || hovering ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: radius))
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .onHover { hovering = $0 }
    }
}

extension View {
    public func aletheRowBackground(isSelected: Bool) -> some View {
        modifier(AletheRowBackground(isSelected: isSelected))
    }
}

// MARK: - Labels and badges

/// Uppercase section label (`PROJECTS`: 11pt bold, 0.08em tracking, muted).
public struct AletheSectionLabel: View {
    let title: Text
    let tracking: CGFloat
    let color: ThemeToken
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init(_ title: Text, tracking: CGFloat = 0.88, color: ThemeToken = .fgMuted) {
        self.title = title
        self.tracking = tracking
        self.color = color
    }

    public var body: some View {
        title
            .textCase(.uppercase)
            .font(metrics.font(size: 11, weight: .bold))
            .tracking(metrics.size(tracking))
            .foregroundStyle(theme[color])
            .accessibilityAddTraits(.isHeader)
    }
}

/// Small count pill (tab counts: min 18×14, radius 7, panel fill, 9pt bold faint).
public struct AletheCountPill: View {
    let count: Int
    let monospaced: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init(_ count: Int, monospaced: Bool = false) {
        self.count = count
        self.monospaced = monospaced
    }

    public var body: some View {
        Text(verbatim: "\(count)")
            .font(monospaced ? metrics.monoFont(size: 10) : metrics.font(size: 9, weight: .bold).monospacedDigit())
            .foregroundStyle(theme[.fgFaint])
            .padding(.horizontal, metrics.size(4))
            .frame(minWidth: metrics.size(18), minHeight: metrics.size(14))
            .background(theme[.panel], in: Capsule())
    }
}

/// Status dot (8pt). `glows` adds the soft halo the web pulses on working terminals.
public struct AletheStatusDot: View {
    let color: ThemeToken
    let side: CGFloat
    let glows: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init(_ color: ThemeToken, side: CGFloat = 8, glows: Bool = false) {
        self.color = color
        self.side = side
        self.glows = glows
    }

    public var body: some View {
        Circle()
            .fill(theme[color])
            .frame(width: metrics.size(side), height: metrics.size(side))
            .shadow(color: glows ? theme[color].opacity(0.6) : .clear, radius: metrics.size(3))
            .accessibilityHidden(true)
    }
}

/// Project monogram (`normalSidebarPrimitives`): project color tile, two lowercase initials in the
/// mono font at 0.46× the tile, radius 6, with a faint inner highlight.
public struct AletheMonogram: View {
    let initials: String
    let color: Color
    let side: CGFloat
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init(name: String, color: Color, side: CGFloat = 15) {
        initials = Self.initials(of: name)
        self.color = color
        self.side = side
    }

    public var body: some View {
        let length = metrics.size(side)
        let radius = metrics.isWebInterface ? metrics.size(6) : metrics.style == .clean ? metrics.radius(.sm) : metrics.size(min(6, side * 0.4))
        Text(verbatim: initials)
            .font(metrics.isWebInterface ? metrics.monoFont(size: (side * 0.46).rounded(), weight: .bold)
                  : .custom(AletheFonts.terminalFamily, size: length * 0.46).weight(.bold))
            .foregroundStyle(theme[.accentOn])
            .frame(width: length, height: length)
            .background(color, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder((metrics.isWebInterface ? theme[.fg] : Color.white).opacity(0.08)))
            .accessibilityHidden(true)
    }

    /// First letters of the first two words, else the first two characters.
    static func initials(of name: String) -> String {
        let words = name.split { !$0.isLetter && !$0.isNumber }
        let letters = words.count >= 2
            ? words.prefix(2).compactMap(\.first).map(String.init).joined()
            : String((words.first ?? Substring(name)).prefix(2))
        return letters.lowercased()
    }
}

// MARK: - Activity

/// The working-terminal spinner (`DotmCircular2`): a 14pt 4×4 dot grid whose 12 perimeter dots
/// light in turn over 1.8s, with a short fading tail. Reduce Motion shows a steady dot.
public struct AletheActivitySpinner: View {
    let color: ThemeToken
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init(_ color: ThemeToken = .statusWorking) { self.color = color }

    /// Perimeter cells of a 4×4 grid, clockwise from the top-left.
    static let perimeter: [(Int, Int)] = [
        (0, 0), (1, 0), (2, 0), (3, 0), (3, 1), (3, 2), (3, 3), (2, 3), (1, 3), (0, 3), (0, 2), (0, 1),
    ]

    @ViewBuilder public var body: some View {
        if metrics.isWebInterface { webSpinner } else { nativeSpinner }
    }

    private var webSpinner: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24, paused: metrics.reducesMotion)) { context in
            Canvas { canvas, _ in
                let ring = [1, 2, 3, 9, 14, 19, 23, 22, 21, 15, 10, 5]
                for index in 0..<25 {
                    let row = index / 5
                    let column = index % 5
                    if (row == 0 || row == 4) && (column == 0 || column == 4) { continue }
                    var alpha = index == 12 ? 0.4 : 0.08
                    var expansion = 1.0
                    if let order = ring.firstIndex(of: index) {
                        let phase = (context.date.timeIntervalSinceReferenceDate + Double(order) * 0.05 / 1.2)
                            .truncatingRemainder(dividingBy: 1.5) / 1.5
                        let step = Int(phase * 12) % 4
                        alpha = metrics.reducesMotion ? 0.4 : step == 0 ? 0.95 : step == 1 || step == 2 ? 0.4 : 0.08
                        expansion = !metrics.reducesMotion && step == 0 ? 1.12 : 1
                    }
                    let dot = metrics.size(2) * expansion
                    let centerX = metrics.size(1 + CGFloat(column) * 3)
                    let centerY = metrics.size(1 + CGFloat(row) * 3)
                    let rect = CGRect(x: centerX - dot / 2, y: centerY - dot / 2, width: dot, height: dot)
                    canvas.fill(Path(ellipseIn: rect), with: .color(theme[color].opacity(alpha)))
                }
            }
            .frame(width: metrics.size(14), height: metrics.size(14))
            .shadow(color: theme[color], radius: metrics.size(2))
        }
    }

    @ViewBuilder private var nativeSpinner: some View {
        let side = metrics.size(14)
        if metrics.reducesMotion {
            AletheStatusDot(color, side: 7)
                .frame(width: side, height: side)
        } else {
            TimelineView(.periodic(from: .now, by: 1.8 / 12)) { context in
                let step = Int(context.date.timeIntervalSinceReferenceDate / (1.8 / 12)) % 12
                Canvas { canvas, size in
                    let dot = size.width / 7
                    let pitch = (size.width - dot) / 3
                    for (index, cell) in Self.perimeter.enumerated() {
                        let age = (step - index + 12) % 12
                        let alpha = age == 0 ? 1 : age == 1 ? 0.6 : age == 2 ? 0.35 : 0.12
                        let rect = CGRect(x: CGFloat(cell.0) * pitch, y: CGFloat(cell.1) * pitch, width: dot, height: dot)
                        canvas.fill(Path(ellipseIn: rect), with: .color(theme[color].opacity(alpha)))
                    }
                }
                .frame(width: side, height: side)
                .shadow(color: theme[color].opacity(0.45), radius: metrics.size(2))
            }
        }
    }
}

/// Left sidebar icon tabs and the compact layout switch (`NormalProjectSidebar.module.css`: the active
/// tab gets a 1px border on `panel-hover`).
public struct AletheSidebarTabStyle: ButtonStyle {
    let isSelected: Bool
    let width: CGFloat
    let height: CGFloat
    let bordered: Bool

    public init(isSelected: Bool, width: CGFloat = 28, height: CGFloat = 26, bordered: Bool = true) {
        self.isSelected = isSelected
        self.width = width
        self.height = height
        self.bordered = bordered
    }

    public func makeBody(configuration: Configuration) -> some View {
        LeftSidebarTabBody(configuration: configuration, isSelected: isSelected, width: width, height: height,
                           bordered: bordered)
    }
}

private struct LeftSidebarTabBody: View {
    let configuration: ButtonStyleConfiguration
    let isSelected: Bool
    let width: CGFloat
    let height: CGFloat
    let bordered: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 14))
            .foregroundStyle(theme[isSelected || hovering ? .fg : .fgMuted])
            .frame(width: metrics.size(width), height: metrics.size(height))
            .background(theme[.panelHover].opacity(isSelected || hovering ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                .strokeBorder(theme[.border].opacity(isSelected && bordered ? 1 : 0),
                              lineWidth: metrics.size(1)))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// Compact title-bar pill (`TitleBar.module.css`: 22pt high, 8pt radius, 11pt mono).
public struct AletheTitleBarPillStyle: ButtonStyle {
    private let iconOnly: Bool

    public init(iconOnly: Bool = false) { self.iconOnly = iconOnly }

    public func makeBody(configuration: Configuration) -> some View {
        AletheTitleBarPillBody(configuration: configuration, iconOnly: iconOnly)
    }
}

private struct AletheTitleBarPillBody: View {
    let configuration: ButtonStyleConfiguration
    let iconOnly: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    var body: some View {
        configuration.label
            .font(metrics.monoFont(size: 11, weight: .semibold))
            .foregroundStyle(theme[hovering ? .fg : .fgMuted])
            .padding(.horizontal, metrics.size(iconOnly ? 0 : 8))
            .frame(minWidth: metrics.size(iconOnly ? 26 : 0), minHeight: metrics.size(22))
            .background(theme[hovering || configuration.isPressed ? .panelHover : .bgSunken],
                        in: RoundedRectangle(cornerRadius: metrics.size(8)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(8))
                .strokeBorder(theme[.borderStrong].opacity(hovering ? 1 : 0), lineWidth: metrics.size(1)))
            .onHover { hovering = $0 }
    }
}

/// Right sidebar tab and utility button (`RightSidebar.module.css`: the active tab sits on `panel`
/// with a strong border and a small shadow).
public struct AletheRightSidebarTabStyle: ButtonStyle {
    public var selected: Bool
    public var width: CGFloat
    public var height: CGFloat
    public init(selected: Bool = false, width: CGFloat = 28, height: CGFloat = 26) {
        self.selected = selected
        self.width = width
        self.height = height
    }
    public func makeBody(configuration: Configuration) -> some View {
        RightSidebarTabBody(configuration: configuration, selected: selected, width: width, height: height)
    }
}

private struct RightSidebarTabBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let width: CGFloat
    let height: CGFloat
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(metrics.font(size: 14))
            .foregroundStyle(theme[selected || hovering ? .fg : .fgMuted])
            .frame(width: metrics.size(width), height: metrics.size(height))
            .background(
                theme[selected ? .panel : .panelHover].opacity(selected || hovering ? 1 : 0),
                in: RoundedRectangle(cornerRadius: metrics.radius(.sm))
            )
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1))
                }
            }
            .shadow(
                color: theme[.bgSunken].opacity(selected ? 0.25 : 0),
                radius: metrics.size(2), y: metrics.size(1)
            )
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.5)
            .onHover { hovering = $0 }
    }
}

/// Small bordered actions in sidebar cards (PR actions and worker approval answers).
public struct AlethePanelActionStyle: ButtonStyle {
    public var approval: Bool
    public var accented: Bool
    public init(approval: Bool = false, accented: Bool = false) {
        self.approval = approval
        self.accented = accented
    }
    public func makeBody(configuration: Configuration) -> some View {
        PanelActionBody(configuration: configuration, approval: approval, accented: accented)
    }
}

private struct PanelActionBody: View {
    let configuration: ButtonStyleConfiguration
    let approval: Bool
    let accented: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var hovering = false
    var body: some View {
        configuration.label
            .font(metrics.font(size: approval ? 10 : 11, weight: approval ? .semibold : .regular))
            .foregroundStyle(theme[enabled ? .fg : .fgFaint])
            .padding(.horizontal, metrics.size(approval ? 8 : 10))
            .padding(.vertical, approval ? metrics.size(2) : 0)
            .frame(maxWidth: approval ? nil : .infinity)
            .frame(height: approval ? nil : metrics.size(26))
            .background(
                theme[hovering ? .panelHover : accented && enabled ? .accentSoft : .bgElevated]
                    .opacity(approval || hovering || accented && enabled ? 1 : 0),
                in: RoundedRectangle(cornerRadius: metrics.radius(.sm))
            )
            .overlay(
                RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[accented && enabled ? .accentBorder : .border], lineWidth: metrics.size(1))
            )
            .contentShape(Rectangle())
            .opacity(approval && !enabled ? 0.5 : 1)
            .onHover { hovering = $0 && enabled }
    }
}

/// Compact Home quick-launch field, matching `.quickProject` and `.quickMode summary`.
public struct AletheQuickFieldStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        AletheQuickFieldBody(configuration: configuration)
    }
}

private struct AletheQuickFieldBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var hovering = false

    var body: some View {
        configuration.label
            .font(metrics.monoFont(size: 10))
            .foregroundStyle(theme[.fgMuted])
            .padding(.horizontal, metrics.size(8))
            .frame(height: metrics.size(30))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[hovering ? .panelHover : .bgSunken].opacity(hovering ? 1 : 0.72),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[hovering ? .accentBorder : .border], lineWidth: metrics.size(1)))
            .onHover { hovering = $0 }
    }
}

/// Secondary Home actions from the web hero composition.
public struct AletheHomeActionStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(AletheHomeActionLabelStyle())
            .font(metrics.monoFont(size: 11))
            .foregroundStyle(theme[.fgMuted])
            .padding(.horizontal, metrics.size(10))
            .padding(.vertical, metrics.size(7))
            .background(theme[configuration.isPressed ? .bgElevated : .bg].opacity(0.48),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

private struct AletheHomeActionLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(7)) {
            configuration.icon.font(metrics.font(size: 13))
            configuration.title
        }
    }
}

/// Quiet action row from `WorkspaceEmptyState.module.css`.
public struct AletheWorkspaceActionStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        WorkspaceActionBody(configuration: configuration)
    }
}

private struct WorkspaceActionBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        configuration.label
            .foregroundStyle(theme[hovering ? .fg : .fgMuted])
            .background(theme[.panelHover].opacity(hovering ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// The web sidebar uses unboxed shell and document glyphs in a 15-point lead slot.
public struct AletheSidebarItemIcon: View {
    let symbol: String
    let shell: Bool
    @Environment(\.metrics) private var metrics

    public init(symbol: String, shell: Bool = false) {
        self.symbol = symbol
        self.shell = shell
    }

    public var body: some View {
        Group {
            if shell {
                HStack(alignment: .bottom, spacing: metrics.size(1)) {
                    Image(systemName: "chevron.right")
                    Image(systemName: "minus")
                        .offset(y: metrics.size(2))
                }
                .font(metrics.font(size: 8, weight: .semibold))
            } else {
                Image(systemName: symbol)
                    .font(metrics.font(size: 14))
            }
        }
        .frame(width: metrics.size(15), height: metrics.size(15))
        .accessibilityHidden(true)
    }
}

/// Home usage-card refresh control (`HomeView.module.css`, `.iconBtn`).
public struct AletheHomeRefreshStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(metrics.font(size: 12))
            .foregroundStyle(theme[.textTertiary])
            .frame(width: metrics.size(23), height: metrics.size(23))
            .background(theme[.panelHover].opacity(configuration.isPressed ? 1 : 0),
                        in: RoundedRectangle(cornerRadius: metrics.size(6)))
            .overlay(RoundedRectangle(cornerRadius: metrics.size(6))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}
