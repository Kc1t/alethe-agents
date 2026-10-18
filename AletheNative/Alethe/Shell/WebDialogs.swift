import AppKit
import AletheDesign
import Observation
import SwiftUI

/// The web app asks with `window.confirm` / `window.prompt`; the macOS port shows the same two
/// questions in the themed modal chrome instead of an AppKit alert. One queue serves every caller.
@MainActor
@Observable
final class WebDialogCenter {
    static let shared = WebDialogCenter()

    enum Outcome { case cancelled, confirmed(String), alternate }

    final class Request: Identifiable {
        let id = UUID()
        let title: String?
        let message: String
        let confirmTitle: String
        let cancelTitle: String
        let destructive: Bool
        /// A second, destructive way to accept (for example "close panes" next to "keep panes").
        let alternateTitle: String?
        /// Non-nil makes this a prompt, pre-filled with the value.
        let promptDefault: String?
        /// A bespoke modal body (for example the grid modal) instead of a message and two buttons.
        var custom: ((_ finish: @escaping (Outcome) -> Void) -> AnyView)?
        var width: CGFloat = 420
        var pending: Outcome = .cancelled
        var decided = false
        var resolver: ((Outcome) -> Void)?

        init(title: String?, message: String, confirmTitle: String, cancelTitle: String,
             destructive: Bool, alternateTitle: String?, promptDefault: String?) {
            self.title = title
            self.message = message
            self.confirmTitle = confirmTitle
            self.cancelTitle = cancelTitle
            self.destructive = destructive
            self.alternateTitle = alternateTitle
            self.promptDefault = promptDefault
        }

        func resolve() {
            resolver?(pending)
            resolver = nil
        }
    }

    private(set) var queue: [Request] = []
    /// Windows that installed `webDialogLayer()`; without one the question falls back to NSAlert.
    var layers = 0
    var isWeb = false
    /// True when a question will use the themed dialog rather than an AppKit alert.
    var themed: Bool { isWeb && layers > 0 }

    func confirm(_ message: String, title: String? = nil, confirmTitle: String? = nil,
                 cancelTitle: String? = nil, destructive: Bool = false) async -> Bool {
        if case .confirmed = await ask(message: message, title: title, confirmTitle: confirmTitle,
                                       cancelTitle: cancelTitle, destructive: destructive, alternateTitle: nil, promptDefault: nil) {
            return true
        }
        return false
    }

    /// Three-way question: `nil` cancelled, `false` confirmed, `true` alternate.
    func choose(_ message: String, title: String? = nil, confirmTitle: String, alternateTitle: String?) async -> Bool? {
        switch await ask(message: message, title: title, confirmTitle: confirmTitle, cancelTitle: nil,
                         destructive: false, alternateTitle: alternateTitle, promptDefault: nil) {
        case .confirmed: false
        case .alternate: true
        case .cancelled: nil
        }
    }

    /// Shows `content` in the themed overlay; `finish` closes it with an outcome. Falls back to a
    /// cancelled outcome when no themed layer exists.
    func present<Content: View>(width: CGFloat,
                                @ViewBuilder content: @escaping (_ finish: @escaping (Outcome) -> Void) -> Content) async -> Outcome {
        guard themed else { return .cancelled }
        return await withCheckedContinuation { continuation in
            let request = Request(title: nil, message: "", confirmTitle: "", cancelTitle: "",
                                  destructive: false, alternateTitle: nil, promptDefault: nil)
            request.width = width
            request.custom = { finish in AnyView(content(finish)) }
            let id = request.id
            request.resolver = { [weak self] outcome in
                continuation.resume(returning: outcome)
                self?.queue.removeAll { $0.id == id }
            }
            queue.append(request)
        }
    }

    func prompt(_ message: String, initial: String = "", title: String? = nil,
                confirmTitle: String? = nil, cancelTitle: String? = nil) async -> String? {
        if case .confirmed(let value) = await ask(message: message, title: title, confirmTitle: confirmTitle,
                                                  cancelTitle: cancelTitle, destructive: false,
                                                  alternateTitle: nil, promptDefault: initial) {
            return value
        }
        return nil
    }

    private func ask(message: String, title: String?, confirmTitle: String?, cancelTitle: String?,
                     destructive: Bool, alternateTitle: String?, promptDefault: String?) async -> Outcome {
        let ok = confirmTitle ?? String(localized: "dialog.ok")
        let cancel = cancelTitle ?? String(localized: "editor.cancel")
        guard themed else {
            return Self.systemAlert(message, title, ok, cancel, destructive, alternateTitle, promptDefault)
        }
        return await withCheckedContinuation { continuation in
            let request = Request(title: title, message: message, confirmTitle: ok, cancelTitle: cancel,
                                  destructive: destructive, alternateTitle: alternateTitle, promptDefault: promptDefault)
            let id = request.id
            request.resolver = { [weak self] outcome in
                continuation.resume(returning: outcome)
                self?.queue.removeAll { $0.id == id }
            }
            queue.append(request)
        }
    }

    /// Only reached from windows with no themed layer (for example the Settings window).
    private static func systemAlert(_ message: String, _ title: String?, _ ok: String, _ cancel: String,
                                    _ destructive: Bool, _ alternate: String?, _ promptDefault: String?) -> Outcome {
        let alert = NSAlert()
        alert.messageText = title ?? message
        if title != nil { alert.informativeText = message }
        if destructive { alert.alertStyle = .warning }
        alert.addButton(withTitle: ok)
        if let alternate { alert.addButton(withTitle: alternate) }
        alert.addButton(withTitle: cancel)
        var field: NSTextField?
        if let promptDefault {
            let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
            input.stringValue = promptDefault
            alert.accessoryView = input
            alert.window.initialFirstResponder = input
            field = input
        }
        let response = alert.runModal()
        if response == .alertFirstButtonReturn { return .confirmed(field?.stringValue ?? "") }
        if alternate != nil, response == .alertSecondButtonReturn { return .alternate }
        return .cancelled
    }
}

/// `Modal.module.css` chrome around a confirm/prompt question.
private struct WebDialogContent: View {
    let request: WebDialogCenter.Request
    let close: () -> Void
    @Environment(\.metrics) private var metrics
    @State private var text: String
    @FocusState private var focused: Bool

    init(request: WebDialogCenter.Request, close: @escaping () -> Void) {
        self.request = request
        self.close = close
        _text = State(initialValue: request.promptDefault ?? "")
    }

    var body: some View {
        GitWebModal(close: close, closeIdentifier: "dialog.cancel") {
            Text(verbatim: request.title ?? "Alethe")
        } content: {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                Text(verbatim: request.message)
                    .font(metrics.font(size: 13))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("dialog.message")
                if request.promptDefault != nil {
                    TextField(text: $text) { Text("dialog.input") }
                        .modifier(ProjectGroupWebInput(focus: $focused))
                        .onSubmit(confirm)
                        .accessibilityIdentifier("dialog.input")
                }
            }
        } footer: {
            Spacer(minLength: 0)
            Button { close() } label: { Text(verbatim: request.cancelTitle) }
                .accessibilityIdentifier("dialog.cancelButton")
            if let alternate = request.alternateTitle {
                Button { request.pending = .alternate; close() } label: { Text(verbatim: alternate) }
                    .buttonStyle(AletheButtonStyle(.danger))
                    .accessibilityIdentifier("dialog.alternate")
            }
            Button(action: confirm) { Text(verbatim: request.confirmTitle) }
                .buttonStyle(AletheButtonStyle(request.destructive ? .danger : .primary))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("dialog.confirm")
        }
        .onAppear { focused = true }
    }

    private func confirm() {
        request.pending = .confirmed(text)
        close()
    }
}

private struct WebDialogLayer: ViewModifier {
    @State private var center = WebDialogCenter.shared
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        content
            .onAppear { center.layers += 1; center.isWeb = metrics.isWebInterface }
            .onChange(of: metrics.isWebInterface) { _, web in center.isWeb = web }
            .onDisappear { center.layers = max(0, center.layers - 1) }
            .overlay {
                if metrics.isWebInterface, let request = center.queue.first {
                    NewTerminalWebOverlay(onClose: { request.resolve() }, defaultWidth: request.width,
                                          minimumWidth: min(request.width, 320), minimumHeight: 120) { close in
                        if let custom = request.custom {
                            custom { outcome in
                                if !request.decided { request.pending = outcome; request.decided = true }
                                close()
                            }
                        } else {
                            WebDialogContent(request: request, close: close)
                        }
                    }
                    .id(request.id)
                }
            }
    }
}

extension View {
    /// Install once per window, above every other modal layer.
    func webDialogLayer() -> some View { modifier(WebDialogLayer()) }

    /// Web interface only: asks `message` in the themed dialog when `isPresented` turns true and
    /// runs `perform` on confirmation. The `.mac` path keeps its own confirmation dialog.
    func webConfirm(isPresented: Binding<Bool>, message: @autoclosure @escaping () -> String,
                    title: @autoclosure @escaping () -> String? = nil, confirmTitle: String? = nil,
                    destructive: Bool = false, perform: @escaping () -> Void) -> some View {
        modifier(WebConfirmModifier(isPresented: isPresented, message: message, title: title,
                                    confirmTitle: confirmTitle, destructive: destructive, perform: perform))
    }

    /// Web interface only: the `window.prompt` counterpart of `webConfirm`.
    func webPrompt(isPresented: Binding<Bool>, message: @autoclosure @escaping () -> String,
                   initial: @autoclosure @escaping () -> String = "", confirmTitle: String? = nil,
                   perform: @escaping (String) -> Void) -> some View {
        modifier(WebPromptModifier(isPresented: isPresented, message: message, initial: initial,
                                   confirmTitle: confirmTitle, perform: perform))
    }
}

private struct WebConfirmModifier: ViewModifier {
    @Binding var isPresented: Bool
    let message: () -> String
    let title: () -> String?
    let confirmTitle: String?
    let destructive: Bool
    let perform: () -> Void
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        content
            .onAppear { if isPresented { ask() } }
            .onChange(of: isPresented) { _, presented in if presented { ask() } }
    }

    private func ask() {
        guard metrics.isWebInterface else { return }
        let text = message(), heading = title()
        Task { @MainActor in
            let accepted = await WebDialogCenter.shared.confirm(text, title: heading, confirmTitle: confirmTitle,
                                                                destructive: destructive)
            if accepted { perform() }
            isPresented = false
        }
    }
}

private struct WebPromptModifier: ViewModifier {
    @Binding var isPresented: Bool
    let message: () -> String
    let initial: () -> String
    let confirmTitle: String?
    let perform: (String) -> Void
    @Environment(\.metrics) private var metrics

    func body(content: Content) -> some View {
        content
            .onAppear { if isPresented { ask() } }
            .onChange(of: isPresented) { _, presented in if presented { ask() } }
    }

    private func ask() {
        guard metrics.isWebInterface else { return }
        let text = message(), value = initial()
        Task { @MainActor in
            let answer = await WebDialogCenter.shared.prompt(text, initial: value, confirmTitle: confirmTitle)
            if let answer { perform(answer) }
            isPresented = false
        }
    }
}
