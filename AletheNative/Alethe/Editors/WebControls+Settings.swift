import AletheDesign
import SwiftUI

/// Small web-styled replacements for system controls that settings pages used to show in `.web`.

/// A busy indicator: the web activity spinner in `.web`, the system spinner in `.mac`.
struct WebBusyIndicator: View {
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface {
            AletheActivitySpinner(.accent)
        } else {
            ProgressView().controlSize(.small)
        }
    }
}

/// A numeric field with minus/plus buttons on the web's sunken 32 pt input surface.
struct WebStepperRow: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var step = 1
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        if metrics.isWebInterface {
            HStack(spacing: metrics.size(12)) {
                Text(verbatim: title).font(metrics.font(size: 13))
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 0) {
                    stepButton("minus", delta: -step, enabled: value > range.lowerBound)
                    Text(verbatim: String(value)).font(metrics.monoFont(size: 13, weight: .regular))
                        .frame(minWidth: metrics.size(40))
                    stepButton("plus", delta: step, enabled: value < range.upperBound)
                }
                .frame(height: metrics.size(32))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            }
        } else {
            Stepper(value: $value, in: range, step: step) { Text(verbatim: title) }
        }
    }

    private func stepButton(_ symbol: String, delta: Int, enabled: Bool) -> some View {
        Button {
            value = min(range.upperBound, max(range.lowerBound, value + delta))
        } label: {
            Image(systemName: symbol).font(metrics.font(size: 11, weight: .semibold))
                .frame(width: metrics.size(30), height: metrics.size(32))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme[.fgMuted])
        .opacity(enabled ? 1 : 0.4)
        .disabled(!enabled)
    }
}

/// A thin determinate bar (web `usageBar`), system `ProgressView` in `.mac`.
struct WebProgressBar: View {
    let value: Double
    var total: Double = 100
    var token: ThemeToken = .accent
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        if metrics.isWebInterface {
            let fraction = total > 0 ? min(1, max(0, value / total)) : 0
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme[.bgSunken])
                    Capsule().fill(theme[token]).frame(width: geometry.size.width * fraction)
                }
            }
            .frame(height: metrics.size(6))
            .overlay(Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        } else {
            ProgressView(value: value, total: total)
        }
    }
}

/// A collapsible block with web chevron, replacing `DisclosureGroup` in `.web`.
struct WebDisclosure<Label: View, Content: View>: View {
    @State private var expanded = false
    @ViewBuilder let label: () -> Label
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        if metrics.isWebInterface {
            VStack(alignment: .leading, spacing: metrics.size(6)) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: metrics.size(6)) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(metrics.font(size: 10, weight: .semibold))
                            .foregroundStyle(theme[.fgFaint])
                        label()
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if expanded {
                    content().padding(.leading, metrics.size(16))
                }
            }
        } else {
            DisclosureGroup(isExpanded: $expanded, content: content, label: label)
        }
    }
}

/// The web's sunken 32 pt text input surface around a plain field (`.web` only).
private struct WebFieldSurface: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.textFieldStyle(.plain).font(metrics.font(size: 13))
                .padding(.horizontal, metrics.size(10))
                .frame(height: metrics.size(32))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        } else {
            content
        }
    }
}

extension View {
    func webFieldSurface() -> some View { modifier(WebFieldSurface()) }
}
