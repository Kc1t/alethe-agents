import AletheDesign
import SwiftUI

/// The Preferences content inset is 34px, falling to 24px below the 900px breakpoint.
struct SettingsPageForm<Content: View>: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.settingsSearchTarget) private var searchTarget
    private let content: () -> Content
    private let pageID: String

    init(_ pageID: String = #fileID, @ViewBuilder content: @escaping () -> Content) {
        self.pageID = pageID
        self.content = content
    }

    var body: some View {
        if metrics.isWebInterface {
            GeometryReader { geometry in
                ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Group(sections: content()) { sections in
                        ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                            WebSettingsSection(id: pageID + "." + String(index), first: index == 0,
                                defaultCollapsed: pageID.contains("MultiagentSettings") && (1...3).contains(index)) {
                                section.header
                            } description: {
                                section.footer
                            } content: {
                                VStack(alignment: .leading, spacing: metrics.size(8)) {
                                    ForEach(subviews: section.content) { row in
                                        row.frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.horizontal, metrics.size(12))
                                            .padding(.vertical, metrics.size(10))
                                            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                                            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                                                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                                    }
                                }
                            }
                            .id(pageID + "." + String(index))
                        }
                        }
                    }
                    .padding(.horizontal, metrics.size(geometry.size.width / metrics.scale < 674 ? 24 : 34))
                    .padding(.top, metrics.size(28))
                    .padding(.bottom, metrics.size(52))
                }
                .webScrollStyle()
                .task(id: searchTarget) {
                    guard !searchTarget.isEmpty else { return }
                    await Task.yield()
                    proxy.scrollTo(searchTarget, anchor: .top)
                }
                }
            }
            .font(metrics.font(size: 12))
            .foregroundStyle(theme[.fg])
            .toggleStyle(WebSettingsCheckboxStyle())
            .buttonStyle(AletheButtonStyle(size: .small))
            .background(theme[.bgElevated])
        } else {
            AletheSettingsForm(content: content)
        }
    }
}

struct WebSettingsSection<Heading: View, Description: View, Content: View>: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(AppEnvironment.self) private var environment
    let id: String
    var first = false
    var defaultCollapsed = false
    @AppStorage("settings.web.collapsedSections") private var stored = "{}"
    @ViewBuilder let heading: () -> Heading
    @ViewBuilder let description: () -> Description
    @ViewBuilder let content: () -> Content
    private var storageKey: String { (environment.profileID?.rawValue ?? "default") + ":" + id }
    private var collapsed: Bool {
        let values = (try? JSONDecoder().decode([String: Bool].self, from: Data(stored.utf8))) ?? [:]
        return values[storageKey] ?? defaultCollapsed
    }
    private func toggle() {
        var values = (try? JSONDecoder().decode([String: Bool].self, from: Data(stored.utf8))) ?? [:]
        values[storageKey] = !collapsed
        if let data = try? JSONEncoder().encode(values), let value = String(data: data, encoding: .utf8) { stored = value }
    }
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(18)) {
            VStack(alignment: .leading, spacing: metrics.size(6)) {
                Group(subviews: heading()) { headings in
                    if !headings.isEmpty {
                        Button(action: toggle) {
                            HStack(spacing: metrics.size(9)) {
                                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                                    .font(metrics.font(size: 9, weight: .semibold))
                                    .opacity(0.65)
                                heading().font(metrics.font(size: 16, weight: 620))
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(theme[hovering ? .accent : .fg])
                        .onHover { hovering = $0 }
                        .accessibilityIdentifier("settings.section.\(id).toggle")
                        .accessibilityValue(Text(collapsed ? "settings.web.folded" : "settings.web.expanded"))
                    }
                }
                description().font(metrics.font(size: 11))
                    .foregroundStyle(theme[.fgMuted])
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: metrics.size(600), alignment: .leading)
            }
            if !collapsed { content() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, metrics.size(24))
        .padding(.top, first ? 0 : metrics.size(24))
        .overlay(alignment: .top) { if !first { theme[.border].frame(height: metrics.size(1)) } }
    }
}

private struct WebSettingsCheckboxStyle: ToggleStyle {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(14)) {
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                Group(subviews: configuration.label) { labels in
                    ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
                        label.font(metrics.font(size: index == 0 ? 12 : 10, weight: index == 0 ? 600 : 400))
                            .foregroundStyle(theme[index == 0 ? .fg : .fgMuted])
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Toggle(isOn: configuration.$isOn) { EmptyView() }
                .labelsHidden().toggleStyle(.checkbox).tint(theme[.accent]).fixedSize()
        }
    }
}
