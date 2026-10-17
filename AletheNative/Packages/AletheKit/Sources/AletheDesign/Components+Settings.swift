import SwiftUI

/// PreferencesModal.module.css: scrolling sections, option rows and compact control typography.
public struct AletheSettingsForm<Content: View>: View {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    private let content: Content

    public init(@ViewBuilder content: () -> Content) { self.content = content() }

    public var body: some View {
        if metrics.isWebInterface {
            ScrollView {
                VStack(alignment: .leading, spacing: metrics.size(24)) {
                    ForEach(sections: content) { section in
                        AletheSettingsSection(header: section.header, footer: section.footer) {
                            VStack(alignment: .leading, spacing: metrics.size(8)) {
                                ForEach(subviews: section.content) { row in
                                    row
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, metrics.size(12))
                                        .padding(.vertical, metrics.size(10))
                                        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, metrics.size(24))
                .padding(.top, metrics.size(28))
                .padding(.bottom, metrics.size(52))
            }
            .font(metrics.font(size: 12))
            .foregroundStyle(theme[.fg])
            .toggleStyle(AletheSettingsToggleStyle())
            .labeledContentStyle(AletheSettingsLabeledStyle())
            .buttonStyle(AletheButtonStyle(size: .small))
            .pickerStyle(.menu)
            .background(theme[.bgElevated])
        } else {
            Form { content }
        }
    }
}

private struct AletheSettingsToggleStyle: ToggleStyle {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: metrics.size(14)) {
            VStack(alignment: .leading, spacing: metrics.size(4)) {
                ForEach(subviews: configuration.label) { text in
                    text.font(metrics.font(size: 12))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            Toggle(isOn: configuration.$isOn) { EmptyView() }
                .labelsHidden()
                .toggleStyle(.checkbox)
                .tint(theme[.accent])
                .fixedSize()
        }
    }
}

private struct AletheSettingsLabeledStyle: LabeledContentStyle {
    @Environment(\.metrics) private var metrics

    func makeBody(configuration: Configuration) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: metrics.size(14)) {
                configuration.label.fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: metrics.size(14))
                configuration.content
            }
            VStack(alignment: .leading, spacing: metrics.size(8)) {
                configuration.label
                configuration.content
            }
        }
    }
}

/// Native Forms retain their original intrinsic sizing; web Forms scroll within the dialog.
public struct AletheSettingsSizing: ViewModifier {
    @Environment(\.metrics) private var metrics
    public init() {}
    public func body(content: Content) -> some View {
        if metrics.isWebInterface { content } else {
            content.scrollDisabled(true).fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct AletheSettingsSection<Header: View, Footer: View, Content: View>: View {
    let header: Header
    let footer: Footer
    let content: Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var collapsed = false

    init(header: Header, footer: Footer, @ViewBuilder content: () -> Content) {
        self.header = header
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(18)) {
            Group(subviews: header) { headings in
                if !headings.isEmpty {
                    Button { collapsed.toggle() } label: {
                        HStack(spacing: metrics.size(9)) {
                            Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                                .font(metrics.font(size: 9, weight: .semibold))
                                .opacity(0.65)
                            header.font(metrics.font(size: 16, weight: 620))
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            if !collapsed {
                footer.font(metrics.font(size: 11))
                    .foregroundStyle(theme[.fgMuted])
                    .fixedSize(horizontal: false, vertical: true)
                content
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, metrics.size(24))
        .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
    }
}
