import AletheDesign
import AletheModel
import SwiftUI

/// Project/group color choice as theme swatches (never literal colors).
struct ColorSwatchPicker: View {
    @Binding var selection: ProjectColor?
    var allowsNone = false
    var webSwatchSize: CGFloat = 24
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        Group {
            if metrics.isWebInterface {
                ProjectGroupSwatchLayout(gap: metrics.size(8)) {
                    swatches
                }
            } else {
                HStack(spacing: metrics.space(.s)) { swatches }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor.color")
    }

    @ViewBuilder
    private var swatches: some View {
        if allowsNone { swatch(nil) }
        ForEach(ProjectColor.allCases, id: \.self) { color in swatch(color) }
    }

    private func swatch(_ color: ProjectColor?) -> some View {
        let isSelected = selection == color
        return Button {
            selection = color
        } label: {
            ZStack {
                Circle()
                    .fill(color.map { theme[$0.token] } ?? theme[.panel])
                if color == nil {
                    Image(systemName: "slash.circle").foregroundStyle(theme[.textTertiary])
                }
            }
            .frame(width: metrics.size(metrics.isWebInterface ? webSwatchSize : 18), height: metrics.size(metrics.isWebInterface ? webSwatchSize : 18))
            .overlay(Circle().strokeBorder(theme[metrics.isWebInterface ? .fg : .focusRing],
                                          lineWidth: isSelected ? (metrics.isWebInterface ? metrics.size(2) : 2) : 0))
            .padding(metrics.isWebInterface ? 0 : 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(color?.localizedName ?? "color.none"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor.color.\(color?.rawValue ?? "none")")
    }
}
