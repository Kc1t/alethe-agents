import AletheDesign
import AlethePluginKit
import SwiftUI

/// PluginCatalog.tsx / PluginsPage.module.css: 12px cards, 8px list gap and capability detail.
struct PluginCatalogWebSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Bindable var model: PluginCatalogWebModel
    @State private var query = ""
    @State private var installedOnly = false
    @State private var marketplace = false
    @State private var selectedID: String?

    private var entries: [PluginCatalogWebModel.Row] {
        model.rows(environment.plugins).filter { row in
            row.catalog != nil && (!installedOnly || row.installed) &&
                (query.isEmpty || [row.name, row.id, row.description, row.author, row.capabilities.joined(separator: " ")]
                    .joined(separator: " ").localizedStandardContains(query))
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(8)) {
            HStack(spacing: metrics.size(10)) {
                Button { Task { await model.reload(refresh: true) } } label: {
                    Label("settings.web.reference.prefs.pluginsCatalogRefresh", systemImage: "arrow.clockwise")
                }.disabled(model.loading).accessibilityIdentifier("plugins.catalog.refresh")
                if model.stale { Text("settings.web.reference.market.stale").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint]) }
            }.padding(.bottom, metrics.size(2))
            HStack(spacing: metrics.size(8)) {
                TextField("settings.web.reference.market.search", text: $query).textFieldStyle(.plain).accessibilityIdentifier("plugins.catalog.search")
                    .padding(.horizontal, metrics.size(8)).frame(height: metrics.size(26))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                Toggle("settings.web.reference.market.installed", isOn: $installedOnly)
                    .accessibilityIdentifier("plugins.catalog.installed")
                Button("plugins.web.filters") { selectedID = nil; marketplace = true }
                    .accessibilityIdentifier("plugins.catalog.filters")
            }
            if model.failed { Text("settings.web.reference.market.error").foregroundStyle(theme[.fgMuted]) }
            else if model.loading && entries.isEmpty { Text("settings.web.reference.market.loading").foregroundStyle(theme[.fgMuted]) }
            else if entries.isEmpty { Text("settings.web.reference.market.emptySearch").foregroundStyle(theme[.fgMuted]) }
            ForEach(entries) { row in
                VStack(alignment: .leading, spacing: metrics.size(6)) {
                    HStack(alignment: .top, spacing: metrics.size(16)) {
                        VStack(alignment: .leading, spacing: metrics.size(6)) {
                            HStack(spacing: metrics.size(8)) {
                                Button { selectedID = row.id; marketplace = true } label: { Text(verbatim: row.name).font(metrics.font(size: 12, weight: 600)) }
                                    .buttonStyle(.plain).accessibilityIdentifier("plugins.catalog.details.\(row.id)")
                                Text(verbatim: row.version).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint])
                                if row.installed { Text("settings.web.reference.market.installedMark").font(metrics.font(size: 9)).foregroundStyle(theme[.fgMuted]) }
                            }
                            Text(verbatim: row.description).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                            Text(verbatim: row.author).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                            if !row.native { Text("plugins.web.unavailable").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint]) }
                        }
                        Spacer(minLength: 0)
                        if let entry = row.catalog {
                            VStack(alignment: .trailing, spacing: metrics.size(6)) {
                                if entry.package != nil && !row.native {
                                    Button(row.update ? "settings.web.reference.prefs.pluginsCatalogUpdate" : row.installed ? "settings.web.reference.prefs.pluginsCatalogReinstall" : "plugins.web.register") {
                                        Task { await model.perform { try await $0.install(entry) } }
                                    }.disabled(model.busy).accessibilityIdentifier("plugins.catalog.install.\(row.id)")
                                }
                                if let url = URL(string: entry.downloadUrl), url.scheme == "https" {
                                    Link("settings.web.reference.prefs.pluginsCatalogSource", destination: url).font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                                }
                            }
                        }
                    }
                    ForEach(row.capabilities, id: \.self) { Text(verbatim: $0).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgMuted]) }
                }.padding(metrics.size(12)).frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            }
        }
        .accessibilityIdentifier("plugins.catalog")
        .task { model.configure(environment); await model.reload() }
        .sheet(isPresented: $marketplace) { PluginMarketplaceWebView(model: model, initialSelection: selectedID) }
    }
}
