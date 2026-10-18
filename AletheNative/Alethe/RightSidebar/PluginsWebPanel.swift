import AletheDesign
import AlethePluginKit
import SwiftUI

/// Catalog cards mirror PluginsSidebar; native execution remains gated by the existing hosts.
struct PluginsWebPanel: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    @State private var model = PluginCatalogWebModel()
    @State private var marketplace = false
    @State private var selectedID: String?
    @State private var status = "all"
    @State private var source = "all"
    @State private var sort = "relevance"

    private var records: [PluginCatalogWebModel.Row] {
        model.rows(environment.plugins).filter { row in
            let text = [row.name, row.id, row.description, row.author, row.capabilities.joined(separator: " ")].joined(separator: " ")
            return (query.isEmpty || query.split(whereSeparator: \.isWhitespace).allSatisfy { text.localizedStandardContains(String($0)) }) &&
                (source == "all" || source == row.source) &&
                (status == "all" || status == "installed" && row.installed || status == "available" && !row.installed ||
                 status == "enabled" && row.enabled || status == "disabled" && row.installed && !row.enabled || status == "updates" && row.update)
        }.sorted {
            if sort == "relevance", !query.isEmpty {
                let first = relevance($0), second = relevance($1)
                if first != second { return first > second }
            }
            if sort == "updates", $0.update != $1.update { return $0.update }
            if sort != "name", $0.installed != $1.installed { return $0.installed }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private func relevance(_ row: PluginCatalogWebModel.Row) -> Int {
        let name = row.name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let id = row.id.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .split(whereSeparator: \.isWhitespace).reduce(0) { score, token in
                if name == token || id == token { return score + 4 }
                if name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(token) }) { return score + 3 }
                return score + (name.contains(token) || id.contains(token) ? 2 : 0)
            }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(7)) {
                Image(systemName: "square.grid.2x2").resizable().scaledToFit()
                    .frame(width: metrics.size(16), height: metrics.size(16))
                Text("rightSidebar.plugins").font(metrics.font(size: 14, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
                Button { Task { await model.reload(refresh: true) } } label: {
                    Label("rightSidebar.plugins.refresh", systemImage: "arrow.clockwise").font(metrics.font(size: 13))
                }
                .buttonStyle(AletheAnimatedRightSidebarTabStyle(width: 26, height: 26))
                .disabled(model.loading)
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
            VStack(spacing: metrics.size(8)) {
                HStack(spacing: metrics.size(8)) {
                    Picker("plugins.web.status", selection: $status) {
                        Text("plugins.web.all").tag("all")
                        Text("settings.web.reference.market.installed").tag("installed")
                        Text("plugins.web.available").tag("available")
                        Text("settings.web.reference.market.stateEnabled").tag("enabled")
                        Text("settings.web.reference.market.stateDisabled").tag("disabled")
                        Text("plugins.web.updates").tag("updates")
                    }
                    Picker("settings.web.reference.market.filterSource", selection: $source) {
                        Text("plugins.web.all").tag("all")
                        Text("settings.web.reference.market.sourceBundled").tag("bundled")
                        Text("settings.web.reference.market.sourceLocal").tag("local")
                        Text("plugins.web.catalog").tag("catalog")
                    }
                }
                Picker("settings.web.reference.market.sort", selection: $sort) {
                    Text("plugins.web.relevance").tag("relevance")
                    Text("settings.web.reference.market.sortName").tag("name")
                    Text("settings.web.reference.market.installed").tag("installed")
                    Text("settings.web.reference.market.sortUpdated").tag("updates")
                }
                if model.stale { Text("settings.web.reference.market.stale").foregroundStyle(theme[.statusWaiting]) }
                if model.failed { Text("settings.web.reference.market.error").foregroundStyle(theme[.fgMuted]) }
                Button("settings.web.reference.prefs.pluginsMarketplaceOpen") { selectedID = nil; marketplace = true }
            }.font(metrics.font(size: 11)).padding(metrics.size(10))
            HStack(spacing: metrics.size(6)) {
                Text(verbatim: String(records.count))
                Spacer()
                Button("settings.web.reference.market.clear") { query = ""; status = "all"; source = "all"; sort = "relevance" }
            }.font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                .padding(.horizontal, metrics.size(10)).padding(.top, metrics.size(8))
            ScrollView {
                if records.isEmpty {
                    Text("rightSidebar.plugins.empty").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                        .multilineTextAlignment(.center).padding(.vertical, metrics.size(24)).padding(.horizontal, metrics.size(12))
                        .frame(maxWidth: .infinity)
                } else {
                    LazyVStack(spacing: metrics.size(8)) {
                        ForEach(records) { record in
                            Button {
                                selectedID = record.id
                                marketplace = true
                            } label: {
                                VStack(alignment: .leading, spacing: 0) {
                                    HStack(spacing: metrics.size(8)) {
                                        Text(verbatim: record.name).font(metrics.font(size: 13, weight: .medium))
                                            .foregroundStyle(theme[.fg]).lineLimit(1)
                                        Text(verbatim: record.version).font(metrics.monoFont(size: 10))
                                            .foregroundStyle(theme[.fgFaint]).fixedSize()
                                        if record.installed && !record.enabled {
                                            Text("rightSidebar.plugins.off").font(metrics.monoFont(size: 10))
                                                .textCase(.uppercase).tracking(metrics.size(0.3))
                                                .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                                                .background(theme[.panelHover], in: Capsule())
                                                .foregroundStyle(theme[.fgMuted]).fixedSize()
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    Text(verbatim: record.description).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted]).lineLimit(2)
                                        .padding(.top, metrics.size(6))
                                    Text(record.installed ? "rightSidebar.plugins.installed" : "plugins.web.unavailable").font(metrics.monoFont(size: 10))
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
        .task { model.configure(environment); await model.reload() }
        .sheet(isPresented: $marketplace) { PluginMarketplaceWebView(model: model, initialSelection: selectedID) }
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
