import AletheDesign
import SwiftUI

/// Reuses the terminal overlay's dismissal, scrim and Motion entrance at the CRUD modal widths.
struct ProjectGroupWebOverlay<Content: View>: View {
    let width: CGFloat
    let onClose: () -> Void
    @ViewBuilder let content: (@escaping () -> Void) -> Content
    @Environment(\.metrics) private var metrics

    var body: some View {
        GeometryReader { geometry in
            NewTerminalWebOverlay(onClose: onClose) { close in
                content(close)
                    .frame(width: min(metrics.size(width), max(0, geometry.size.width - metrics.size(48))))
            }
        }
    }
}

/// Modal.module.css header/body/footer; the overlay remains owned by NewTerminalWebOverlay.
struct ProjectGroupWebModal<Content: View>: View {
    let title: LocalizedStringKey
    let confirm: LocalizedStringKey
    let disabled: Bool
    let close: () -> Void
    let submit: () -> Void
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @Environment(\.newTerminalModalHeight) private var maximumHeight
    @Environment(\.webModalHasExplicitHeight) private var explicitHeight
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(metrics.font(size: 15, weight: .semibold))
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark").font(metrics.font(size: 16))
                        .frame(width: metrics.size(26), height: metrics.size(26))
                }
                .buttonStyle(AletheWorkspaceActionStyle())
                .foregroundStyle(theme[.fgMuted])
                .accessibilityLabel(Text("editor.cancel"))
            }
            .padding(.horizontal, metrics.size(20)).padding(.top, metrics.size(16))
            .webModalHeader()
            ScrollView {
                VStack(alignment: .leading, spacing: 0, content: content)
                    .padding(.horizontal, metrics.size(20))
                    .padding(.top, metrics.size(14)).padding(.bottom, metrics.size(18))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: explicitHeight ? nil : min(contentHeight, max(metrics.size(60), maximumHeight - metrics.size(112))))
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
            HStack(spacing: metrics.size(8)) {
                Spacer()
                Button("editor.cancel", action: close)
                    .buttonStyle(AletheButtonStyle()).accessibilityIdentifier("editor.cancel")
                Button(confirm, action: submit)
                    .buttonStyle(AletheButtonStyle(.primary))
                    .disabled(disabled)
                    .keyboardShortcut(.return, modifiers: [])
                    .accessibilityIdentifier("editor.confirm")
            }
            .padding(.horizontal, metrics.size(20))
            .padding(.top, metrics.size(12)).padding(.bottom, metrics.size(16))
        }
        .foregroundStyle(theme[.fg])
        .background(theme[.bgElevated], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
            .strokeBorder(theme[.borderStrong], lineWidth: metrics.size(1)))
        .newTerminalDropdownLayer()
        .webScrollStyle()
        .onExitCommand(perform: close)
    }
}

struct ProjectGroupWebField<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(6)) {
            Text(title).textCase(.uppercase)
                .font(metrics.font(size: 12, weight: .medium)).tracking(metrics.size(0.48))
                .foregroundStyle(theme[.fgMuted])
            content()
        }
        .padding(.bottom, metrics.size(14))
    }
}

/// controls.module.css input and cwdInputWrap focus border.
struct ProjectGroupWebInput: ViewModifier {
    var mono = false
    var focus: FocusState<Bool>.Binding? = nil
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content.textFieldStyle(.plain)
            .font(mono ? metrics.monoFont(size: 12) : metrics.font(size: 14))
            .foregroundStyle(theme[.fg])
            .padding(.horizontal, metrics.size(10)).frame(height: metrics.size(32))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[(focus?.wrappedValue ?? focused) ? .accent : .border], lineWidth: metrics.size(1)))
            .focused(focus ?? $focused)
    }
}

/// GroupFields.module.css flex-wrap keeps the swatches usable at larger interface zoom.
struct ProjectGroupSwatchLayout: Layout {
    let gap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(subviews, width: bounds.width)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                                  anchor: .topLeading, proposal: .unspecified)
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (size: CGSize, points: [CGPoint]) {
        var points: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + gap
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            usedWidth = max(usedWidth, x + size.width)
            x += size.width + gap
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: usedWidth, height: y + rowHeight), points)
    }
}
