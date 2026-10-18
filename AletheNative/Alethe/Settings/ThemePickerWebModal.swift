import AletheDesign
import AletheModel
import SwiftUI

/// ThemePickerModal.tsx + controls.module.css (`themeGrid`, `pillRow`): UI theme cards, visual style
/// and terminal theme in one 620-point modal. Choices apply at once; Done marks the walkthrough step.
struct ThemePickerWebModal: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.dismiss) private var dismiss
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    private var terminalTheme: String { environment.preferences?.document.terminalTheme ?? "" }

    private var themes: [Theme] {
        let catalog = environment.themeCatalog
        let builtin = ThemeCatalog.builtinOrder.compactMap { catalog.theme(id: $0) }
        let ids = Set(builtin.map(\.id))
        return builtin + catalog.themes.filter { !ids.contains($0.id) }
    }

    private func closeModal() { if let closeOverlay { closeOverlay() } else { dismiss() } }

    var body: some View {
        ModalsM2WebModal(title: Text("themePicker.title"), close: closeModal, width: 620) {
            VStack(alignment: .leading, spacing: 0) {
                ThemeGrid(webMinimum: 160)
                    .padding(.vertical, 0)
                ProjectGroupWebField(title: "settings.web.reference.prefs.visualStyle") {
                    WebVisualStyleGrid().accessibilityIdentifier("themePicker.style")
                }
                .padding(.top, metrics.size(16)).padding(.bottom, 0)
                ProjectGroupWebField(title: "settings.web.reference.prefs.terminalTheme") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: metrics.size(120)), spacing: metrics.size(8))],
                              spacing: metrics.size(8)) {
                        pill(id: "", title: Text("settings.appearance.followUI"))
                        ForEach(themes) { option in pill(id: option.id, title: option.localizedName) }
                    }
                    .accessibilityIdentifier("themePicker.terminal")
                }
                .padding(.top, metrics.size(16)).padding(.bottom, 0)
            }
        } footer: {
            Text("themePicker.footer").font(metrics.font(size: 10)).foregroundStyle(theme[.fgMuted])
            Spacer()
            Button("themePicker.done", action: done)
                .buttonStyle(AletheButtonStyle(.primary))
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("themePicker.done")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("themePicker")
    }

    private func pill(id: String, title: Text) -> some View {
        let active = terminalTheme == id
        return Button {
            environment.preferences?.update { $0.terminalTheme = id.isEmpty ? nil : id }
        } label: {
            title.font(metrics.font(size: 13)).lineLimit(1)
                .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme[active ? .accentFaint : .bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[active ? .accent : .border], lineWidth: metrics.size(1)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    /// Web `done`: mark the appearance walkthrough step and close.
    private func done() {
        environment.preferences?.update { preferences in
            var steps = preferences.setupDone ?? []
            if !steps.contains(SetupStep.appearance.rawValue) { steps.append(SetupStep.appearance.rawValue) }
            preferences.setupDone = steps
        }
        closeModal()
    }
}
