import AletheDesign
import AletheModel
import SwiftUI

/// PreferencesModal.module.css `visualStyleGrid`: the two style cards with a miniature preview.
/// Shared by Settings › Appearance and the theme picker modal.
struct WebVisualStyleGrid: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: metrics.size(10)), GridItem(.flexible(), spacing: metrics.size(10))], spacing: metrics.size(10)) {
            ForEach(VisualStyle.allCases, id: \.self) { style in
                Button {
                    environment.preferences?.update { $0.visualStyle = style == .normal ? nil : style.rawValue }
                } label: {
                    VStack(alignment: .leading, spacing: metrics.size(10)) {
                        stylePreview(style)
                        Text(style.title).font(metrics.font(size: 12, weight: .semibold))
                        Text(style.detail)
                            .font(metrics.font(size: 10))
                            .foregroundStyle(theme[.fgMuted])
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(metrics.size(10))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme[environment.visualStyle == style ? .accentFaint : .bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[environment.visualStyle == style ? .accent : .border], lineWidth: metrics.size(1)))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings.visualStyle.\(style.rawValue)")
                .accessibilityAddTraits(environment.visualStyle == style ? .isSelected : [])
            }
        }
    }

    private func stylePreview(_ style: VisualStyle) -> some View {
        VStack(spacing: 0) {
            theme[.bgElevated].frame(height: metrics.size(18))
                .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            HStack(spacing: 0) {
                VStack(spacing: metrics.size(5)) {
                    ForEach(0..<3) { _ in
                        RoundedRectangle(cornerRadius: metrics.size(style == .normal ? 6 : 0))
                            .fill(theme[.panel])
                            .overlay(RoundedRectangle(cornerRadius: metrics.size(style == .normal ? 6 : 0)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                            .frame(height: metrics.size(15))
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, metrics.size(5))
                .padding(.vertical, metrics.size(7))
                .frame(maxWidth: metrics.size(80))
                .overlay(alignment: .trailing) { theme[.border].frame(width: metrics.size(1)) }
                HStack(spacing: metrics.size(5)) {
                    ForEach(0..<2) { _ in
                        RoundedRectangle(cornerRadius: metrics.size(style == .normal ? 6 : 0))
                            .fill(theme[.panel])
                            .overlay(RoundedRectangle(cornerRadius: metrics.size(style == .normal ? 6 : 0)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                    }
                }
                .padding(metrics.size(6))
            }
        }
        .frame(height: metrics.size(104))
        .background(theme[.bg])
        .clipShape(RoundedRectangle(cornerRadius: metrics.size(style == .normal ? 8 : 0)))
        .accessibilityHidden(true)
    }
}
