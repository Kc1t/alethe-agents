import AletheDesign
import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct PluginInstallWebView: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Bindable var model: PluginCatalogWebModel
    @State private var manifest = ""

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            HStack(spacing: metrics.size(12)) {
                Text(verbatim: model.folder?.path ?? "").font(metrics.monoFont(size: 10))
                    .foregroundStyle(theme[.fgFaint]).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                Button("settings.web.reference.prefs.pluginsRescan") { Task { await model.rescan() } }
                    .accessibilityIdentifier("plugins.local.rescan")
                Button("settings.web.reference.prefs.pluginsOpenFolder") {
                    if let folder = model.folder { NSWorkspace.shared.open(folder) }
                }.accessibilityIdentifier("plugins.local.openFolder")
            }
            HStack(spacing: metrics.size(12)) {
                Button { choose() } label: { Label("settings.web.reference.prefs.pluginsImport", systemImage: "folder.badge.plus") }
                    .disabled(model.busy)
                    .accessibilityIdentifier("plugins.local.import")
                Text("plugins.web.registrationHelp").font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
            }
            DisclosureGroup("settings.web.reference.prefs.pluginsManifestAdvanced") {
                VStack(alignment: .leading, spacing: metrics.size(8)) {
                    Text("settings.web.reference.prefs.pluginsManifestLabel")
                    TextEditor(text: $manifest).font(metrics.monoFont(size: 11)).scrollContentBackground(.hidden)
                        .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10))
                        .frame(height: metrics.size(104)).background(theme[.bgSunken])
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .accessibilityLabel(Text("settings.web.reference.prefs.pluginsManifestLabel"))
                        .accessibilityIdentifier("plugins.local.manifest")
                    HStack {
                        Spacer()
                        Button("settings.web.reference.prefs.pluginsInstallButton") {
                            let data = Data(manifest.utf8)
                            Task { await model.perform { try await $0.install(manifest: data) }; if !model.error { manifest = "" } }
                        }.disabled(model.busy || manifest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("plugins.local.install")
                    }
                }
            }
        }
        .accessibilityIdentifier("plugins.local")
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.json, .zip]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in await model.perform { try await $0.importFile(url) } }
        }
    }
}
