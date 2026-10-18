import AletheDesign
import AlethePluginKit
import SwiftUI

struct PluginInstalledWebRow: View {
    let record: PluginHost.Record
    let host: PluginHost
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var expanded = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(10)) {
            HStack(alignment: .top, spacing: metrics.size(16)) {
                VStack(alignment: .leading, spacing: metrics.size(6)) {
                    HStack(spacing: metrics.size(8)) {
                        Text(verbatim: record.manifest.name).font(metrics.font(size: 12, weight: 600))
                        Text(verbatim: record.manifest.version).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgFaint])
                        Text("settings.web.reference.market.sourceBundled").font(metrics.font(size: 9, weight: 600))
                            .foregroundStyle(theme[.accent]).padding(.vertical, metrics.size(1)).padding(.horizontal, metrics.size(6))
                            .overlay(Capsule().strokeBorder(theme[.accentBorder], lineWidth: metrics.size(1)))
                    }
                    if case .failed(let error) = record.state {
                        Text(verbatim: error).font(metrics.font(size: 11)).foregroundStyle(theme[.statusStopped])
                            .textSelection(.enabled).accessibilityIdentifier("settings.plugins.\(record.id).error")
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: metrics.size(8)) {
                    Text(record.isEnabled ? "settings.web.reference.market.stateEnabled" : "settings.web.reference.market.stateDisabled")
                        .font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint])
                    Button {
                        Task { do { try await host.setEnabled(!record.isEnabled, for: record.id) } catch { failed = true } }
                    } label: {
                        Capsule().fill(theme[record.isEnabled ? .accentSoft : .bgElevated])
                            .overlay(Capsule().strokeBorder(theme[record.isEnabled ? .accentBorder : .borderStrong], lineWidth: metrics.size(1)))
                            .overlay(alignment: record.isEnabled ? .trailing : .leading) {
                                Circle().fill(theme[record.isEnabled ? .accent : .fgFaint])
                                    .frame(width: metrics.size(12), height: metrics.size(12)).padding(metrics.size(3))
                            }.frame(width: metrics.size(32), height: metrics.size(18))
                    }.buttonStyle(.plain).accessibilityLabel(Text(verbatim: record.manifest.name))
                        .accessibilityValue(Text(record.isEnabled ? "settings.web.reference.market.stateEnabled" : "settings.web.reference.market.stateDisabled"))
                        .accessibilityIdentifier("settings.plugins.\(record.id)")
                }
            }
            VStack(alignment: .leading, spacing: metrics.size(8)) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: metrics.size(5)) {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(metrics.font(size: 12))
                        Text("settings.web.reference.market.detailCapabilities").font(metrics.font(size: 10, weight: 600))
                        Text(verbatim: String(record.manifest.capabilities.count)).font(metrics.font(size: 10))
                    }
                }.buttonStyle(.plain).foregroundStyle(theme[.fgMuted])
                if expanded {
                    ForEach(record.manifest.capabilities.sorted(by: { $0.rawValue < $1.rawValue }), id: \.self) { capability in
                        Text(verbatim: capability.localizedName).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    }
                }
            }.padding(.top, metrics.size(8)).overlay(alignment: .top) { theme[.border].frame(height: metrics.size(1)) }
        }.padding(metrics.size(2))
            .alert("plugins.web.operationError", isPresented: $failed) { Button("plugins.web.ok", role: .cancel) {} }
    }
}
