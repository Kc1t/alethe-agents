import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Web ImageInput.tsx, plus macOS clipboard and file-drop integration.
struct ImageInputField: View {
    @Binding var value: String
    let name: String
    let color: ProjectColor?
    var label: LocalizedStringKey = "image.label"
    var placeholder: LocalizedStringKey = "image.placeholder"
    var hint: LocalizedStringKey = "image.hint"
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var error: LocalizedStringKey?
    @State private var targeted = false
    @State private var importTask: Task<Void, Never>?

    var body: some View {
        Group {
            if metrics.isWebInterface {
                ProjectGroupWebField(title: label) {
                    controls
                    Text(hint).font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
                }
            } else {
                LabeledContent(label) { controls }
            }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $targeted, perform: drop)
        .onDisappear { importTask?.cancel() }
        .onPasteCommand(of: [.fileURL, .image]) { providers in _ = drop(providers) }
        .alert("image.error", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("image.ok", role: .cancel) { error = nil }
        } message: { if let error { Text(error) } }
    }

    private var controls: some View {
        HStack(spacing: metrics.size(6)) {
            SidebarCoverImage(source: value, side: 44, cornerRadius: 10) {
                ZStack {
                    theme[color?.token ?? .panel]
                    Text(verbatim: String((name.isEmpty ? "P" : name).trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                        .font(metrics.font(size: 18, weight: .bold)).foregroundStyle(theme[.accentOn])
                }
            }
            .background {
                if metrics.isWebInterface {
                    RoundedRectangle(cornerRadius: metrics.size(10)).fill(theme[color?.token ?? .panel])
                }
            }
            .overlay(RoundedRectangle(cornerRadius: metrics.size(10))
                .strokeBorder(theme[targeted ? .accent : .borderStrong], lineWidth: metrics.size(1)))
            Group {
                if metrics.isWebInterface {
                    urlField.modifier(ProjectGroupWebInput())
                } else {
                    urlField
                }
            }
            .accessibilityIdentifier("image.url")
            .contextMenu { Button("image.paste", action: paste) }
            Button(action: choose) {
                Image(systemName: "square.and.arrow.up").font(metrics.font(size: 14))
            }
            .buttonStyle(AletheImageInputButtonStyle())
            .help(Text("image.pickLocal")).accessibilityLabel(Text("image.pickLocal"))
            .accessibilityIdentifier("image.choose")
            if !value.isEmpty {
                Button { value = "" } label: {
                    Image(systemName: "xmark").font(metrics.font(size: 14))
                }
                .buttonStyle(AletheImageInputButtonStyle())
                .help(Text("image.remove")).accessibilityLabel(Text("image.remove"))
                .accessibilityIdentifier("image.remove")
            }
        }
    }

    private var urlField: some View {
        TextField(text: $value, prompt: Text(placeholder)) { Text(label) }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { load(url) }
    }

    private func load(_ url: URL) {
        let type = UTType(filenameExtension: url.pathExtension)
        guard let type, type.conforms(to: .image), let mime = type.preferredMIMEType else {
            error = "image.mustBeImage"; return
        }
        importImage { try ProjectImageInput.fileDataURL(url, mimeType: mime) }
    }

    private func accept(_ data: Data, mime: String) {
        importImage { try ProjectImageInput.dataURL(data, mimeType: mime) }
    }

    private func importImage(_ operation: @escaping @Sendable () throws -> String) {
        importTask?.cancel()
        let previous = value
        importTask = Task {
            let result = await Task.detached(priority: .userInitiated) { Result(catching: operation) }.value
            guard !Task.isCancelled, value == previous else { return }
            switch result {
            case .success(let source): value = source
            case .failure(ProjectImageInput.ValidationError.tooLarge): error = "image.tooLarge"
            case .failure(ProjectImageInput.ValidationError.mustBeImage): error = "image.mustBeImage"
            case .failure: error = "image.readFailed"
            }
        }
    }

    private func paste() {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self]) as? [URL],
           let url = urls.first, url.isFileURL { load(url); return }
        for type in board.types ?? [] {
            if let content = UTType(type.rawValue), content.conforms(to: .image),
               let mime = content.preferredMIMEType, let data = board.data(forType: type) {
                accept(data, mime: mime); return
            }
        }
        if let text = board.string(forType: .string) { value = text }
    }

    private func drop(_ providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || $0.registeredTypeIdentifiers.contains { UTType($0)?.conforms(to: .image) == true }
        }) else { return false }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
                guard let data, let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL else {
                    Task { @MainActor in error = "image.readFailed" }
                    return
                }
                Task { @MainActor in load(url) }
            }
            return true
        }
        guard let identifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }),
              let mime = UTType(identifier)?.preferredMIMEType else { return false }
        provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in
            guard let data else {
                Task { @MainActor in error = "image.readFailed" }
                return
            }
            Task { @MainActor in accept(data, mime: mime) }
        }
        return true
    }
}
