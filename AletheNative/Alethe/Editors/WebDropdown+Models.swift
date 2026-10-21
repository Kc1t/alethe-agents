import AletheDesign
import SwiftUI

/// ModelSearchablePicker.tsx: CLI models, search, and an explicit custom-value option.
struct WebModelDropdown: View {
    @Binding var selection: String
    let models: [String]
    let provider: String
    var loading = false
    var includesDefault = false

    private var cleanModels: [String] {
        models.filter { value in
            let normalized = value.lowercased()
            return value.count >= 3 && !value.hasPrefix("-") && !value.hasPrefix("#") &&
                !["could", "usage", "error", "let"].contains(where: { normalized.hasPrefix($0) })
        }
    }

    var body: some View {
        WebDropdown(selection: $selection, options: (includesDefault ? [""] : []) + cleanModels, isDisabled: loading, searchable: true,
            searchPlaceholder: String(localized: "dropdown.model.search")
                .replacingOccurrences(of: "{count}", with: String(cleanModels.count))
                .replacingOccurrences(of: "{provider}", with: provider),
            emptyLabel: { String(localized: "dropdown.model.empty").replacingOccurrences(of: "{query}", with: $0) },
            searchText: { $0 }, customValue: { $0 },
            customOptionLabel: { String(localized: "dropdown.model.custom").replacingOccurrences(of: "{model}", with: $0) },
            displayValue: loading ? String(localized: "dropdown.model.loading") : nil,
            placeholder: cleanModels.first ?? String(localized: "dropdown.model.select").replacingOccurrences(of: "{provider}", with: provider)) {
                if $0.isEmpty { Text("newTerminal.model.defaultItem") } else { Text(verbatim: $0) }
            }
    }
}

/// EditProjectAgentSettings.tsx uses agent cards for the provider, rather than a select.
struct WebConflictProviderChoices: View {
    @Binding var selection: String
    let options: [String]
    let title: (String) -> String
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(130)), spacing: metrics.size(8))], spacing: metrics.size(8)) {
            ForEach(options, id: \.self) { value in
                Button { selection = value } label: {
                    HStack(spacing: metrics.size(8)) {
                        AgentLogo(agent: value, size: 20).frame(width: metrics.size(20), height: metrics.size(20))
                        Text(verbatim: title(value)).font(metrics.font(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if value == selection {
                            Image(systemName: "checkmark.circle").font(metrics.font(size: 16)).foregroundStyle(theme[.accent])
                        }
                    }
                }
                .buttonStyle(WebConflictProviderStyle(selected: value == selection))
                .accessibilityAddTraits(value == selection ? [.isSelected] : [])
            }
        }.padding(.top, metrics.size(6))
    }
}

private struct WebConflictProviderStyle: ButtonStyle {
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        WebConflictProviderSurface(label: configuration.label, selected: selected)
    }
}

private struct WebConflictProviderSurface<Label: View>: View {
    let label: Label
    let selected: Bool
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false

    var body: some View {
        label
            .foregroundStyle(theme[.fg])
            .padding(.vertical, metrics.size(10)).padding(.horizontal, metrics.size(12))
            .background(theme[selected ? (metrics.style == .clean ? .panelHover : .accentFaint) : hovering ? .panelHover : .bgSunken],
                        in: RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.style == .clean ? metrics.size(4) : metrics.radius(.md))
                .strokeBorder(theme[selected ? (metrics.style == .clean ? .borderStrong : .accent) : hovering ? .borderStrong : .border],
                              lineWidth: metrics.size(1)))
            .shadow(color: theme[.accentRing].opacity(selected && metrics.style != .clean ? 1 : 0), radius: metrics.size(5))
            .onHover { hovering = $0 }
    }
}
