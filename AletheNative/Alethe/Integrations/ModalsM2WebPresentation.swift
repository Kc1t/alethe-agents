import AletheDesign
import SwiftUI

/// Modal.tsx / Modal.module.css chrome for the integration dialogs.
/// Presentation owners supply NewTerminalWebOverlay so sheets stay native in mac mode.
struct ModalsM2WebModal<Body: View, Footer: View>: View {
    let title: Text
    let close: () -> Void
    var width: CGFloat = 480
    @ViewBuilder let content: () -> Body
    @ViewBuilder let footer: () -> Footer
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @Environment(\.webModalHasExplicitHeight) private var explicitHeight
    @Environment(\.modalsM2Close) private var closeOverlay
    @State private var bodyHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(4)) {
                title.font(metrics.font(size: 15, weight: .semibold))
                Spacer(minLength: 0)
                Button(action: close) {
                    Image(systemName: "xmark").font(metrics.font(size: 16))
                        .frame(width: metrics.size(26), height: metrics.size(26))
                }
                .buttonStyle(AletheWorkspaceActionStyle())
                .foregroundStyle(theme[.fgMuted])
                .accessibilityLabel(Text("modalsM2.close"))
            }
            .padding(.horizontal, metrics.size(20)).padding(.top, metrics.size(16))
            .webModalHeader()
            ScrollView {
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, metrics.size(20))
                    .padding(.top, metrics.size(14)).padding(.bottom, metrics.size(18))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bodyHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .webScrollStyle()
            .frame(height: explicitHeight ? nil : min(bodyHeight, max(metrics.size(60), maximumHeight - metrics.size(112))))
            if Footer.self != EmptyView.self {
                Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
                HStack(spacing: metrics.size(8)) { footer() }
                    .buttonStyle(AletheButtonStyle())
                    .padding(.horizontal, metrics.size(20))
                    .padding(.top, metrics.size(12)).padding(.bottom, metrics.size(16))
            }
        }
        .font(metrics.font(size: 13))
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
        .frame(width: closeOverlay == nil ? metrics.size(width) : nil)
        .newTerminalDropdownLayer()
        .onExitCommand(perform: close)
    }
}

/// AddServerFlow.module.css segmented control, with keyboard-selectable buttons.
struct ModalsM2Segments<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, LocalizedStringKey)]
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: metrics.size(2)) {
            ForEach(options.indices, id: \.self) { index in
                Button { selection = options[index].0 } label: {
                    Text(options[index].1).font(metrics.font(size: 12))
                        .padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(4))
                        .background(theme[.bgElevated].opacity(selection == options[index].0 ? 1 : 0),
                                    in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme[selection == options[index].0 ? .fg : .fgMuted])
                .accessibilityAddTraits(selection == options[index].0 ? [.isSelected] : [])
            }
        }
        .padding(metrics.size(3))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .fixedSize()
    }
}

struct ModalsM2RowStyle: ButtonStyle {
    var selected = false
    var vertical: CGFloat = 7
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        ModalsM2RowLabel(configuration: configuration, selected: selected, vertical: vertical)
    }

    private struct ModalsM2RowLabel: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let vertical: CGFloat
        @Environment(\.metrics) private var metrics
        @Environment(\.theme) private var theme
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(metrics.font(size: 12.5))
                .foregroundStyle(theme[selected || hovering ? .fg : .fgMuted])
                .padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(vertical))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme[selected ? .surfaceCardSelected : .panelHover].opacity(selected || hovering ? 1 : 0),
                            in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[.borderStrong].opacity(selected ? 1 : 0), lineWidth: metrics.size(1)))
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

struct ModalsM2Input: ViewModifier {
    var mono = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @FocusState private var focused: Bool
    func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.textFieldStyle(.plain)
                .font(mono ? metrics.monoFont(size: 11.5) : metrics.font(size: 12.5))
                .padding(.horizontal, metrics.size(10)).padding(.vertical, metrics.size(7))
                .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[focused ? .accent : .border], lineWidth: metrics.size(1)))
                .focused($focused)
        } else { content }
    }
}

/// agentActions.module.css pre.log, with an auto-scrolling live installer transcript.
struct ModalsM2InstallLog: View {
    let log: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        if !log.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    Text(verbatim: log).font(metrics.monoFont(size: 11))
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).id("log")
                }
                .frame(maxHeight: metrics.size(160))
                .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(6))
                .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .onChange(of: log) { _, _ in proxy.scrollTo("log", anchor: .bottom) }
            }
        }
    }
}

/// agentActions.module.css `.toolchain`: a bordered box for the Node.js / advisory sub-sections.
struct ModalsM2Toolchain<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(6), content: content)
            .padding(metrics.size(8))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

/// agentActions.module.css `.command`: the exact command, one selectable monospaced line.
struct ModalsM2Command: View {
    let command: String
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(verbatim: command).font(metrics.monoFont(size: 11)).foregroundStyle(theme[.fgMuted])
                .textSelection(.enabled).fixedSize()
        }
        .padding(.horizontal, metrics.size(8)).padding(.vertical, metrics.size(4))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

/// The "Node.js is missing" section shared by the agent and 9router install modals.
struct ModalsM2NodeToolchain: View {
    let command: String?
    let running: Bool
    let canInstall: Bool
    let install: () -> Void
    let download: () -> Void
    @Environment(\.metrics) private var metrics
    var body: some View {
        ModalsM2Toolchain {
            Text("agentInstall.needsNode").font(metrics.font(size: 13))
            HStack(spacing: metrics.size(8)) {
                if command != nil {
                    Button(action: install) {
                        Label { Text(running ? "agentInstall.web.installing" : "agentInstall.web.installNode") }
                            icon: { Image(systemName: "arrow.down.to.line").font(metrics.font(size: 13)) }
                    }
                    .buttonStyle(AletheInstallActionStyle(.primary)).disabled(running || !canInstall)
                }
                Button(action: download) {
                    Label { Text("agentInstall.nodeDownload") }
                        icon: { Image(systemName: "arrow.up.right.square").font(metrics.font(size: 13)) }
                }
                .buttonStyle(AletheInstallActionStyle(.link))
            }
            if let command { ModalsM2Command(command: command) }
        }
    }
}

extension EnvironmentValues {
    @Entry var modalsM2Close: (() -> Void)? = nil
}

/// Scrollable settings content embedded in a modal uses a bounded viewport at every interface zoom.
struct WebSettingsSubdialog<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: () -> Content
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @Environment(\.metrics) private var metrics

    var body: some View {
        GitWebModal(close: { closeOverlay?() }) {
            Text(title)
        } content: {
            content()
                .frame(height: max(metrics.size(100), min(metrics.size(420), maximumHeight - metrics.size(140))))
        } footer: {
            Spacer()
            Button("agentInstall.done") { closeOverlay?() }
                .accessibilityIdentifier("settingsSubdialog.done")
        }
    }
}

/// Destructive actions keep an explicit confirmation while using the active theme and window layer.
struct WebConfirmationModal: View {
    let title: Text
    let message: Text
    let confirm: LocalizedStringKey
    var destructive = true
    var confirmIdentifier = "webConfirmation.confirm"
    let action: () -> Void
    @Environment(\.modalsM2Close) private var closeOverlay
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        GitWebModal(close: { closeOverlay?() }) {
            title
        } content: {
            message.font(metrics.font(size: 12)).foregroundStyle(theme[.fgMuted])
        } footer: {
            Spacer()
            Button("editor.cancel") { closeOverlay?() }
            Button(confirm) { action(); closeOverlay?() }
                .buttonStyle(AletheButtonStyle(destructive ? .danger : .primary))
                .accessibilityIdentifier(confirmIdentifier)
        }
    }
}
