import SwiftUI

/// Choice groups that Router9Settings and onboarding/FeaturesStep draw as segments, not selects.
public struct AletheWebChoiceSegments<Value: Hashable, Label: View>: View {
    @Binding private var selection: Value
    private let options: [Value]
    private let compact: Bool
    private let label: (Value) -> Label
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    public init(selection: Binding<Value>, options: [Value], compact: Bool = false,
                @ViewBuilder label: @escaping (Value) -> Label) {
        _selection = selection
        self.options = options
        self.compact = compact
        self.label = label
    }

    public var body: some View {
        HStack(spacing: metrics.size(compact ? 2 : 0)) {
            ForEach(options, id: \.self) { value in
                Button { selection = value } label: {
                    label(value).font(metrics.font(size: 11))
                        .padding(.vertical, metrics.size(compact ? 3 : 5))
                        .padding(.horizontal, metrics.size(compact ? 9 : 12))
                        .foregroundStyle(theme[selection == value ? .fg : .fgMuted])
                        .background(theme[.panelHover].opacity(selection == value ? 1 : 0),
                                    in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == value ? [.isSelected] : [])
            }
        }
        .padding(metrics.size(compact ? 2 : 3))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .opacity(enabled ? 1 : 0.45)
        .fixedSize()
    }
}
