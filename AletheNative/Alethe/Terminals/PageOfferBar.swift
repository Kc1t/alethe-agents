import AletheDesign
import AletheModel
import SwiftUI

/// "localhost:5173 is ready" over a terminal whose output announced a local page: open it in a web
/// pane beside the terminal (while the browser feature is on), in the browser, or dismiss. Leaving
/// it be is a fine answer too.
struct PageOfferBar: View {
    let url: URL
    let onOpenInPane: () -> Void
    let onOpenInBrowser: () -> Void
    let onDismiss: () -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var address: String {
        [url.host(), url.port.map { ":\($0)" }].compactMap { $0 }.joined() + (url.path == "/" ? "" : url.path)
    }

    var body: some View {
        HStack(spacing: metrics.space(.s)) {
            Image(systemName: "globe").webProfileSized(14)
                .foregroundStyle(theme[.accent])
            Text(verbatim: format("pageOffer.ready", address))
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textPrimary])
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: metrics.space(.s))
            if environment.features.isOn(.browser) {
                Button("pageOffer.openInPane", action: onOpenInPane)
                    .accessibilityIdentifier("pageOffer.openInPane")
            }
            Button("pageOffer.openInBrowser", action: onOpenInBrowser)
                .accessibilityIdentifier("pageOffer.openInBrowser")
            Button(action: onDismiss) {
                Image(systemName: "xmark").webProfileSized(14).font(metrics.font(.caption).weight(.semibold))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(theme[.textTertiary])
            .help(Text("pageOffer.dismiss"))
            .accessibilityLabel(Text("pageOffer.dismiss"))
            .accessibilityIdentifier("pageOffer.dismiss")
        }
        .controlSize(.small)
        .padding(.horizontal, metrics.space(.m))
        .padding(.vertical, metrics.space(.xs))
        .background(theme[.bgElevated])
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pageOffer")
    }
}
