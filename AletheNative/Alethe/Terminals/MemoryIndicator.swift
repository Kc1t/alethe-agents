import AletheDesign
import AletheModel
import SwiftUI

/// Toolbar memory indicator (upstream RAM indicator + `MemoryAnalyticsModal`): what the terminals
/// use, tinted by the system's memory pressure; the popover breaks it down per terminal and holds
/// the hibernation policy.
struct MemoryIndicator: View {
    var webTitleBar = false
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var showsDetails = false

    private var monitor: ResourceMonitor { environment.resources }

    var body: some View {
        Button { showsDetails.toggle() } label: {
            if webTitleBar {
                Text(verbatim: String(format: "%.0f MB", monitor.appMB + monitor.terminalsMB))
                    .font(metrics.monoFont(size: 11))
                    .monospacedDigit()
            } else {
                Label {
                    Text(verbatim: Self.format(monitor.terminalsMB))
                        .monospacedDigit()
                } icon: {
                    Image(systemName: "memorychip").webProfileSized(14)
                        .foregroundStyle(theme[monitor.pressure.token])
                }
                .labelStyle(.titleAndIcon)
            }
        }
        .help(Text("memory.indicator.help"))
        .accessibilityLabel(Text(String(format: String(localized: "memory.indicator.accessibility"), webTitleBar ? String(format: "%.0f MB", monitor.appMB + monitor.terminalsMB) : Self.format(monitor.terminalsMB))))
        .accessibilityIdentifier("memory.indicator")
        .popover(isPresented: $showsDetails, arrowEdge: .bottom) {
            MemoryDetails()
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
    }

    static func format(_ megabytes: Double) -> String {
        Measurement(value: megabytes, unit: UnitInformationStorage.megabytes)
            .formatted(.byteCount(style: .memory))
    }
}

private struct MemoryDetails: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var monitor: ResourceMonitor { environment.resources }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.space(.l)) {
            HStack {
                Circle().fill(theme[monitor.pressure.token]).frame(width: metrics.size(8), height: metrics.size(8))
                Text(monitor.pressure.title).font(metrics.font(.headline))
                Spacer()
                Text(verbatim: String(format: String(localized: "memory.available"),
                                      MemoryIndicator.format(monitor.system.availableMB),
                                      MemoryIndicator.format(monitor.system.totalMB)))
                    .font(metrics.font(.footnote))
                    .foregroundStyle(theme[.textSecondary])
            }
            Grid(alignment: .leading, horizontalSpacing: metrics.space(.l), verticalSpacing: metrics.space(.xs)) {
                GridRow {
                    Text("memory.terminals")
                    Text(verbatim: MemoryIndicator.format(monitor.terminalsMB)).monospacedDigit()
                }
                GridRow {
                    Text("memory.app")
                    Text(verbatim: MemoryIndicator.format(monitor.appMB)).monospacedDigit()
                }
            }
            .font(metrics.font(.body))
            Divider()
            if monitor.terminals.isEmpty {
                Text("memory.noTerminals").foregroundStyle(theme[.textTertiary])
            }
            ForEach(monitor.terminals.prefix(8)) { usage in
                HStack {
                    Text(verbatim: name(of: usage.tab)).lineLimit(1)
                    Spacer()
                    Text(verbatim: MemoryIndicator.format(usage.memoryMB))
                        .monospacedDigit()
                        .foregroundStyle(theme[.textSecondary])
                }
                .font(metrics.font(.footnote))
            }
            if !environment.terminals.hibernated.isEmpty {
                Label {
                    Text(String(format: String(localized: "memory.hibernatedCount"), environment.terminals.hibernated.count))
                } icon: {
                    Image(systemName: "moon.zzz").webProfileSized(14)
                }
                .font(metrics.font(.footnote))
                .foregroundStyle(theme[.textSecondary])
            }
            Divider()
            ResourcePolicyPicker()
            SettingsLink { Text("memory.settings") }
        }
        .padding(metrics.space(.xl))
        .frame(width: metrics.size(340))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.details")
    }

    private func name(of tab: TabID) -> String {
        guard let (project, pane) = environment.workspace?.document.paneHolding(tab),
              let item = pane.tabs.first(where: { $0.id == tab }) else { return tab.rawValue }
        return "\(item.title ?? AgentLabels.name(for: item.agent)) · \(project.name)"
    }
}

/// The hibernation policy, shared by the popover and Settings.
struct ResourcePolicyPicker: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface {
            WebSelectRow(title: "resources.mode", selection: binding(\.mode), options: ResourcePolicy.Mode.allCases) {
                $0.titleText
            }
            .accessibilityIdentifier("resources.mode")
        } else {
            nativePicker
        }
    }

    private var nativePicker: some View {
        Picker(selection: binding(\.mode)) {
            ForEach(ResourcePolicy.Mode.allCases, id: \.self) { mode in
                Text(mode.title).tag(mode)
            }
        } label: {
            Text("resources.mode")
        }
        .accessibilityIdentifier("resources.mode")
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<ResourcePolicy, Value>) -> Binding<Value> {
        Binding {
            (environment.preferences?.document.resources ?? ResourcePolicy())[keyPath: keyPath]
        } set: { value in
            environment.preferences?.update { preferences in
                var policy = preferences.resources
                policy[keyPath: keyPath] = value
                preferences.resourcePolicy = policy.normalized
            }
        }
    }
}

/// Settings › Resources: the policy and its idle limits.
struct ResourceSettings: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    private var policy: ResourcePolicy { environment.preferences?.document.resources ?? ResourcePolicy() }

    var body: some View {
        Form {
            Section {
                ResourcePolicyPicker()
                Text(policy.mode.detail)
                    .font(metrics.isWebInterface ? metrics.font(.footnote) : .footnote)
                    .foregroundStyle(metrics.isWebInterface ? theme[.textSecondary] : .secondary)
            }
            Section("resources.idleLimits") {
                Stepper(value: minutes(\.hiddenAgentIdleMinutes), in: ResourcePolicy.agentIdleRange, step: 5) {
                    Text(String(format: String(localized: "resources.agentIdle"), policy.hiddenAgentIdleMinutes))
                }
                .accessibilityIdentifier("resources.agentIdle")
                Stepper(value: minutes(\.hiddenShellIdleMinutes), in: ResourcePolicy.shellIdleRange, step: 5) {
                    Text(String(format: String(localized: "resources.shellIdle"), policy.hiddenShellIdleMinutes))
                }
                .accessibilityIdentifier("resources.shellIdle")
            }
            .disabled(policy.mode == .manual)
        }
        .formStyle(.grouped)
    }

    private func minutes(_ keyPath: WritableKeyPath<ResourcePolicy, Int>) -> Binding<Int> {
        Binding {
            policy[keyPath: keyPath]
        } set: { value in
            environment.preferences?.update { preferences in
                var next = preferences.resources
                next[keyPath: keyPath] = value
                preferences.resourcePolicy = next.normalized
            }
        }
    }
}

extension MemoryPressure {
    var token: ThemeToken {
        switch self {
        case .normal: .statusActive
        case .warning: .statusWaiting
        case .critical: .statusStopped
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .normal: "memory.pressure.normal"
        case .warning: "memory.pressure.warning"
        case .critical: "memory.pressure.critical"
        }
    }
}

extension ResourcePolicy.Mode {
    var title: LocalizedStringKey {
        switch self {
        case .manual: "resources.mode.manual"
        case .pressure: "resources.mode.pressure"
        case .idle: "resources.mode.idle"
        }
    }

    /// The title as plain text, for the web dropdown.
    var titleText: String {
        switch self {
        case .manual: String(localized: "resources.mode.manual")
        case .pressure: String(localized: "resources.mode.pressure")
        case .idle: String(localized: "resources.mode.idle")
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .manual: "resources.mode.manual.detail"
        case .pressure: "resources.mode.pressure.detail"
        case .idle: "resources.mode.idle.detail"
        }
    }
}
