import AletheDesign
import AletheDocuments
import AletheModel
import AppKit
import AVKit
import SwiftUI
import WebKit

/// What a link preview shows.
enum LinkPreviewTarget: Hashable {
    case web(URL)
    case file(String)
}

/// Link viewer (upstream `LinkViewerOverlay`): a quick look at a clicked link without adding a pane.
/// Markdown rendered, images, videos, pages (private), other text files as source; Esc closes.
struct LinkPreviewSheet: View {
    let target: LinkPreviewTarget
    @Environment(\.dismiss) private var nativeDismiss
    @Environment(\.modalsM2Close) private var closeOverlay
    private func dismiss() {
        if let closeOverlay { closeOverlay() } else { nativeDismiss() }
    }
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var title: String {
        switch target {
        case .web(let url): url.absoluteString
        case .file(let path): (path as NSString).lastPathComponent
        }
    }

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    @Environment(\.newTerminalModalHeight) private var maximumHeight

    private var webBody: some View {
        GitWebModal(close: dismiss, closeIdentifier: "linkPreview.close") {
            Text(verbatim: title).lineLimit(1).truncationMode(.middle)
        } content: {
            content.frame(maxWidth: .infinity)
                .frame(height: max(metrics.size(120), min(metrics.size(440), maximumHeight - metrics.size(140))))
        } footer: {
            Spacer()
            Button("linkPreview.open", action: openExternally)
            Button("linkPreview.close", action: dismiss)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("linkPreview")
    }

    private var nativeBody: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.space(.s)) {
                Text(verbatim: title)
                    .font(metrics.font(.headline))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Button("linkPreview.open") { openExternally() }
                Button("linkPreview.close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("linkPreview.close")
            }
            .padding(metrics.space(.m))
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: metrics.size(760), height: metrics.size(560))
        .background(theme[.bg])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("linkPreview")
    }

    @ViewBuilder
    private var content: some View {
        switch target {
        case .web(let url):
            PreviewWebView(url: url)
        case .file(let path):
            switch PaneContent.forFile(path) {
            case .markdown?:
                MarkdownPreview(file: MarkdownFile(path: path, watch: false))
            case .image?:
                if let image = NSImage(contentsOf: URL(filePath: path)) {
                    if metrics.isWebInterface {
                        GeometryReader { geometry in
                            Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                                .frame(width: geometry.size.width, height: geometry.size.height)
                        }
                        .padding(metrics.space(.m))
                    } else {
                        Image(nsImage: image).resizable().scaledToFit().padding(metrics.space(.m))
                    }
                } else {
                    unavailable
                }
            case .video?:
                VideoPlayer(player: AVPlayer(url: URL(filePath: path)))
            default:
                if let text = Self.textPreview(path) {
                    ScrollView([.vertical, .horizontal]) {
                        Text(verbatim: text)
                            .font(metrics.font(.footnote).monospaced())
                            .textSelection(.enabled)
                            .padding(metrics.space(.m))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    unavailable
                }
            }
        }
    }

    private var unavailable: some View {
        Text("linkPreview.unavailable")
            .foregroundStyle(theme[.textSecondary])
            .accessibilityIdentifier("linkPreview.unavailable")
    }

    /// The start of a text file (up to 512 KB), or nil for binary content.
    static func textPreview(_ path: String) -> String? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: 512 * 1024)) ?? Data()
        guard !data.contains(0) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func openExternally() {
        switch target {
        case .web(let url): NSWorkspace.shared.open(url)
        case .file(let path): NSWorkspace.shared.open(URL(filePath: path))
        }
        dismiss()
    }
}

private struct MarkdownPreview: View {
    let file: MarkdownFile
    @Environment(\.metrics) private var metrics

    var body: some View {
        ScrollView {
            MarkdownBlocksView(blocks: file.blocks)
                .padding(metrics.space(.xl))
        }
    }
}

/// A private, throwaway page for the preview.
private struct PreviewWebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}
}
