import AletheDesign
import AletheIntegrations
import AletheModel
import SwiftUI

/// Settings › Features › Playwright Browser (upstream `FeaturesPage` sub-panel): shared or dedicated
/// browser, headless choices, and the shared browser's status with Start and Stop.
struct PlaywrightOptions: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    private var document: PreferencesDocument? { environment.preferences?.document }

    private var mode: Binding<PlaywrightBrowserMode> {
        Binding {
            document?.playwrightBrowserMode.flatMap(PlaywrightBrowserMode.init(rawValue:)) ?? .shared
        } set: { mode in
            environment.preferences?.update { $0.playwrightBrowserMode = mode == .shared ? nil : mode.rawValue }
        }
    }

    private var dedicatedHeadless: Binding<Bool> {
        Binding { document?.playwrightDedicatedHeadless ?? false } set: { on in
            environment.preferences?.update { $0.playwrightDedicatedHeadless = on ? true : nil }
        }
    }

    private var sharedHeadless: Binding<Bool> {
        Binding { document?.playwrightSharedHeadless ?? false } set: { on in
            environment.preferences?.update { $0.playwrightSharedHeadless = on ? true : nil }
        }
    }

    private var browserPath: Binding<String> {
        Binding { document?.playwrightBrowserPath ?? "" } set: { path in
            let trimmed = path.trimmingCharacters(in: .whitespaces)
            environment.preferences?.update { $0.playwrightBrowserPath = trimmed.isEmpty ? nil : path }
        }
    }

    var body: some View {
        if metrics.isWebInterface {
            HStack(spacing: metrics.size(12)) {
                Text("settings.playwright.mode").font(metrics.font(size: 11))
                Spacer(minLength: 0)
                AletheWebChoiceSegments(selection: mode, options: [PlaywrightBrowserMode.shared, .dedicated], compact: true) {
                    Text($0 == .shared ? "settings.playwright.mode.shared" : "settings.playwright.mode.dedicated")
                }
            }.accessibilityIdentifier("settings.playwright.mode")
        } else {
            Picker("settings.playwright.mode", selection: mode) {
                Text("settings.playwright.mode.shared").tag(PlaywrightBrowserMode.shared)
                Text("settings.playwright.mode.dedicated").tag(PlaywrightBrowserMode.dedicated)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.playwright.mode")
        }
        Group {
            if mode.wrappedValue == .shared {
                Text("settings.playwright.mode.shared.hint")
            } else {
                Text("settings.playwright.mode.dedicated.hint")
            }
        }
        .font((metrics.isWebInterface ? metrics.font(size: 10) : metrics.font(.footnote)))
            .foregroundStyle(theme[.textSecondary])
        switch mode.wrappedValue {
        case .dedicated:
            Toggle("settings.playwright.dedicatedHeadless", isOn: dedicatedHeadless)
                .accessibilityIdentifier("settings.playwright.dedicatedHeadless")
        case .shared:
            sharedBrowser
        }
    }

    @ViewBuilder private var sharedBrowser: some View {
        let browser = environment.playwright
        LabeledContent {
            HStack {
                if browser.state == .starting { WebBusyIndicator() }
                if case .running = browser.state {
                    Button("settings.playwright.stop") { Task { await browser.stop() } }
                        .accessibilityIdentifier("settings.playwright.stop")
                } else {
                    Button("settings.playwright.start") {
                        browser.launch(executable: document?.playwrightBrowserPath,
                                       headless: document?.playwrightSharedHeadless ?? false)
                    }
                    .disabled(browser.state == .starting)
                    .accessibilityIdentifier("settings.playwright.start")
                }
            }
        } label: {
            Text("settings.playwright.shared.title")
            status(browser.state)
                .id(browser.state)
                .accessibilityIdentifier("settings.playwright.status")
        }
        .task {
            // A headed browser can be quit by the user at any time.
            while !Task.isCancelled {
                browser.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        Toggle("settings.playwright.sharedHeadless", isOn: sharedHeadless)
            .accessibilityIdentifier("settings.playwright.sharedHeadless")
        TextField("settings.playwright.browserPath", text: browserPath,
                  prompt: Text("settings.playwright.browserPath.placeholder"))
            .webFieldSurface()
            .accessibilityIdentifier("settings.playwright.browserPath")
    }

    private func status(_ state: PlaywrightBrowser.State) -> Text {
        switch state {
        case .stopped:
            Text("settings.playwright.status.stopped")
        case .starting:
            Text("settings.playwright.status.starting")
        case .running(let info):
            Text(verbatim: String(format: String(localized: "settings.playwright.status.running"),
                                  info.endpoint, info.executable.lastPathComponent))
        case .failed(let error):
            Text(verbatim: error.map(PlaywrightBrowser.message) ?? String(localized: "settings.playwright.status.stopped"))
                .foregroundStyle(theme[.statusStopped])
        }
    }
}
