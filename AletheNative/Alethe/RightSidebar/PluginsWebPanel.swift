import AletheDesign
import AlethePluginKit
import SwiftUI

/// PluginsSidebar's cards use installed native manifests until the web catalog has a native client.
struct PluginsWebPanel: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.openSettings) private var openSettings
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var records: [PluginHost.Record] {
        (environment.plugins?.records ?? []).filter {
            query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                ($0.manifest.name + " " + $0.id).localizedCaseInsensitiveContains(query)
        }.sorted { $0.manifest.name.localizedStandardCompare($1.manifest.name) == .orderedAscending }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "square.grid.2x2").resizable().scaledToFit()
                    .frame(width: metrics.size(16), height: metrics.size(16))
                Text("rightSidebar.plugins").font(metrics.font(size: 14, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
                Button {} label: {
                    Label("rightSidebar.plugins.refresh", systemImage: "arrow.clockwise").font(metrics.font(size: 13))
                }
                .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 26, height: 26))
                .disabled(true).help(Text("rightSidebar.plugins.unavailable"))
                .accessibilityIdentifier("plugins.refresh")
            }
            .foregroundStyle(theme[.fg]).padding(.horizontal, metrics.size(10)).frame(height: metrics.size(44))
            .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
            HStack(spacing: metrics.size(6)) {
                Image(systemName: "magnifyingglass").resizable().scaledToFit()
                    .frame(width: metrics.size(13), height: metrics.size(13)).foregroundStyle(theme[.fgMuted])
                TextField("rightSidebar.plugins.search", text: $query).textFieldStyle(.plain)
                    .font(metrics.font(size: 12)).foregroundStyle(theme[.fg]).focused($searchFocused)
                    .padding(.horizontal, metrics.size(8)).frame(height: metrics.size(26))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[searchFocused ? .accent : .border], lineWidth: metrics.size(1)))
            }
            .padding(.vertical, metrics.size(8)).padding(.horizontal, metrics.size(10))
            .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
            ScrollView {
                if records.isEmpty {
                    Text("rightSidebar.plugins.empty").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                        .multilineTextAlignment(.center).padding(.vertical, metrics.size(24)).padding(.horizontal, metrics.size(12))
                        .frame(maxWidth: .infinity)
                } else {
                    LazyVStack(spacing: metrics.size(8)) {
                        ForEach(records) { record in
                            Button {
                                environment.settingsTab = .plugins
                                openSettings()
                            } label: {
                                VStack(alignment: .leading, spacing: 0) {
                                    HStack(spacing: metrics.size(8)) {
                                        Text(verbatim: record.manifest.name).font(metrics.font(size: 13, weight: .medium))
                                            .foregroundStyle(theme[.fg]).lineLimit(1)
                                        Text(verbatim: record.manifest.version).font(metrics.monoFont(size: 10))
                                            .foregroundStyle(theme[.fgFaint]).fixedSize()
                                        if !record.isEnabled {
                                            Text("rightSidebar.plugins.off").font(metrics.monoFont(size: 10))
                                                .textCase(.uppercase).tracking(metrics.size(0.3))
                                                .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                                                .background(theme[.panelHover], in: Capsule())
                                                .foregroundStyle(theme[.fgMuted]).fixedSize()
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    Text("rightSidebar.plugins.installed").font(metrics.monoFont(size: 10))
                                        .foregroundStyle(theme[.fgFaint]).padding(.top, metrics.size(6))
                                }
                                .padding(.vertical, metrics.size(10)).padding(.horizontal, metrics.size(12))
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(PluginWebCardStyle())
                            .help(Text("rightSidebar.plugins.manage"))
                        }
                    }
                }
            }.padding(metrics.size(10))
        }
        .background(theme[.bg]).accessibilityIdentifier("plugins.panel")
    }
}

private struct PluginWebCardStyle: ButtonStyle {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        PluginWebCardBody(label: configuration.label)
    }
}

private struct PluginWebCardBody<Content: View>: View {
    let label: Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var hovering = false
    var body: some View {
        label.background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[hovering ? .accent : .border], lineWidth: metrics.size(1)))
            .contentShape(Rectangle()).onHover { hovering = $0 }
            .animation(Motion.sidebarColor(reduceMotion: metrics.reducesMotion), value: hovering)
    }
}
