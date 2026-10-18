import AletheDesign
import SwiftUI

extension EnvironmentValues {
    @Entry var gitModalClose: (() -> Void)? = nil
    @Entry var gitWebHasPresentationLayer = false
}

/// Modal.module.css chrome; presentation owners supply the existing window-local overlay.
struct GitWebModal<Header: View, Body: View, Footer: View>: View {
    let close: () -> Void
    var closeIdentifier = "editor.cancel"
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Body
    @ViewBuilder let footer: () -> Footer
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @Environment(\.webModalHasExplicitHeight) private var explicitHeight
    @State private var measuredHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: metrics.size(8)) {
                header().font(metrics.font(size: 15, weight: .semibold))
                Spacer(minLength: 0)
                Button(action: close) {
                    Image(systemName: "xmark").font(metrics.font(size: 16))
                }
                .buttonStyle(AletheIconButtonStyle(side: 26))
                .accessibilityLabel(Text("editor.cancel"))
                .accessibilityIdentifier(closeIdentifier)
            }
            .padding(.horizontal, metrics.size(20)).padding(.top, metrics.size(16))
            .webModalHeader()
            ScrollView {
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, metrics.size(20))
                    .padding(.top, metrics.size(14)).padding(.bottom, metrics.size(18))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measuredHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .webScrollStyle()
            .frame(height: explicitHeight ? nil : min(measuredHeight, max(metrics.size(60), maximumHeight - metrics.size(112))))
            if Footer.self != EmptyView.self {
                Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
                HStack(spacing: metrics.size(8), content: footer)
                    .buttonStyle(AletheButtonStyle())
                    .padding(.horizontal, metrics.size(20))
                    .padding(.top, metrics.size(12)).padding(.bottom, metrics.size(16))
            }
        }
        .buttonStyle(AletheButtonStyle())
        .tint(theme[.accent])
        .font(metrics.font(size: 13))
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
        .newTerminalDropdownLayer()
        .onExitCommand(perform: close)
    }
}

struct GitWebOverlay<Content: View>: View {
    var width: CGFloat = 480
    let close: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        NewTerminalWebOverlay(onClose: close, defaultWidth: width,
                              minimumWidth: min(width, 320)) { animatedClose in
            content().environment(\.gitModalClose, animatedClose)
                .environment(\.modalsM2Close, animatedClose)
        }
        .gitWebModalLayer()
    }
}

/// Requests bubble to the window's presentation layer, so a sidebar or a nested modal cannot
/// constrain the overlay's backdrop, drag bounds or resize handles.
struct GitWebPresentation {
    let width: CGFloat
    let close: () -> Void
    let content: () -> AnyView
}

struct GitWebPresentationKey: PreferenceKey {
    static var defaultValue: [GitWebPresentation] { [] }
    static func reduce(value: inout [GitWebPresentation], nextValue: () -> [GitWebPresentation]) {
        value.append(contentsOf: nextValue())
    }
}

private struct GitWebPresentationLayer: ViewModifier {
    func body(content: Content) -> some View {
        content.environment(\.gitWebHasPresentationLayer, true).overlayPreferenceValue(GitWebPresentationKey.self) { requests in
            if let request = requests.last {
                AnyView(GitWebOverlay(width: request.width, close: request.close, content: request.content))
            }
        }
        .transformPreference(GitWebPresentationKey.self) { $0 = [] }
    }
}

/// Nested Git dialogs preserve their system sheet in the native interface.
private struct GitWebSheet<Sheet: View>: ViewModifier {
    @Binding var isPresented: Bool
    let width: CGFloat
    @ViewBuilder let sheet: () -> Sheet
    @Environment(\.metrics) private var metrics
    @Environment(\.gitWebHasPresentationLayer) private var hasLayer

    func body(content: Content) -> some View {
        if metrics.isWebInterface && hasLayer {
            content.transformPreference(GitWebPresentationKey.self) { requests in
                if isPresented {
                    requests.append(GitWebPresentation(width: width, close: { isPresented = false },
                        content: { AnyView(sheet()) }))
                }
            }
        } else {
            content.sheet(isPresented: $isPresented) {
                if metrics.isWebInterface {
                    sheet().environment(\.gitModalClose, { isPresented = false })
                        .frame(width: metrics.size(width))
                } else { sheet() }
            }
        }
    }
}

extension View {
    func gitWebSheet<Sheet: View>(isPresented: Binding<Bool>, width: CGFloat,
                                  @ViewBuilder content: @escaping () -> Sheet) -> some View {
        modifier(GitWebSheet(isPresented: isPresented, width: width, sheet: content))
    }

    /// Install once on the window content, alongside the editor overlay.
    func gitWebModalLayer() -> some View { modifier(GitWebPresentationLayer()) }
}

/// Identifiable settings/configuration editors use the same window layer as Boolean presentations.
private struct GitWebItemSheet<Item: Identifiable, Sheet: View>: ViewModifier {
    @Binding var item: Item?
    let width: CGFloat
    let onDismiss: (() -> Void)?
    @ViewBuilder let sheet: (Item) -> Sheet
    @Environment(\.metrics) private var metrics
    @Environment(\.gitWebHasPresentationLayer) private var hasLayer

    func body(content: Content) -> some View {
        if metrics.isWebInterface && hasLayer {
            content.transformPreference(GitWebPresentationKey.self) { requests in
                if let value = item {
                    requests.append(GitWebPresentation(width: width, close: { item = nil },
                        content: { AnyView(sheet(value)) }))
                }
            }
            .onChange(of: item?.id) { old, current in
                if old != nil && current == nil { onDismiss?() }
            }
        } else {
            content.sheet(item: $item, onDismiss: onDismiss) { value in
                sheet(value)
                    .environment(\.gitModalClose, metrics.isWebInterface ? { item = nil } : nil)
                    .environment(\.modalsM2Close, metrics.isWebInterface ? { item = nil } : nil)
            }
        }
    }
}

extension View {
    func gitWebSheet<Item: Identifiable, Sheet: View>(item: Binding<Item?>, width: CGFloat,
        onDismiss: (() -> Void)? = nil, @ViewBuilder content: @escaping (Item) -> Sheet) -> some View {
        modifier(GitWebItemSheet(item: item, width: width, onDismiss: onDismiss, sheet: content))
    }
}
