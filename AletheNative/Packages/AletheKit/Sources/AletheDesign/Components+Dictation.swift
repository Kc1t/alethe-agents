import SwiftUI

/// PreferencesModal.module.css `.segmented` (3px inset, 110 × 34px buttons).
public struct AletheDictationSegments<Value: Hashable, Label: View>: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Binding var selection: Value
    let options: [Value]
    let label: (Value) -> Label

    public init(selection: Binding<Value>, options: [Value], @ViewBuilder label: @escaping (Value) -> Label) {
        _selection = selection
        self.options = options
        self.label = label
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.self) { value in
                Button { selection = value } label: {
                    label(value).font(metrics.font(size: 11))
                        .foregroundStyle(theme[selection == value ? .fg : .fgMuted])
                        .padding(.horizontal, metrics.size(14))
                        .frame(minWidth: metrics.size(110), minHeight: metrics.size(34))
                        .background(theme[.panel].opacity(selection == value ? 1 : 0),
                                    in: RoundedRectangle(cornerRadius: max(0, metrics.radius(.md) - metrics.size(2))))
                }.buttonStyle(.plain)
                    .accessibilityAddTraits(selection == value ? .isSelected : [])
            }
        }
        .padding(metrics.size(3))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}
