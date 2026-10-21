import AletheDesign
import AlethePluginKit
import AppKit
import SwiftUI

/// PluginMarketplaceModal.tsx and its CSS: header, 196px rail, 68px rows, inline detail.
struct PluginMarketplaceWebView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PluginCatalogWebModel
    var initialSelection: String? = nil
    @State private var query = ""
    @State private var installedOnly = false
    @State private var capabilities: Set<String> = []
    @State private var sources: Set<String> = []
    @State private var enabled: Bool?
    @State private var updated = true
    @State private var selected: String?
    @State private var removal: PluginCatalogWebModel.Row?

    private var rows: [PluginCatalogWebModel.Row] { model.rows(environment.plugins) }
    private var scoped: [PluginCatalogWebModel.Row] { rows.filter { !installedOnly || $0.installed } }
    private var visible: [PluginCatalogWebModel.Row] {
        let words = fold(query).split(whereSeparator: \.isWhitespace)
        return scoped.filter { row in
            let hay = fold([row.name, row.id, row.description, row.author].joined(separator: " "))
            return words.allSatisfy { hay.contains($0) } && capabilities.isSubset(of: Set(row.capabilities)) &&
                (sources.isEmpty || sources.contains(row.source)) && (enabled == nil || enabled == row.enabled)
        }.sorted {
            if updated && $0.update != $1.update { return $0.update }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    private func fold(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            HStack(spacing: 0) {
                rail
                Rectangle().fill(theme[.border]).frame(width: metrics.size(1))
                if let detail = rows.first(where: { $0.id == selected }) { detailView(detail) }
                else { list }
            }
        }
        .font(metrics.font(size: 12)).foregroundStyle(theme[.fg])
        .background(theme[.bgElevated])
        .frame(width: min(metrics.size(1180), (NSScreen.main?.visibleFrame.width ?? metrics.size(1228)) - metrics.size(48)),
               height: min(metrics.size(760), (NSScreen.main?.visibleFrame.height ?? metrics.size(808)) - metrics.size(48)))
        .clipShape(RoundedRectangle(cornerRadius: metrics.size(14)))
        .overlay(RoundedRectangle(cornerRadius: metrics.size(14)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .buttonStyle(AletheButtonStyle(size: .small))
        .task { selected = initialSelection; model.configure(environment); await model.reload() }
        .confirmationDialog("plugins.web.removeTitle", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } })) {
            Button("settings.web.reference.market.uninstall", role: .destructive) {
                if let row = removal {
                    Task { await model.perform { try await $0.uninstall(row.id) }; selected = nil }
                }
                removal = nil
            }
        } message: { Text("settings.web.reference.market.uninstallWarning") }
        .alert("plugins.web.operationError", isPresented: $model.error) { Button("plugins.web.ok", role: .cancel) {} }
        .accessibilityIdentifier("plugins.marketplace")
    }

    private var header: some View {
        HStack(spacing: metrics.size(14)) {
            Text("settings.web.reference.market.title").font(metrics.font(size: 16, weight: 650))
            HStack(spacing: metrics.size(8)) {
                Image(systemName: "magnifyingglass").font(metrics.font(size: 13))
                TextField("settings.web.reference.market.search", text: $query).textFieldStyle(.plain)
                    .font(metrics.font(size: 12))
            }.padding(.horizontal, metrics.size(10)).frame(maxWidth: metrics.size(420)).frame(height: metrics.size(32))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
            Spacer(minLength: 0)
            WebDropdown(selection: $updated, options: [true, false], appearance: .marketSort,
                searchText: { String(localized: $0 ? "settings.web.reference.market.sortUpdated" : "settings.web.reference.market.sortName") }) {
                Text($0 ? "settings.web.reference.market.sortUpdated" : "settings.web.reference.market.sortName")
            }.frame(width: metrics.size(160)).accessibilityLabel(Text("settings.web.reference.market.sort")).font(metrics.font(size: 11)).fixedSize()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(metrics.font(size: 16)).frame(width: metrics.size(30), height: metrics.size(30))
            }.buttonStyle(.plain).accessibilityLabel(Text("plugins.web.close"))
        }.padding(.vertical, metrics.size(16)).padding(.horizontal, metrics.size(18))
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
    }

    private var rail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                tab(Text("settings.web.reference.market.browse"), active: !installedOnly) { installedOnly = false; selected = nil }
                tab(Text("settings.web.reference.market.installed"), active: installedOnly, count: rows.filter(\.installed).count) { installedOnly = true; selected = nil }
                railLabel("settings.web.reference.market.filterCapabilities")
                ForEach(Array(Set(scoped.flatMap(\.capabilities))).sorted(), id: \.self) { capability in
                    facet(Text(verbatim: capability), active: capabilities.contains(capability)) { toggle(capability, in: &capabilities) }
                }
                if installedOnly {
                    railLabel("settings.web.reference.market.filterSource")
                    facet(Text("settings.web.reference.market.sourceBundled"), active: sources.contains("bundled")) { toggle("bundled", in: &sources) }
                    facet(Text("settings.web.reference.market.sourceLocal"), active: sources.contains("local")) { toggle("local", in: &sources) }
                    railLabel("settings.web.reference.market.filterState")
                    facet(Text("settings.web.reference.market.stateEnabled"), active: enabled == true) { enabled = enabled == true ? nil : true }
                    facet(Text("settings.web.reference.market.stateDisabled"), active: enabled == false) { enabled = enabled == false ? nil : false }
                }
                Button("settings.web.reference.market.clear") { query = ""; capabilities = []; sources = []; enabled = nil }
                    .padding(.top, metrics.size(14))
            }.padding(.vertical, metrics.size(14)).padding(.horizontal, metrics.size(10))
        }.frame(width: metrics.size(196)).background(theme[.bgSunken].opacity(0.78))
    }
    private func tab(_ title: Text, active: Bool, count: Int? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: metrics.size(8)) {
                title.font(metrics.font(size: 12))
                Spacer(minLength: 0)
                if let count { Text(verbatim: String(count)).font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint]) }
            }.padding(.vertical, metrics.size(8)).padding(.horizontal, metrics.size(10))
                .foregroundStyle(theme[active ? .fg : .fgMuted])
                .background(theme[.bgSunken].opacity(active ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.borderStrong].opacity(active ? 1 : 0), lineWidth: metrics.size(1)))
        }.buttonStyle(.plain)
    }
    private func toggle(_ value: String, in set: inout Set<String>) { if set.contains(value) { set.remove(value) } else { set.insert(value) } }
    private func railLabel(_ key: LocalizedStringKey) -> some View {
        Text(key).font(metrics.font(size: 9, weight: 700)).textCase(.uppercase).tracking(metrics.size(0.9))
            .foregroundStyle(theme[.fgFaint]).padding(.top, metrics.size(16)).padding(.bottom, metrics.size(6)).padding(.leading, metrics.size(10))
    }
    private func facet(_ title: Text, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            title.font(metrics.font(size: 11)).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, metrics.size(6)).padding(.horizontal, metrics.size(10))
                .foregroundStyle(theme[active ? .accent : .fgMuted])
                .background(theme[active ? .accentSoft : .bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
        }.buttonStyle(.plain)
    }

    private var list: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(12)) {
                Text(verbatim: String(visible.count)).monospacedDigit()
                if model.stale { Text("settings.web.reference.market.stale").foregroundStyle(theme[.statusWaiting]) }
                Spacer()
                Button { Task { await model.reload(refresh: true) } } label: {
                    Label("settings.web.reference.market.retry", systemImage: "arrow.clockwise")
                }.disabled(model.loading)
            }.font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                .padding(.vertical, metrics.size(10)).padding(.horizontal, metrics.size(18))
                .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            ScrollView {
                LazyVStack(spacing: 0) {
                    if model.loading && visible.isEmpty { note("settings.web.reference.market.loading") }
                    else if model.failed && !installedOnly { note("settings.web.reference.market.error") }
                    else if visible.isEmpty { note("settings.web.reference.market.emptySearch") }
                    else {
                        ForEach(visible) { row in
                            HStack(spacing: metrics.size(14)) {
                                Button { selected = row.id } label: {
                                    VStack(alignment: .leading, spacing: metrics.size(3)) {
                                        HStack(spacing: metrics.size(8)) {
                                            Text(verbatim: row.name).font(metrics.font(size: 13, weight: 600)).foregroundStyle(theme[.fg])
                                            Text(verbatim: row.version).font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                                        }
                                        Text(verbatim: row.description).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted]).lineLimit(1)
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                if row.installed { Text("settings.web.reference.market.installedMark").font(metrics.font(size: 11)).foregroundStyle(theme[.statusActive]) }
                                else { Text("plugins.web.unavailable").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint]) }
                            }.padding(.horizontal, metrics.size(10)).frame(height: metrics.size(68))
                                .modifier(PluginMarketWebRowHover())
                                .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
                        }
                    }
                }.padding(.horizontal, metrics.size(8))
            }.webScrollStyle()
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func note(_ key: LocalizedStringKey) -> some View {
        Text(key).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
            .padding(.vertical, metrics.size(44)).padding(.horizontal, metrics.size(18)).frame(maxWidth: .infinity)
    }

    private func detailView(_ row: PluginCatalogWebModel.Row) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.size(14)) {
                Button { selected = nil } label: { Label("settings.web.reference.market.back", systemImage: "arrow.left") }
                Text(verbatim: row.name).font(metrics.font(size: 19, weight: 640))
                HStack(spacing: metrics.size(12)) {
                    Text(verbatim: row.version)
                    Text(verbatim: row.author)
                }.font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                Text(verbatim: row.description).font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
                Text("settings.web.reference.market.detailCapabilities").font(metrics.font(size: 9, weight: 700)).textCase(.uppercase)
                ForEach(row.capabilities, id: \.self) { Text(verbatim: $0).font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted]) }
                if !row.native {
                    Text("plugins.web.unavailable").font(metrics.font(size: 12))
                    Text("plugins.web.registrationHelp").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                }
                HStack(spacing: metrics.size(8)) {
                    if row.native {
                        Button(row.enabled ? "settings.web.reference.market.disable" : "settings.web.reference.market.enable") {
                            Task { do { try await environment.plugins?.setEnabled(!row.enabled, for: row.id) } catch { model.error = true } }
                        }
                    } else if let entry = row.catalog, entry.package != nil {
                        Button(row.update ? "settings.web.reference.prefs.pluginsCatalogUpdate" : row.installed ? "settings.web.reference.prefs.pluginsCatalogReinstall" : "plugins.web.register") {
                            Task { await model.perform { try await $0.install(entry) } }
                        }.disabled(model.busy)
                    }
                    if let page = row.catalog?.downloadUrl, let url = URL(string: page), url.scheme == "https" {
                        Link("settings.web.reference.market.openPage", destination: url)
                    }
                    if row.source == "local" {
                        Button("settings.web.reference.market.uninstall", role: .destructive) { removal = row }.disabled(model.busy)
                    }
                }.padding(.top, metrics.size(6))
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, metrics.size(18)).padding(.horizontal, metrics.size(22))
        }.webScrollStyle()
    }
}

private struct PluginMarketWebRowHover: ViewModifier {
    @Environment(\.theme) private var theme
    @State private var hovering = false
    func body(content: Content) -> some View {
        content.background(theme[.panelHover].opacity(hovering ? 1 : 0)).onHover { hovering = $0 }
    }
}
