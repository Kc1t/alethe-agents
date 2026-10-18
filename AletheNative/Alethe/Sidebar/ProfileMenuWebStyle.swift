import AletheDesign
import SwiftUI

/// UserProfile.module.css item geometry, including its destructive hover treatment.
struct ProfileMenuWebStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ProfileMenuWebRow(configuration: configuration)
    }
}

private struct ProfileMenuWebRow: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    private var danger: Bool { configuration.role == .destructive }

    var body: some View {
        configuration.label
            .font(metrics.font(size: metrics.style == .clean ? 12 : 13))
            .foregroundStyle(theme[danger ? .statusOffline : .fg])
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, metrics.size(metrics.style == .clean ? 8 : 10))
            .padding(.vertical, metrics.size(metrics.style == .clean ? 0 : 7))
            .frame(minHeight: metrics.style == .clean ? metrics.size(28) : nil)
            .contentShape(Rectangle())
            .background(theme[danger ? .statusOfflineSoft : .panelHover]
                .opacity(hovering || configuration.isPressed ? 1 : 0),
                in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .onHover { hovering = $0 }
    }
}

struct ProfileMenuWebLabelStyle: LabelStyle {
    @Environment(\.metrics) private var metrics

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(8)) {
            configuration.icon
                .frame(width: metrics.size(13), height: metrics.size(13))
                .clipped()
            configuration.title
        }
    }
}

struct ProfileMenuWebButton: View {
    let title: LocalizedStringKey
    let symbol: String
    let role: ButtonRole?
    let action: () -> Void

    init(_ title: LocalizedStringKey, symbol: String, role: ButtonRole? = nil,
         action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.role = role
        self.action = action
    }

    var body: some View {
        Button(role: role, action: action) {
            Label { Text(title) } icon: {
                Image(systemName: symbol).webProfileSized(13)
            }
        }
        .accessibilityIdentifier("profile.menu.\(symbol)")
    }
}
