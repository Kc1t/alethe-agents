import AletheDesign
import SwiftUI

/// UI-test fixture for the hit-target harness (P0-9), shown instead of the workspace when the app is
/// launched with `-AletheUITestFixture hit-targets` (debug builds only).
///
/// Every control reports its state through an accessibility value, so a test can click the control
/// where it is drawn and verify the click landed. `-AletheUITestScale <n>` applies the UI scale the
/// supported way (metrics); `-AletheUITestBrokenScale YES` applies `scaleEffect` instead (the first
/// attempt's zoom). `-AletheUITestBrokenOverlay YES` adds an invisible full-window view that takes
/// clicks, and the harness must catch it.
struct HitTargetFixture: View {
    @State private var toggleOn = false
    @State private var taps = 0
    @State private var segment = 0
    @State private var text = ""

    private let scale = CGFloat(UserDefaults.standard.double(forKey: "AletheUITestScale").nonZero ?? 1)
    private let brokenScale = UserDefaults.standard.bool(forKey: "AletheUITestBrokenScale")
    private let brokenOverlay = UserDefaults.standard.bool(forKey: "AletheUITestBrokenOverlay")

    var body: some View {
        let metrics = Metrics(scale: brokenScale ? 1 : scale)
        let content = VStack(alignment: .leading, spacing: metrics.space(.l)) {
            Toggle(isOn: $toggleOn) { Text(verbatim: "Toggle") }
                .accessibilityIdentifier("fixture.toggle")
                .accessibilityValue(Text(verbatim: toggleOn ? "on" : "off"))
            Button { taps += 1 } label: { Text(verbatim: "Button") }
                .accessibilityIdentifier("fixture.button")
                .accessibilityValue(Text(verbatim: "\(taps)"))
            Picker(selection: $segment) {
                Text(verbatim: "One").tag(0)
                Text(verbatim: "Two").tag(1)
                Text(verbatim: "Three").tag(2)
            } label: { Text(verbatim: "Segments") }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("fixture.segments")
            TextField(text: $text) { Text(verbatim: "Field") }
                .accessibilityIdentifier("fixture.field")
                .frame(width: metrics.size(240))
            AppKitButton()
                .frame(width: metrics.size(160), height: metrics.size(28))
        }
        .font(metrics.font(.body))
        // Far from the scaleEffect anchor (top-leading): there a scaled drawing and the real
        // AppKit hit area no longer overlap, which is where the original bug bit.
        .padding(.leading, metrics.size(420))
        .padding(.top, metrics.size(260))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        Group {
            if brokenScale {
                content.scaleEffect(scale == 1 ? 0.9 : scale, anchor: .topLeading)
            } else {
                content
            }
        }
        .overlay {
            if brokenOverlay {
                Color.clear.contentShape(Rectangle()).onTapGesture {}
            }
        }
    }
}

/// A control that is an `NSView` for certain: the case `scaleEffect` breaks.
private struct AppKitButton: NSViewRepresentable {
    @MainActor final class Coordinator: NSObject {
        var clicks = 0
        @objc func clicked(_ sender: NSButton) {
            clicks += 1
            sender.setAccessibilityValue("\(clicks)")
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: "AppKit", target: context.coordinator, action: #selector(Coordinator.clicked(_:)))
        button.setAccessibilityIdentifier("fixture.appkit")
        button.setAccessibilityValue("0")
        return button
    }

    func updateNSView(_ view: NSButton, context: Context) {}
}

private extension Double {
    var nonZero: Double? { self == 0 ? nil : self }
}
