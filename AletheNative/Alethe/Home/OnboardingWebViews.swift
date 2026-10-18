import AletheAgents
import AletheDesign
import AletheFoundation
import AletheIntegrations
import AletheModel
import AppKit
import SwiftUI

// Web OnboardingModal.module.css, onboarding/AgentsStep.module.css and onboarding/FeaturesStep.module.css,
// drawn only when `metrics.isWebInterface` is true.

/// Hover state for a view that cannot hold its own `@State` (button styles, row labels).
private struct OnboardingHover<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @State private var hovering = false

    var body: some View {
        content(hovering).onHover { hovering = $0 }
    }
}

// MARK: - Overlay

/// `.overlay` and `.content`: a fixed 640-point dialog over a 55% black backdrop. The web dialog ignores Escape and
/// outside clicks, so neither dismisses it; the sheet's own buttons close it.
struct OnboardingWebOverlay<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var visible = false

    var body: some View {
        GeometryReader { geometry in
            let maximumHeight = max(0, geometry.size.height - metrics.size(48))
            ZStack {
                Color.black.opacity(0.55)
                    .webModalBackdropMotion(visible: visible)
                    .contentShape(Rectangle())
                    .onTapGesture {}
                content()
                    .environment(\.newTerminalModalHeight, maximumHeight)
                    .frame(width: min(metrics.size(640), max(0, geometry.size.width - metrics.size(48))))
                    .frame(maxHeight: maximumHeight)
                    .shadow(color: theme.shadow(.lg).color.color, radius: metrics.size(40), y: metrics.size(16))
                    .webModalContentMotion(visible: visible)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .onAppear { visible = true }
        .accessibilityAddTraits(.isModal)
    }
}

// MARK: - Chrome

/// `.button`, `.buttonGhost`, `.buttonPrimary`: 30 points tall, 13-point padding, 12.5-point text.
struct OnboardingWebButtonStyle: ButtonStyle {
    enum Kind { case normal, ghost, primary }
    var kind: Kind = .normal

    func makeBody(configuration: Configuration) -> some View {
        ButtonBody(configuration: configuration, kind: kind)
    }

    private struct ButtonBody: View {
        let configuration: ButtonStyleConfiguration
        let kind: Kind
        @Environment(\.metrics) private var metrics
        @Environment(\.theme) private var theme
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: metrics.radius(.md))
            configuration.label
                .font(metrics.font(size: 12.5, weight: kind == .primary ? .medium : .regular))
                .foregroundStyle(foreground)
                .padding(.horizontal, metrics.size(13))
                .frame(height: metrics.size(30))
                .background(background, in: shape)
                .overlay(shape.strokeBorder(border, lineWidth: metrics.size(1)))
                .contentShape(shape)
                .opacity(enabled ? 1 : 0.5)
                .onHover { hovering = $0 && enabled }
        }

        private var foreground: Color {
            switch kind {
            case .normal: theme[.fg]
            case .ghost: theme[hovering ? .fg : .fgMuted]
            case .primary: theme[.accentOn]
            }
        }

        private var background: Color {
            switch kind {
            case .normal: theme[.surfaceCardDefault]
            case .ghost: .clear
            case .primary: theme[hovering ? .accentStrong : .accent]
            }
        }

        private var border: Color {
            switch kind {
            case .normal: theme[.border]
            case .ghost: .clear
            case .primary: theme[.accent]
            }
        }
    }
}

/// `.top`: brand mark, eyebrow, step dots and the language switch.
struct OnboardingWebHeader: View {
    let count: Int
    let current: Int
    let progressLabel: String
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var language = LanguageSetting().current()

    var body: some View {
        HStack(spacing: metrics.size(10)) {
            Group {
                if let icon = AppIcon.image(for: environment.preferences?.document.iconTheme ?? .default) {
                    Image(nsImage: icon).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                } else {
                    Image(systemName: "app")
                }
            }
            .frame(width: metrics.size(22), height: metrics.size(22))
            .accessibilityHidden(true)
            Text("onboarding.kicker")
                .textCase(.uppercase)
                .font(metrics.font(size: 10, weight: .bold))
                .tracking(metrics.size(0.9))
                .foregroundStyle(theme[.fgFaint])
            Spacer(minLength: 0)
            HStack(spacing: metrics.size(4)) {
                ForEach(0..<count, id: \.self) { position in
                    Capsule()
                        .fill(theme[position <= current ? .accent : .borderStrong])
                        .frame(width: metrics.size(17), height: metrics.size(3))
                }
            }
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: progressLabel))
            .accessibilityIdentifier("onboarding.progress")
            HStack(spacing: metrics.size(2)) {
                ForEach([AppLanguage.english, .portugueseBrazil], id: \.self) { option in
                    Button { language = option; LanguageSetting().set(option) } label: {
                        Text(verbatim: String(option.rawValue.prefix(2)).uppercased())
                            .font(metrics.font(size: 10.5))
                            .foregroundStyle(theme[language == option ? .fg : .fgFaint])
                            .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(2))
                            .background(language == option ? theme[.surfaceCardDefault] : .clear,
                                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("onboarding.language.\(option.rawValue)")
                }
            }
        }
        .padding(.horizontal, metrics.size(18)).padding(.vertical, metrics.size(12))
        .background(theme[.bgSunken])
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
    }
}

/// `.stepIntro` / AgentsStep `.intro`: an 18-point title over a 12.5-point muted line.
struct OnboardingWebIntro: View {
    let title: LocalizedStringKey
    let subtitle: Text
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(5)) {
            Text(title).font(metrics.font(size: 18, weight: .semibold)).tracking(metrics.size(-0.27))
            subtitle.font(metrics.font(size: 12.5)).foregroundStyle(theme[.fgMuted])
                .lineSpacing(metrics.size(4)).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Profile step

/// Step 0: avatar, question, name, photo field and the GitHub avatar shortcut.
struct OnboardingWebProfileStep: View {
    @Binding var name: String
    @Binding var photo: String
    let nameError: String?
    var focus: FocusState<Bool>.Binding
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var showsPhoto = false
    @State private var showsGithub = false
    @State private var handle = ""
    @FocusState private var handleFocused: Bool

    private var initial: String {
        name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
    }

    var body: some View {
        VStack(spacing: 0) {
            avatar
            Text("onboarding.web.photoHint")
                .font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
                .padding(.top, metrics.size(9))
            Text("onboarding.web.profileTitle")
                .font(metrics.font(size: 19, weight: .semibold)).tracking(metrics.size(-0.285))
                .padding(.top, metrics.size(18)).padding(.bottom, metrics.size(6))
            Text("onboarding.web.profileSubtitle")
                .font(metrics.font(size: 12.5)).foregroundStyle(theme[.fgMuted])
                .lineSpacing(metrics.size(4)).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, metrics.size(18))
            nameField
            if let nameError {
                Text(verbatim: nameError)
                    .font(metrics.font(size: 10.5)).foregroundStyle(theme[.statusStopped])
                    .padding(.top, metrics.size(6))
                    .accessibilityIdentifier("onboarding.name.error")
            }
            if showsPhoto {
                ImageInputField(value: $photo, name: name, color: nil,
                                label: "settings.web.reference.prefs.photoPlaceholder",
                                placeholder: "onboarding.web.photoUrlPlaceholder",
                                hint: "settings.web.reference.image.urlOrUpload")
                    .frame(maxWidth: metrics.size(290), alignment: .leading)
                    .padding(.top, metrics.size(14))
            }
            divider
            if showsGithub { githubRow } else { githubButton }
            Text("onboarding.web.localNote")
                .font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
                .lineSpacing(metrics.size(4)).multilineTextAlignment(.center)
                .frame(maxWidth: metrics.size(300))
                .padding(.top, metrics.size(10))
        }
        .frame(maxWidth: .infinity)
    }

    private var avatar: some View {
        OnboardingHover { hovering in
            Button { showsPhoto.toggle() } label: {
                SidebarCoverImage(source: photo.trimmingCharacters(in: .whitespacesAndNewlines),
                                  side: 76, cornerRadius: 38) {
                    if photo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Image("DefaultProfile").resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Text(verbatim: initial)
                            .font(metrics.font(size: 27, weight: .semibold)).foregroundStyle(theme[.fgMuted])
                    }
                }
                .background(theme[.surfaceCardDefault], in: Circle())
                .overlay {
                    Text("onboarding.web.photoChange")
                        .font(metrics.font(size: 10.5, weight: .medium)).foregroundStyle(theme[.fg])
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.black.opacity(0.72))
                        .opacity(hovering ? 1 : 0)
                        .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: hovering)
                }
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(theme[hovering ? .accentBorder : .borderStrong],
                                               lineWidth: metrics.size(1)))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .accessibilityLabel(Text("onboarding.web.photoTitle"))
        .accessibilityIdentifier("onboarding.photo")
        .webAvatarIn()
    }

    private var nameField: some View {
        OnboardingHover { hovering in
            TextField(text: $name, prompt: Text("onboarding.web.namePlaceholder")
                .foregroundStyle(theme[.textQuaternary])) { Text("onboarding.web.name") }
                .textFieldStyle(.plain)
                .font(metrics.font(size: 16, weight: .medium))
                .foregroundStyle(theme[.fg])
                .multilineTextAlignment(.center)
                .focused(focus)
                .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(11))
                .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[focus.wrappedValue ? .accentBorder : hovering ? .borderStrong : .border],
                                  lineWidth: metrics.size(1)))
                .onChange(of: name) { _, value in
                    if value.count > 60 { name = String(value.prefix(60)) }
                }
        }
        .frame(maxWidth: metrics.size(290))
        .accessibilityIdentifier("onboarding.name")
    }

    private var divider: some View {
        HStack(spacing: metrics.size(12)) {
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
            Text("onboarding.web.orImportFrom").fixedSize()
            Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
        }
        .font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
        .frame(maxWidth: metrics.size(290))
        .padding(.top, metrics.size(22)).padding(.bottom, metrics.size(13))
    }

    private var githubButton: some View {
        OnboardingHover { hovering in
            Button { showsGithub = true; handleFocused = true } label: {
                HStack(spacing: metrics.size(10)) {
                    Image(systemName: "person.crop.circle").font(metrics.font(size: 16))
                    Text("onboarding.web.githubImport").font(metrics.font(size: 13))
                }
                .foregroundStyle(theme[.fg])
                .frame(maxWidth: .infinity).padding(metrics.size(11))
                .background(theme[hovering ? .panelHover : .surfaceCardDefault],
                            in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[hovering ? .borderStrong : .border], lineWidth: metrics.size(1)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: metrics.size(290))
        .accessibilityIdentifier("onboarding.github")
    }

    private var githubRow: some View {
        HStack(spacing: metrics.size(8)) {
            TextField(text: $handle, prompt: Text("onboarding.web.githubHandlePlaceholder")
                .foregroundStyle(theme[.fgFaint])) { Text("onboarding.web.githubHandlePlaceholder") }
                .textFieldStyle(.plain)
                .font(metrics.font(size: 12.5)).foregroundStyle(theme[.fg])
                .focused($handleFocused)
                .padding(.horizontal, metrics.size(11)).padding(.vertical, metrics.size(9))
                .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                    .strokeBorder(theme[handleFocused ? .accentBorder : .border], lineWidth: metrics.size(1)))
                .onSubmit(apply)
                .accessibilityIdentifier("onboarding.github.handle")
            OnboardingHover { hovering in
                Button(action: apply) {
                    Text("onboarding.web.githubUse").font(metrics.font(size: 12.5)).foregroundStyle(theme[.fg])
                        .padding(.horizontal, metrics.size(13)).padding(.vertical, metrics.size(9))
                        .background(theme[hovering ? .panelHover : .surfaceCardDefault],
                                    in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                            .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .accessibilityIdentifier("onboarding.github.use")
        }
        .frame(maxWidth: metrics.size(290))
    }

    /// `applyGithubHandle`: the handle's public avatar becomes the photo link and, when empty, the name.
    private func apply() {
        var value = handle.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("@") { value.removeFirst() }
        guard !value.isEmpty, value.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." })
        else { return }
        photo = "https://github.com/\(value).png"
        if name.trimmingCharacters(in: .whitespaces).isEmpty { name = value }
        showsGithub = false
    }
}

// MARK: - Agents step

/// Agents step: a three-column grid of cards (`AgentsStep.module.css`).
struct OnboardingWebAgentsStep: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var scan = 0

    private var agents: [AgentDescriptor] { AgentRegistry.builtin.descriptors.filter { !$0.isShell } }
    private var preferences: PreferencesDocument? { environment.preferences?.document }

    private func path(_ agent: AgentDescriptor) -> String? {
        agent.cliCommand.flatMap { environment.launchers.resolve($0, override: preferences?.cliPaths?[agent.kind.rawValue]) }
    }

    private func isEnabled(_ agent: AgentDescriptor) -> Bool {
        AgentRegistry.builtin.enabledKinds(preferences?.enabledAgents).contains(agent.kind)
    }

    var body: some View {
        let detected = agents.filter { path($0) != nil }.count
        let active = agents.filter { path($0) != nil && isEnabled($0) }.count
        VStack(alignment: .leading, spacing: metrics.size(16)) {
            OnboardingWebIntro(title: "onboarding.web.agentsTitle",
                               subtitle: Text(verbatim: format("onboarding.web.agentsFound", detected)))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: metrics.size(10)), count: 3),
                      spacing: metrics.size(10)) {
                ForEach(agents) { agent in
                    OnboardingWebAgentCard(agent: agent, path: path(agent), enabled: isEnabled(agent)) { on in
                        environment.preferences?.update {
                            $0.enabledAgents = AgentRegistry.builtin.enabled($0.enabledAgents, setting: agent.kind, on: on)
                        }
                    }
                }
            }
            .id(scan)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("onboarding.agents")
            HStack(spacing: metrics.size(10)) {
                Text(verbatim: format("onboarding.web.agentsEnabledOf", active, agents.count))
                    .frame(maxWidth: .infinity, alignment: .leading)
                OnboardingHover { hovering in
                    Button {
                        environment.launchers.invalidate()
                        scan += 1
                    } label: {
                        Text("onboarding.web.agentsRescan")
                            .foregroundStyle(theme[hovering ? .fg : .fgMuted])
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
                            }
                    }
                    .buttonStyle(.plain)
                }
                .accessibilityIdentifier("onboarding.agents.rescan")
            }
            .font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgFaint])
        }
    }
}

private struct OnboardingWebAgentCard: View {
    let agent: AgentDescriptor
    let path: String?
    let enabled: Bool
    let toggle: (Bool) -> Void
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var version: String?
    @State private var latest: String?
    @State private var probing = false
    @State private var sheet: AgentInstallSheet.Mode?

    private var installed: Bool { path != nil }
    private var on: Bool { installed && enabled }
    private var outdated: Bool {
        guard let version, let latest else { return false }
        return AgentVersions.isOutdated(version, latest: latest)
            && AgentInstallCatalog.npmPackage(for: agent.kind) != nil
    }

    var body: some View {
        OnboardingHover { hovering in
            VStack(spacing: metrics.size(8)) {
                AgentLogo(agent: agent.kind.rawValue, size: 26)
                    .frame(height: metrics.size(26))
                Text(verbatim: agent.displayName)
                    .font(metrics.font(size: 12.5)).lineLimit(1).foregroundStyle(theme[.fg])
                state
                if outdated {
                    Button("agentInstall.updateEllipsis") { sheet = .update }
                        .buttonStyle(OnboardingWebButtonStyle(kind: .normal))
                        .controlSize(.small)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, metrics.size(16)).padding(.horizontal, metrics.size(10)).padding(.bottom, metrics.size(13))
            .background(theme[on ? .surfaceCardSelected : .surfaceCardDefault],
                        in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
                .strokeBorder(theme[on ? .accentBorder : hovering && installed ? .borderStrong : .border],
                              lineWidth: metrics.size(1)))
            .overlay(alignment: .topTrailing) {
                Image(systemName: "checkmark").font(metrics.font(size: 10, weight: .bold))
                    .foregroundStyle(theme[.accentOn])
                    .frame(width: metrics.size(16), height: metrics.size(16))
                    .background(theme[.accent], in: Circle())
                    .padding(.top, metrics.size(7)).padding(.trailing, metrics.size(8))
                    .opacity(on ? 1 : 0)
            }
            .opacity(installed ? 1 : 0.45)
            .contentShape(RoundedRectangle(cornerRadius: metrics.radius(.lg)))
            .onTapGesture { if installed { toggle(!on) } }
            .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: on)
        }
        .help(path ?? String(localized: "onboarding.web.agentNotFoundPath"))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("onboarding.agent.\(agent.kind.rawValue)")
        .task(id: path) { await probe() }
        .gitWebSheet(item: $sheet, width: 480, onDismiss: { environment.launchers.invalidate(); Task { await probe() } }) { mode in
            AgentInstallSheet(agent: agent, mode: mode)
                .environment(environment)
                .environment(\.theme, theme)
                .environment(\.metrics, metrics)
        }
    }

    @ViewBuilder
    private var state: some View {
        if installed {
            Text(verbatim: probing ? String(localized: "onboarding.web.agentChecking")
                 : version.map { "v\($0)" } ?? String(localized: "onboarding.web.agentReady"))
                .font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
        } else if AgentInstallCatalog.entries[agent.kind] != nil {
            Button("agentInstall.installEllipsis") { sheet = .install }
                .buttonStyle(OnboardingWebButtonStyle(kind: .normal))
                .disabled(environment.installer.isBusy)
                .accessibilityIdentifier("onboarding.agent.install.\(agent.kind.rawValue)")
        } else {
            Text("onboarding.web.agentNotFoundPath").font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
        }
    }

    private func probe() async {
        version = nil
        guard let path else { return }
        probing = true
        version = await CLIVersion.probe(path)
        probing = false
        latest = await AgentVersions.latest(for: agent.kind)
    }
}

// MARK: - Features step

/// Features step: search, grouped switch rows and the "show more" fold (`FeaturesStep.module.css`).
struct OnboardingWebFeaturesStep: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var term = ""
    @State private var expanded = false
    @FocusState private var searchFocused: Bool

    private enum Group: CaseIterable { case workspace, agents, others }

    private func group(of feature: Feature) -> Group {
        switch feature {
        case .browser, .prs: .workspace
        case .mcp, .playwright, .orchestrator, .gsdSync: .agents
        case .graphify, .aiMemory: .others
        }
    }

    private func icon(_ feature: Feature) -> String {
        switch feature {
        case .browser: "macwindow"
        case .mcp: "powerplug"
        case .playwright: "cursorarrow.click.2"
        case .orchestrator: "point.3.connected.trianglepath.dotted"
        case .graphify: "point.3.filled.connected.trianglepath.dotted"
        case .aiMemory: "brain"
        case .gsdSync: "sparkles"
        case .prs: "arrow.triangle.pull"
        }
    }

    private func folded(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
    }

    private func matches(_ feature: Feature, _ needle: String) -> Bool {
        needle.isEmpty || folded([
            String(localized: String.LocalizationValue("features.\(feature.rawValue).title")),
            String(localized: String.LocalizationValue("features.\(feature.rawValue).detail")),
            feature.rawValue,
        ].joined(separator: " ")).contains(needle)
    }

    private func isOn(_ feature: Feature) -> Bool { environment.features.isOn(feature) }

    private func toggle(_ feature: Feature) {
        let on = !isOn(feature)
        environment.preferences?.update { $0.features.set(feature, on: on) }
        if feature == .playwright, !on { Task { await environment.playwright.stop() } }
    }

    var body: some View {
        let needle = folded(term.trimmingCharacters(in: .whitespaces))
        let searching = !needle.isEmpty
        let visible = Feature.allCases.filter { matches($0, needle) }
        VStack(alignment: .leading, spacing: 0) {
            OnboardingWebIntro(title: "onboarding.web.featuresTitle", subtitle: Text("onboarding.web.featuresSubtitle"))
                .padding(.bottom, metrics.size(16))
            search
            ForEach(Group.allCases, id: \.self) { group in
                let rows = visible.filter { self.group(of: $0) == group }
                if !(group == .others && !searching && !expanded), !rows.isEmpty {
                    section(group, rows)
                }
            }
            if visible.isEmpty {
                Text("onboarding.web.featuresNoMatch")
                    .font(metrics.font(size: 12)).foregroundStyle(theme[.fgFaint])
                    .frame(maxWidth: .infinity).padding(.vertical, metrics.size(26))
            }
            if !searching, !expanded {
                OnboardingHover { hovering in
                    Button { expanded = true } label: {
                        HStack(spacing: metrics.size(9)) {
                            Text(verbatim: format("onboarding.web.featuresShowMore", Feature.allCases.filter(\.isSecondary).count))
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down").font(metrics.font(size: 13))
                        }
                        .font(metrics.font(size: 11.5)).foregroundStyle(theme[hovering ? .fg : .fgFaint])
                        .padding(.top, metrics.size(9))
                        .overlay(alignment: .top) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .accessibilityIdentifier("onboarding.features.more")
            }
        }
    }

    private var search: some View {
        HStack(spacing: metrics.size(9)) {
            Image(systemName: "magnifyingglass").font(metrics.font(size: 14))
            TextField(text: $term, prompt: Text("onboarding.web.featuresSearch")
                .foregroundStyle(theme[.fgFaint])) { Text("onboarding.web.featuresSearch") }
                .textFieldStyle(.plain)
                .font(metrics.font(size: 12.5)).foregroundStyle(theme[.fg])
                .focused($searchFocused)
                .accessibilityIdentifier("onboarding.features.search")
            if !term.isEmpty {
                Button { term = "" } label: { Image(systemName: "xmark").font(metrics.font(size: 12)) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("onboarding.web.featuresClearSearch"))
            }
        }
        .foregroundStyle(theme[.fgFaint])
        .padding(.horizontal, metrics.size(11))
        .frame(height: metrics.size(30))
        .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
            .strokeBorder(theme[searchFocused ? .accentBorder : .border], lineWidth: metrics.size(1)))
        .padding(.bottom, metrics.size(20))
    }

    private func section(_ group: Group, _ rows: [Feature]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(group == .workspace ? "onboarding.web.featuresGroupWorkspace"
                 : group == .agents ? "onboarding.web.featuresGroupAgents" : "onboarding.web.featuresGroupOthers")
                .textCase(.uppercase)
                .font(metrics.font(size: 10, weight: .bold)).tracking(metrics.size(1))
                .foregroundStyle(theme[.fgFaint])
                .padding(.bottom, metrics.size(8))
            ForEach(Array(rows.enumerated()), id: \.element) { index, feature in
                row(feature, first: index == 0)
                if feature == .playwright, isOn(.playwright) { playwrightMode }
            }
        }
        .padding(.bottom, metrics.size(20))
    }

    private func row(_ feature: Feature, first: Bool) -> some View {
        let on = isOn(feature)
        return Button { toggle(feature) } label: {
            HStack(spacing: metrics.size(12)) {
                Image(systemName: icon(feature)).font(metrics.font(size: 15))
                    .foregroundStyle(theme[on ? .fg : .fgMuted])
                    .frame(width: metrics.size(28), height: metrics.size(28))
                    .background(theme[.surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[on ? .borderStrong : .border], lineWidth: metrics.size(1)))
                VStack(alignment: .leading, spacing: metrics.size(3)) {
                    HStack(spacing: metrics.size(7)) {
                        Text(feature.title).font(metrics.font(size: 12.5))
                        if feature == .orchestrator {
                            Text("onboarding.web.featuresExperimental")
                                .font(metrics.font(size: 9.5)).foregroundStyle(theme[.statusWaiting])
                                .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                                .overlay(Capsule().strokeBorder(theme[.statusWaiting], lineWidth: metrics.size(1)))
                        }
                    }
                    Text(feature.detail).font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint])
                        .lineSpacing(metrics.size(2)).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                track(on)
            }
            .foregroundStyle(theme[.fg])
            .padding(.vertical, metrics.size(10))
            .overlay(alignment: .top) {
                if !first { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("settings.feature.\(feature.rawValue)")
    }

    private func track(_ on: Bool) -> some View {
        Capsule()
            .fill(theme[on ? .accentSoft : .bgSunken])
            .frame(width: metrics.size(32), height: metrics.size(19))
            .overlay(Capsule().strokeBorder(theme[on ? .accentBorder : .borderStrong], lineWidth: metrics.size(1)))
            .overlay(alignment: .leading) {
                Circle().fill(theme[on ? .accent : .fgFaint])
                    .frame(width: metrics.size(13), height: metrics.size(13))
                    .padding(.leading, metrics.size(on ? 15 : 2))
            }
            .animation(metrics.reducesMotion ? nil : .easeOut(duration: 0.12), value: on)
            .accessibilityHidden(true)
    }

    private var playwrightMode: some View {
        let mode = environment.preferences?.document.playwrightBrowserMode.flatMap(PlaywrightBrowserMode.init(rawValue:)) ?? .shared
        return HStack(spacing: metrics.size(12)) {
            Image(systemName: "macwindow").font(metrics.font(size: 13)).foregroundStyle(theme[.fgFaint])
                .frame(width: metrics.size(28))
            VStack(alignment: .leading, spacing: metrics.size(2)) {
                Text("settings.playwright.mode").font(metrics.font(size: 11.5)).foregroundStyle(theme[.fgMuted])
                Text(mode == .shared ? "settings.playwright.mode.shared.hint" : "settings.playwright.mode.dedicated.hint")
                    .font(metrics.font(size: 10.5)).foregroundStyle(theme[.fgFaint])
                    .lineSpacing(metrics.size(2)).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: metrics.size(2)) {
                ForEach([PlaywrightBrowserMode.shared, .dedicated], id: \.self) { option in
                    Button {
                        environment.preferences?.update { $0.playwrightBrowserMode = option == .shared ? nil : option.rawValue }
                    } label: {
                        Text(option == .shared ? "settings.playwright.mode.shared" : "settings.playwright.mode.dedicated")
                            .font(metrics.font(size: 11))
                            .foregroundStyle(theme[mode == option ? .fg : .fgMuted])
                            .padding(.horizontal, metrics.size(9)).padding(.vertical, metrics.size(3))
                            .background(mode == option ? theme[.panelHover] : .clear,
                                        in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("onboarding.playwright.\(option.rawValue)")
                }
            }
            .padding(metrics.size(2))
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        }
        .padding(.vertical, metrics.size(8))
        .overlay(alignment: .top) {
            Path { path in
                path.move(to: .zero)
                path.addLine(to: CGPoint(x: 10_000, y: 0))
            }
            .stroke(theme[.border], style: StrokeStyle(lineWidth: metrics.size(1), dash: [metrics.size(3), metrics.size(3)]))
            .frame(height: metrics.size(1))
        }
    }
}
