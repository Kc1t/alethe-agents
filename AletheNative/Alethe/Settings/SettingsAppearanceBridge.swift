import AletheDesign
import AletheTerminal
import AppKit
import SwiftUI

/// Attached to the web titlebar so changing interface removes the opacity override.
struct SettingsWindowOpacity: NSViewRepresentable {
    let value: Double
    func makeNSView(context: Context) -> OpacityView { OpacityView() }
    func updateNSView(_ view: OpacityView, context: Context) {
        view.opacity = min(1, max(0.6, value))
        view.window?.alphaValue = view.opacity
    }
    static func dismantleNSView(_ view: OpacityView, coordinator: ()) { view.window?.alphaValue = 1 }

    final class OpacityView: NSView {
        var opacity = 1.0
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.alphaValue = opacity
        }
    }
}

/// Reapply the terminal-only palette after a terminal mounts or the app theme changes.
struct SettingsTerminalThemeBridge: View {
    @Environment(AppEnvironment.self) private var environment
    private struct Appearance: Equatable {
        let terminal: String?
        let ui: String
        let style: String?
        let scale: Double
        let tabs: [String]
        let shell: String?
        let font: String?
    }
    var body: some View {
        let preferences = environment.preferences?.document
        let appearance = Appearance(terminal: preferences?.terminalTheme, ui: environment.theme.id,
            style: preferences?.visualStyle, scale: preferences?.uiScale ?? 1,
            tabs: environment.terminals.states.keys.map(\.rawValue).sorted(),
            shell: preferences?.shellPath, font: preferences?.terminalFontFamily)
        Color.clear.frame(width: 0, height: 0)
            .task(id: appearance) {
                ShellLaunch.shellOverride = appearance.shell
                let family = appearance.font?.split(separator: ",").first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) }
                if TerminalAppearance.fontFamilyOverride != family {
                    TerminalAppearance.fontFamilyOverride = family
                    environment.terminals.applyAppearance(theme: environment.theme, fontSize: environment.terminalFontSize)
                }
                guard let id = appearance.terminal else { return }
                // Let the shell's theme observer finish before applying the independent palette.
                await Task.yield()
                guard !Task.isCancelled else { return }
                environment.terminals.applyAppearance(theme: environment.themeCatalog.resolved(id: id),
                    fontSize: environment.terminalFontSize)
            }
            .onChange(of: appearance.terminal) { _, id in
                if id == nil {
                    environment.terminals.applyAppearance(theme: environment.theme, fontSize: environment.terminalFontSize)
                }
            }
            .onDisappear {
                environment.terminals.applyAppearance(theme: environment.theme, fontSize: environment.terminalFontSize)
            }
    }
}
