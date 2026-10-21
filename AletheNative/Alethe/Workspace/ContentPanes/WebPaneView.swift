import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import WebKit

/// Web pane (upstream `WebPane`): a private page with back, forward, reload, an address field, page
/// options (JavaScript, zoom, how long it stays loaded while hidden), open in the default browser and
/// close. Dragging the toolbar's empty space reorders the pane.
struct WebPaneView: View {
    let page: WebPageModel
    let isFocused: Bool
    let onOptionsChange: (WebPaneOptions) -> Void
    let onClose: () -> Void
    let onDrag: (CGSize?) -> Void
    @State private var address = ""
    @State private var invalidAddress = false
    @FocusState private var addressFocused: Bool
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            ZStack {
                WebViewHost(page: page)
                if let failure = page.failure {
                    VStack(spacing: metrics.space(.m)) {
                        Text("web.loadFailed").foregroundStyle(theme[.textPrimary])
                        Text(verbatim: failure).font(metrics.font(.footnote)).foregroundStyle(theme[.textSecondary])
                        Button("web.reload") { page.reload() }
                    }
                    .multilineTextAlignment(.center)
                    .padding(metrics.space(.xl))
                    .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("web.failure")
                }
            }
        }
        .background(theme[.bg])
        .onAppear {
            address = page.url?.absoluteString ?? ""
            page.show()
        }
        .onDisappear { page.hide() }
        .onChange(of: page.url) { _, url in if !addressFocused { address = url?.absoluteString ?? "" } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("web.pane")
    }

    private var toolbar: some View {
        HStack(spacing: metrics.space(.xs)) {
            ContentPaneButton(symbol: "chevron.left", label: "web.back", id: "web.back") { page.goBack() }
                .disabled(!page.canGoBack)
            ContentPaneButton(symbol: "chevron.right", label: "web.forward", id: "web.forward") { page.goForward() }
                .disabled(!page.canGoForward)
            ContentPaneButton(symbol: page.isLoading ? "xmark" : "arrow.clockwise",
                              label: page.isLoading ? "web.stop" : "web.reload", id: "web.reload") {
                if page.isLoading { page.webView?.stopLoading() } else { page.reload() }
            }
            if let name = page.options.name {
                Text(verbatim: name).font(metrics.font(.footnote).weight(.medium))
                    .lineLimit(1).frame(maxWidth: metrics.size(110))
                    .help(Text(verbatim: name))
                    .accessibilityIdentifier("web.name")
            }
            TextField(text: $address) { Text("web.addressPlaceholder") }
                .textFieldStyle(.plain)
                .font(metrics.font(.footnote))
                .padding(.horizontal, metrics.space(.s))
                .padding(.vertical, metrics.space(.xxs))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                    .strokeBorder(theme[invalidAddress ? .statusStopped : .borderSubtle]))
                .focused($addressFocused)
                .onSubmit(go)
                .onChange(of: address) { _, _ in invalidAddress = false }
                .help(Text(verbatim: page.title))
                .accessibilityIdentifier("web.address")
            Text("web.private")
                .font(metrics.font(.caption))
                .foregroundStyle(theme[.textTertiary])
                .help(Text("web.private.help"))
            optionsMenu
            ContentPaneButton(symbol: "safari", label: "web.openInBrowser", id: "web.openInBrowser") {
                if let url = page.url { NSWorkspace.shared.open(url) }
            }
            .disabled(page.url == nil)
            ContentPaneButton(symbol: "xmark", label: "web.close", id: "pane.close", action: onClose)
        }
        .padding(.horizontal, metrics.space(.m))
        .frame(height: metrics.size(30))
        .background(theme[isFocused ? .bgElevated : .bgSunken])
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 4, coordinateSpace: .global)
                .onChanged { onDrag($0.translation) }
                .onEnded { _ in onDrag(nil) }
        )
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.borderSubtle]).frame(height: metrics.size(1)) }
    }

    private var optionsMenu: some View {
        WebMenu {
            Toggle(isOn: Binding(get: { page.options.javascriptEnabled }, set: { update { $0.javascriptEnabled = $1 }($0) })) {
                Text("web.javascript")
            }
            Divider()
            Button("web.zoomIn") { update { options, _ in options.zoom = min(options.zoom + 0.1, WebPaneOptions.zoomRange.upperBound) }(()) }
            Button("web.zoomOut") { update { options, _ in options.zoom = max(options.zoom - 0.1, WebPaneOptions.zoomRange.lowerBound) }(()) }
            Button("web.actualSize") { update { options, _ in options.zoom = 1 }(()) }
            Divider()
            if metrics.isWebInterface {
                ForEach([WebResourceMode.appFirst, .balanced, .keepAlive], id: \.self) { mode in
                    Button { update { $0.resourceMode = $1 }(mode) } label: {
                        WebMenuCheckRow(title: Text(mode == .appFirst ? "web.mode.appFirst" : mode == .balanced ? "web.mode.balanced" : "web.mode.keepAlive"),
                            symbol: "memorychip", selected: mode == page.options.resourceMode)
                    }
                }
            } else {
            Picker(selection: Binding(get: { page.options.resourceMode }, set: { update { $0.resourceMode = $1 }($0) })) {
                Text("web.mode.appFirst").tag(WebResourceMode.appFirst)
                Text("web.mode.balanced").tag(WebResourceMode.balanced)
                Text("web.mode.keepAlive").tag(WebResourceMode.keepAlive)
            } label: { Text("web.mode") }
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(Text("web.options"))
        .accessibilityLabel(Text("web.options"))
        .accessibilityIdentifier("web.options")
    }

    /// A setter that changes a copy of the options, applies it and persists it.
    private func update<Value>(_ change: @escaping (inout WebPaneOptions, Value) -> Void) -> (Value) -> Void {
        { value in
            var options = page.options
            change(&options, value)
            options.zoom = (options.zoom * 10).rounded() / 10
            page.setOptions(options)
            onOptionsChange(options)
        }
    }

    private func go() {
        guard let url = WebAddress.normalize(address) else {
            invalidAddress = true
            NSSound.beep()
            return
        }
        address = url.absoluteString
        page.load(url)
    }
}

/// Hosts the page's current WKWebView, which the model may release and recreate.
private struct WebViewHost: NSViewRepresentable {
    let page: WebPageModel

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ container: NSView, context: Context) {
        guard let webView = page.webView else {
            container.subviews.forEach { $0.removeFromSuperview() }
            return
        }
        guard webView.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
    }
}
