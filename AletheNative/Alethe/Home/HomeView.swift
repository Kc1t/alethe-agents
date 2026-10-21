import AletheAgents
import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// Home (upstream `HomeView`): greeting, quick launch, recent projects and actions, usage, activity,
/// time analytics and notifications — real data only. ⇧⌘H switches between Home and the workspace.
struct HomeView: View {
    let workspace: WorkspaceModel
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @State private var appeared = false
    @State private var activityDays: [ActivityDays.Day] = []

    var body: some View {
        GeometryReader { geometry in
        ScrollView {
            VStack(alignment: .leading, spacing: metrics.size(24)) {
                if metrics.isWebInterface {
                    VStack(spacing: metrics.size(18)) {
                        HomeHero(
                            streak: ActivityDays.streak(activityDays),
                            availableWidth: min(metrics.size(940), geometry.size.width - 2 * min(
                                metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03)))
                                - (geometry.size.width - 2 * min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03)) <= metrics.size(620) ? 0 : metrics.size(36)))
                        QuickLaunch(workspace: workspace, compactToolbar: geometry.size.width
                                    - 2 * min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03))
                                    <= metrics.size(620))
                        HStack(spacing: metrics.size(8)) {
                            Button { environment.editorRequest = .newTerminal(nil) } label: {
                                Label { Text(metrics.isWebInterface ? "home.web.newTerminal" : "home.action.newTerminal") } icon: { Image(systemName: "terminal").webProfileSized(14) }
                            }
                            Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                                Label { Text(metrics.isWebInterface ? "home.web.newProject" : "home.action.newProject") } icon: { Image(systemName: "folder.badge.plus").webProfileSized(14) }
                            }
                        }
                        .buttonStyle(HomeHeroActionStyle())
                    }
                    .padding(.horizontal, geometry.size.width - 2 * min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03)) <= metrics.size(620) ? 0 : metrics.size(18))
                    .padding(.top, metrics.size(28))
                    .padding(.bottom, metrics.size(42))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: geometry.size.width - 2 * min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03)) <= metrics.size(900)
                           ? metrics.size(430)
                           : min(metrics.size(610), max(metrics.size(430), geometry.size.height * 0.56)))
                    .entrance(appeared, step: 0, reduced: metrics.reducesMotion || (metrics.isWebInterface && metrics.style == .clean), rise: metrics.size(8))
                    WebHomeSetup(workspace: workspace)
                } else {
                    VStack(alignment: .leading, spacing: metrics.space(.xxl)) {
                        Spacer(minLength: metrics.size(28))
                        HomeHero(streak: ActivityDays.streak(activityDays))
                            .frame(maxWidth: .infinity)
                        QuickLaunch(workspace: workspace)
                            .frame(maxWidth: .infinity)
                        HStack(spacing: metrics.space(.xl)) {
                            Button { environment.editorRequest = .newTerminal(nil) } label: {
                                Label { Text(metrics.isWebInterface ? "home.web.newTerminal" : "home.action.newTerminal") } icon: { Image(systemName: "terminal").webProfileSized(14) }
                            }
                            Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                                Label { Text(metrics.isWebInterface ? "home.web.newProject" : "home.action.newProject") } icon: { Image(systemName: "folder.badge.plus").webProfileSized(14) }
                            }
                        }
                        .buttonStyle(.link)
                        .font(metrics.font(.footnote))
                        .frame(maxWidth: .infinity)
                        Spacer(minLength: metrics.size(42))
                        SetupWalkthroughView(workspace: workspace)
                    }
                    .frame(minHeight: metrics.size(430))
                    .entrance(appeared, step: 0, reduced: metrics.reducesMotion, rise: metrics.size(8))
                }
                (metrics.isWebInterface
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: metrics.size(20)))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: metrics.space(.xxl)))) {
                    if metrics.isWebInterface {
                        WebHomeOverview(workspace: workspace)
                    } else {
                        RecentProjects(workspace: workspace)
                        HomeActions().frame(width: metrics.size(240))
                    }
                }
                .entrance(appeared, step: 1, reduced: metrics.reducesMotion || (metrics.isWebInterface && metrics.style == .clean), rise: metrics.size(8))
                VStack(alignment: .leading, spacing: metrics.size(24)) {
                    if metrics.isWebInterface {
                        UsageStrip(homeActivityDays: $activityDays, webContainerWidth: geometry.size.width
                                   - 2 * min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03)))
                    }
                    else {
                        UsageStrip()
                        ActivityGraph(days: $activityDays)
                    }
                    TimeAnalytics()
                    if metrics.isWebInterface { HomeWebNotifications() }
                    else {
                        NotificationList(isHome: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .aletheCard()
                    }
                    HomeFooter()
                }
                .entrance(appeared, step: 2, reduced: metrics.reducesMotion || (metrics.isWebInterface && metrics.style == .clean), rise: metrics.size(8))
            }
            .frame(maxWidth: metrics.size(940), alignment: .leading)
            .padding(.horizontal, metrics.isWebInterface
                     ? min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03))
                     : metrics.size(28))
            .padding(.bottom, metrics.size(18))
            .frame(maxWidth: .infinity)
            .background(alignment: .top) {
                if metrics.isWebInterface {
                    HomeBackdrop()
                        .frame(height: geometry.size.width - 2 * min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03)) <= metrics.size(900)
                               ? metrics.size(620)
                               : min(metrics.size(780), max(metrics.size(560), geometry.size.height * 0.72)))
                }
            }
        }
        .background(theme[.bg])
        .onAppear { appeared = true }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home")
        }
    }
}

// MARK: - Shared pieces

extension View {
    /// Home's staggered entrance: three steps at most, none under reduced motion.
    func entrance(_ appeared: Bool, step: Int, reduced: Bool, rise: CGFloat) -> some View {
        opacity(appeared || reduced ? 1 : 0)
            .offset(y: appeared || reduced ? 0 : rise)
            .animation(reduced ? nil : .easeOut(duration: 0.28).delay(Double(step) * 0.06), value: appeared)
    }

}

struct HomeSectionHeader: View {
    let title: LocalizedStringKey
    var count: Int?
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        HStack(spacing: metrics.size(metrics.isWebInterface ? 10 : 6)) {
            if metrics.isWebInterface {
                Text(title).textCase(.uppercase)
                    .font(metrics.font(size: 11, weight: .medium))
                    .tracking(metrics.size(1.4)).foregroundStyle(theme[.textTertiary])
                if let count {
                    Text(verbatim: "\(count)").font(metrics.monoFont(size: 10))
                        .foregroundStyle(theme[.textTertiary])
                        .padding(.horizontal, metrics.size(6)).padding(.vertical, metrics.size(1))
                        .background(theme[.bgElevated], in: Capsule())
                        .overlay(Capsule().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                }
            } else {
                AletheSectionLabel(Text(title), tracking: 1.4, color: .textTertiary)
                if let count { AletheCountPill(count, monospaced: true) }
            }
        }
        .accessibilityAddTraits(.isHeader)
    }
}

enum HomeFormat {
    static func duration(ms: UInt64) -> String {
        let minutes = Int((Double(ms) / 60_000).rounded())
        let units: Set<Duration.UnitsFormatStyle.Unit> = minutes < 60 ? [.minutes] : [.hours, .minutes]
        return Duration.seconds(minutes * 60).formatted(.units(allowed: units, width: .narrow))
    }
}

// MARK: - Hero

private struct HomeHero: View {
    @AppStorage("sidebar.web.avatarImages") private var avatarImages = "{}"
    let streak: Int
    var availableWidth: CGFloat = .infinity
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        TimelineView(.everyMinute) { context in
            VStack(spacing: metrics.size(7)) {
                if metrics.isWebInterface {
                    avatar
                        .frame(width: metrics.size(116), height: metrics.size(46))
                        .overlay(alignment: .center) {
                            WebHomeNowPlaying(homeDockInfoWidth: min(metrics.size(126), max(0, availableWidth / 2 - metrics.size(69))))
                                .fixedSize()
                                .frame(width: 0, alignment: .leading)
                                .offset(x: metrics.size(21))
                        }
                        .padding(.bottom, metrics.size(4))
                } else { ViewThatFits(in: .horizontal) {
                    HStack(spacing: metrics.space(.xl)) {
                        avatar
                        NowPlayingCard()
                    }
                    VStack(spacing: metrics.space(.m)) {
                        avatar
                        NowPlayingCard()
                    }
                }
                }
                Text(verbatim: "\(greeting(context.date)), \(metrics.isWebInterface ? firstName.lowercased() : firstName).")
                    .font(metrics.font(size: metrics.isWebInterface
                                       ? max(25, min(34, (NSApp.keyWindow?.frame.width ?? availableWidth) / metrics.scale * 0.03))
                                       : 34, weight: .medium))
                    .tracking(metrics.isWebInterface ? -metrics.size(0.34) : 0)
                    .minimumScaleFactor(25.0 / 34.0)
                    .lineLimit(1)
                    .foregroundStyle(theme[.textPrimary])
                Group {
                    if metrics.isWebInterface { Text(verbatim: webDate(context.date)) }
                    else { Text(context.date, format: .dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute()) }
                }
                    .font(metrics.font(size: metrics.isWebInterface ? 13 : 11, weight: .medium))
                    .foregroundStyle(theme[.fg])
                    .padding(.vertical, metrics.size(3))
                    .padding(.horizontal, metrics.size(8))
                    .background(theme[.bg].opacity(metrics.isWebInterface ? 0.52 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.greeting")
    }

    private var profileImage: Image {
        let avatars = (try? JSONDecoder().decode([String: String].self, from: Data(avatarImages.utf8))) ?? [:]
        if let encoded = avatars[environment.profileID?.rawValue ?? "default"],
           let data = Data(base64Encoded: encoded), let image = NSImage(data: data) {
            return Image(nsImage: image)
        }
        return Image("DefaultProfile")
    }

    private func webDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.dateFormat = "EEE, d MMM · HH:mm"
        return formatter.string(from: date).replacingOccurrences(of: ".", with: "").lowercased()
    }

    private var firstName: String {
        let profile = environment.activeProfileName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !profile.isEmpty { return metrics.isWebInterface ? String(profile.split(separator: " ").first ?? Substring(profile)) : profile }
        return NSFullUserName().split(separator: " ").first.map(String.init) ?? NSUserName()
    }

    @ViewBuilder private var avatar: some View {
        if metrics.isWebInterface {
            profileImage
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: metrics.size(44), height: metrics.size(44))
                .clipShape(Circle())
                .background(theme[.bgSunken].opacity(0.82), in: Circle())
                .overlay(Circle().strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                .overlay(alignment: .leading) {
                    Text(verbatim: "\(streak)")
                        .font(metrics.monoFont(size: 11, weight: .semibold))
                        .foregroundStyle(theme[.fg])
                        .frame(width: metrics.size(30), height: metrics.size(30))
                        .background(theme[.bgSunken], in: Circle())
                        .overlay(Circle().strokeBorder(theme[.statusWaiting], lineWidth: metrics.size(1)))
                        .overlay(alignment: .top) {
                            Image(systemName: "flame").webProfileSized(11)
                                .font(metrics.font(size: 11))
                                .foregroundStyle(theme[.statusWaiting])
                                .frame(width: metrics.size(17), height: metrics.size(14))
                                .background(theme[.bgSunken], in: Capsule())
                                .offset(y: -metrics.size(6))
                        }
                        .offset(x: -metrics.size(31), y: -metrics.size(1))
                        .help(Text(String(format: String(localized: "home.activity.streak"), streak)))
                        .accessibilityLabel(Text(String(format: String(localized: "home.activity.streak"), streak)))
                }
        } else {
            Text(verbatim: String(firstName.prefix(1)).uppercased())
                .font(metrics.font(size: metrics.isWebInterface ? 16 : 28, weight: .medium))
                .foregroundStyle(theme[.accent])
                .frame(width: metrics.size(metrics.isWebInterface ? 44 : 64), height: metrics.size(metrics.isWebInterface ? 44 : 64))
                .background(theme[.bgSunken], in: Circle())
                .overlay(alignment: metrics.isWebInterface ? .leading : .bottomTrailing) {
                    Label { Text(verbatim: "\(streak)") } icon: { Image(systemName: "flame.fill").webProfileSized(14) }
                        .font(metrics.font(.caption))
                        .padding(metrics.space(.xs))
                        .background(theme[.panel], in: Capsule())
                        .offset(x: metrics.isWebInterface ? -metrics.size(30) : 0)
                        .accessibilityLabel(Text(String(format: String(localized: "home.activity.streak"), streak)))
                }
        }
    }

    private func greeting(_ date: Date) -> String {
        switch Greeting(hour: Calendar.current.component(.hour, from: date)) {
        case .morning: String(localized: "home.greeting.morning")
        case .afternoon: String(localized: "home.greeting.afternoon")
        case .evening: String(localized: "home.greeting.evening")
        }
    }
}

// MARK: - Quick launch

/// The mini-terminal (upstream quick launch): a prompt, the agent, the project and the permission
/// mode; sending opens a new terminal of that agent in the project with the prompt as its first input.
private struct QuickLaunch: View {
    let workspace: WorkspaceModel
    var compactToolbar = false
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    @Environment(\.undoManager) private var undoManager
    @State private var prompt = ""
    @State private var agent: AgentKind = .claude
    @State private var workingDirectory: String?
    @State private var unrestricted = false
    @FocusState private var focused: Bool

    private var agents: [AgentKind] {
        let enabled = AgentRegistry.builtin.enabledKinds(environment.preferences?.document.enabledAgents)
        if metrics.isWebInterface {
            return [AgentKind.claude, .codex, .copilot, .cursor, .antigravity, .opencode]
                .filter { enabled.contains($0) }
        }
        return enabled.filter { $0 != .shell }
    }
    private var project: Project? {
        workspace.document.recentProjectIDs(limit: 1).first.flatMap(workspace.document.project)
    }
    private var descriptor: AgentDescriptor? { AgentRegistry.builtin.descriptor(for: agent) }

    private func webAgentName(_ kind: AgentKind) -> String {
        kind == .claude ? "Claude" : AgentLabels.name(for: kind.rawValue)
    }

    private func compactWebPath(_ path: String) -> String {
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        guard parts.count > 4 else { return path }
        let separator = path.contains("\\") ? "\\" : "/"
        return (path.hasPrefix("~") ? "~" + separator : "") + "…" + separator
            + parts.suffix(3).joined(separator: separator)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(4)) {
            HStack(spacing: metrics.size(6)) {
                AletheStatusDot(.statusOffline, side: 7)
                AletheStatusDot(.statusWaiting, side: 7)
                AletheStatusDot(.statusWorking, side: 7)
                Text("home.quick.title")
                    .font(metrics.monoFont(size: 9))
                    .foregroundStyle(theme[metrics.isWebInterface ? .fg : .textTertiary])
                    .padding(.leading, metrics.size(metrics.isWebInterface ? 4 : 0))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, metrics.size(11))
            .frame(height: metrics.size(27))
            .background(theme[.bgSunken].opacity(metrics.isWebInterface ? 0.78 : 1))
            .modifier(HomeWebTerminalBarClip())
            .padding(.horizontal, -metrics.size(7))
            .padding(.top, -metrics.size(7))
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            HStack(spacing: metrics.size(8)) {
                Text(verbatim: "›").font(metrics.monoFont(size: 17)).foregroundStyle(theme[.accent])
                Group {
                    if metrics.isWebInterface {
                        TextField(text: $prompt) {
                            Text("home.quick.placeholder").foregroundStyle(theme[.fg])
                        }
                        .lineLimit(1)
                        .foregroundStyle(theme[.fg])
                    } else {
                        TextField("home.quick.placeholder", text: $prompt, axis: .vertical)
                            .lineLimit(1...(focused ? 6 : 1))
                    }
                }
                .textFieldStyle(.plain)
                .font(metrics.monoFont(size: 12))
                .focused($focused)
                .onSubmit(send)
                .accessibilityIdentifier("home.quick.prompt")
            }
            .padding(.horizontal, metrics.size(9))
            .frame(minHeight: metrics.size(42))
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            if metrics.isWebInterface {
                toolbar(horizontal: !compactToolbar)
            } else {
                toolbar(horizontal: true)
            }
        }
        .padding(metrics.size(7))
        .frame(maxWidth: metrics.size(620))
        .background(theme[.bg].opacity(metrics.isWebInterface ? 0.76 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .shadow(color: metrics.isWebInterface
                ? (metrics.style == .clean ? .clear : theme[.bg].opacity(0.48)) : theme.shadow(.lg).color.color,
                radius: metrics.size(metrics.isWebInterface ? 36 : theme.shadow(.lg).blur),
                x: metrics.isWebInterface ? 0 : metrics.size(theme.shadow(.lg).x),
                y: metrics.size(metrics.isWebInterface ? 14 : theme.shadow(.lg).y))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(focused && !metrics.isWebInterface ? theme[.accentBorder] : .clear))
        .onAppear {
            if metrics.isWebInterface {
                agent = agents.contains(.claude) ? .claude : agents.first ?? .claude
                unrestricted = false
            } else {
                let last = AgentRegistry.builtin.parse(environment.preferences?.document.lastAgent)
                agent = last.flatMap { agents.contains($0) ? $0 : nil } ?? agents.first ?? .claude
                unrestricted = environment.preferences?.document.alwaysStartUnrestricted == true
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.quick")
    }

    @ViewBuilder private func toolbar(horizontal: Bool) -> some View {
        if horizontal {
            HStack(spacing: metrics.size(5)) {
                agentControl
                projectControl
                modeControl
                sendControl
            }
            .labelsHidden()
            .controlSize(.small)
        } else {
            VStack(spacing: metrics.size(5)) {
                HStack(spacing: metrics.size(5)) {
                    agentControl
                    projectControl
                }
                HStack(spacing: metrics.size(5)) {
                    modeControl
                        .frame(maxWidth: .infinity, alignment: .leading)
                    sendControl
                }
            }
            .labelsHidden()
            .controlSize(.small)
        }
    }

    @ViewBuilder private var agentControl: some View {
        Group {
            if metrics.isWebInterface {
                WebDropdown(selection: $agent, options: agents, menuStyle: .homeAgent, trigger: { value, state in
                    AnyView(HStack(spacing: metrics.size(6)) {
                        AgentLogo(agent: value.rawValue, size: 15,
                                  templateColor: theme[AgentTokens.accent(for: value.rawValue)])
                            .frame(width: metrics.size(15), height: metrics.size(15)).clipped()
                        Text("home.web.agent").foregroundStyle(theme[.fgMuted]).fixedSize()
                        Text(verbatim: webAgentName(value)).lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down").webProfileSized(10).font(metrics.font(size: 10))
                    }.modifier(HomeChoiceTrigger(open: state.open, agent: true)))
                }) { kind in
                    HStack(spacing: metrics.size(9)) {
                        AgentLogo(agent: kind.rawValue, size: 19)
                            .frame(width: metrics.size(19), height: metrics.size(19))
                        Text(verbatim: webAgentName(kind)).frame(maxWidth: .infinity, alignment: .leading)
                        if agent == kind {
                            Image(systemName: "checkmark").font(metrics.font(size: 12)).foregroundStyle(theme[.accent])
                        }
                    }
                }
            } else {
                AletheSelect(selection: $agent, options: agents) {
                    Text(verbatim: AgentLabels.name(for: $0.rawValue))
                }
            }
        }
        .frame(width: metrics.size(145))
        .modifier(HomeWebHelp(text: String(localized: "home.quick.agent")))
        .accessibilityLabel(Text("home.quick.agent"))
        .accessibilityIdentifier("home.quick.agent")
    }

    @ViewBuilder private var projectControl: some View {
        Button(action: chooseFolder) {
            if metrics.isWebInterface {
            HStack(spacing: metrics.size(5)) {
                Image(systemName: "folder").webProfileSized(13).font(metrics.font(size: 13))
                if metrics.isWebInterface { Text("home.web.path").foregroundStyle(theme[.fgMuted]).fixedSize() }
                if let folder = workingDirectory ?? project?.folder {
                    Text(verbatim: compactWebPath(folder))
                        .lineLimit(1).truncationMode(.tail)
                } else { Text("home.quick.project") }
                if metrics.isWebInterface {
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").webProfileSized(10).font(metrics.font(size: 10))
                }
            }
            } else {
                Label {
                    if let folder = workingDirectory ?? project?.folder {
                        Text(verbatim: (folder as NSString).abbreviatingWithTildeInPath)
                            .lineLimit(1).truncationMode(.middle)
                    } else { Text("home.quick.project") }
                } icon: { Image(systemName: "folder").webProfileSized(14) }
            }
        }
        .modifier(QuickProjectStyle())
        .modifier(HomeWebHelp(text: workingDirectory ?? project?.folder ?? String(localized: "home.quick.project")))
        .accessibilityLabel(Text("home.quick.project"))
        .accessibilityIdentifier("home.quick.project")
    }

    @ViewBuilder private var modeControl: some View {
        if metrics.isWebInterface || descriptor?.unrestrictedFlag != nil {
            Group {
                if metrics.isWebInterface {
                    WebDropdown(selection: $unrestricted, options: [false, true], menuStyle: .homeMode, trigger: { value, state in
                        AnyView(HStack(spacing: metrics.size(5)) {
                            AletheStatusDot(.accent, side: 5)
                            Text("home.web.mode").foregroundStyle(theme[.fgMuted]).fixedSize()
                            Text(value ? "home.quick.unrestricted" : "home.quick.normal").lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down").webProfileSized(10).font(metrics.font(size: 10))
                        }.modifier(HomeChoiceTrigger(open: state.open)))
                    }) { value in
                        HStack(spacing: metrics.size(8)) {
                            AletheStatusDot(.accent, side: 5)
                            Text(value ? "home.quick.unrestricted" : "home.quick.normal")
                        }
                    }.frame(width: compactToolbar ? nil : metrics.size(132))
                } else {
                    Picker("home.quick.mode", selection: $unrestricted) {
                        Text("home.quick.normal").tag(false)
                        Text("home.quick.unrestricted").tag(true)
                    }
                }
            }
            .fixedSize(horizontal: !metrics.isWebInterface || !compactToolbar, vertical: true)
            .accessibilityLabel(Text("home.quick.mode"))
            .accessibilityIdentifier("home.quick.mode")
        }
    }

    @ViewBuilder private var sendControl: some View {
        if metrics.isWebInterface {
            Button(action: send) {
                Image(systemName: "paperplane").webProfileSized(14)
            }
            .buttonStyle(HomeQuickSendStyle())
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(project == nil || agents.isEmpty)
            .help(Text("home.quick.send"))
            .accessibilityLabel(Text("home.quick.send"))
            .accessibilityIdentifier("home.quick.send")
        } else {
        Button(action: send) { Label { Text("home.quick.send") } icon: { Image(systemName: "paperplane").webProfileSized(14) }
            .labelStyle(.iconOnly)
            .frame(width: metrics.size(38), height: metrics.size(30))
            .background(theme[.accent], in: RoundedRectangle(cornerRadius: metrics.radius(metrics.isWebInterface ? .md : .sm)))
            .foregroundStyle(theme[.accentOn]) }
            .buttonStyle(.plain)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(project == nil || agents.isEmpty || (!metrics.isWebInterface && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            .opacity(project == nil || agents.isEmpty || (!metrics.isWebInterface && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ? (metrics.isWebInterface ? 0.45 : 0.5) : 1)
            .accessibilityLabel(Text("home.quick.send"))
            .accessibilityIdentifier("home.quick.send")
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = (workingDirectory ?? project?.folder).map { URL(fileURLWithPath: $0) }
        panel.begin { response in
            if response == .OK, let url = panel.url { workingDirectory = url.path }
        }
    }

    private func send() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let project, !text.isEmpty, agents.contains(agent) else { return }
        let tab = PaneTab(agent: agent.rawValue, workingDirectory: workingDirectory ?? project.folder,
                          unrestricted: descriptor?.unrestrictedFlag != nil && unrestricted, initialPrompt: text)
        workspace.update(undoManager: undoManager, actionName: String(localized: "undo.newTerminal")) {
            $0.openInTab(project.id)
            $0.addPane(to: project.id, tab: tab)
        }
        environment.preferences?.update { $0.lastAgent = agent.rawValue }
        prompt = ""
        environment.showingHome = false
    }
}

// MARK: - Recent projects and actions

private struct RecentProjects: View {
    let workspace: WorkspaceModel
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    @State private var hoveredProject: ProjectID?

    var body: some View {
        let recent = workspace.document.recentProjectIDs(limit: 6).compactMap(workspace.document.project)
        VStack(alignment: .leading, spacing: metrics.size(metrics.isWebInterface ? 12 : 8)) {
            HStack {
                HomeSectionHeader(title: "home.recent", count: recent.isEmpty ? nil : recent.count)
                Spacer()
                if metrics.isWebInterface {
                    Button("home.recent.viewAll") { environment.editorRequest = .findJump }
                        .buttonStyle(.plain).font(metrics.font(size: 10))
                        .textCase(.uppercase).tracking(metrics.size(0.6))
                        .foregroundStyle(theme[.textQuaternary])
                        .accessibilityIdentifier("home.action.findJump")
                } else {
                    Button("home.recent.viewAll") { environment.editorRequest = .findJump }.buttonStyle(.link)
                }
            }
            if recent.isEmpty {
                VStack(alignment: .leading, spacing: metrics.space(.s)) {
                    Text("home.recent.empty").foregroundStyle(theme[.textSecondary])
                    Button("home.recent.create") { environment.editorRequest = .newProject(.ungrouped) }
                        .buttonStyle(AletheButtonStyle(size: .small))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .aletheCard()
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: metrics.size(8)), count: 2),
                          spacing: metrics.size(5)) {
                    ForEach(recent) { project in card(project) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func lastUsed(_ id: ProjectID) -> Date? {
        let history = workspace.document.workspace.history.filter {
            $0.snapshot.selectedProjectID == id || $0.snapshot.openProjectIDs.contains(id)
        }.map(\.visitedAt)
        let tabs = workspace.document.workspace.tabs.filter {
            $0.projectID == id || $0.snapshot.openProjectIDs.contains(id)
        }.map(\.updatedAt)
        return (history + tabs).max()
    }

    private func card(_ project: Project) -> some View {
        let terminals = project.panes.filter { $0.content.isTerminal }.count
        return Button {
            workspace.update { $0.openInTab(project.id) }
            environment.showingHome = false
        } label: {
            HStack(spacing: metrics.size(metrics.isWebInterface ? 9 : 8)) {
                if metrics.isWebInterface {
                    SidebarCoverImage(source: project.iconUrl ?? "", side: 34) {
                        Text(verbatim: String(project.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
                            .font(metrics.font(size: 15, weight: .semibold))
                            .foregroundStyle(theme[.accentOn])
                            .frame(width: metrics.size(34), height: metrics.size(34))
                            .background(theme[project.color.token], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    }
                    .overlay(RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
                } else { AletheMonogram(name: project.name, color: theme[project.color.token], side: 28) }
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Text(verbatim: project.name).font(metrics.font(size: 11, weight: .semibold)).lineLimit(1)
                    TimelineView(.everyMinute) { _ in
                        HStack(spacing: metrics.space(.xxs)) {
                            Text(String(format: String(localized: terminals == 1 && metrics.isWebInterface
                                        ? "home.web.oneTerminal" : "home.recent.terminals"), terminals))
                            if let lastUsed = lastUsed(project.id) {
                                Text(verbatim: "·")
                                Text(lastUsed, format: .relative(presentation: .named))
                            }
                        }
                        .font(metrics.monoFont(size: 9)).foregroundStyle(theme[.textTertiary])
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right").webProfileSized(14).foregroundStyle(theme[.textTertiary])
                    .offset(x: hoveredProject == project.id && !metrics.reducesMotion && (!metrics.isWebInterface || metrics.style != .clean) ? metrics.size(2) : 0)
                    .animation(Motion.animation(Motion.quick, reduceMotion: metrics.reducesMotion), value: hoveredProject)
            }
            .contentShape(Rectangle())
            .padding(.vertical, metrics.size(7))
            .padding(.horizontal, metrics.size(10))
            .frame(minHeight: metrics.size(44))
            .background(theme[.bgSunken].opacity(metrics.isWebInterface ? 0.86 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            .overlay {
                if metrics.isWebInterface {
                    RoundedRectangle(cornerRadius: metrics.radius(.sm))
                        .strokeBorder(theme[hoveredProject == project.id ? .borderStrong : .border].opacity(0.82), lineWidth: metrics.size(1))
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { hoveredProject = $0 ? project.id : nil }
        .accessibilityIdentifier("home.recent.\(project.name)")
    }
}

private struct HomeActions: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        if metrics.isWebInterface { webBody } else { nativeBody }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HomeSectionHeader(title: "home.start")
            VStack(spacing: metrics.space(.xs)) {
                row("home.action.newTerminal", icon: "terminal", keys: "⌘T", id: "home.action.newTerminal") {
                    environment.editorRequest = .newTerminal(nil)
                }
                row("home.action.newProject", icon: "folder.badge.plus", keys: "⌘N", id: "home.action.newProject") {
                    environment.editorRequest = .newProject(.ungrouped)
                }
                row("home.action.newGroup", icon: "square.stack.3d.up", keys: "⇧⌘N", id: "home.action.newGroup") {
                    environment.editorRequest = .newGroup(parent: nil)
                }
                row("home.action.findJump", icon: "magnifyingglass", keys: "⌘K", id: "home.action.findJump") {
                    environment.editorRequest = .findJump
                }
            }
        }
    }

    private var webBody: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            HomeSectionHeader(title: "home.start")
            LazyVGrid(columns: metrics.isWebInterface
                      ? [GridItem(.adaptive(minimum: metrics.size(150)), spacing: metrics.size(8))]
                      : [GridItem(.flexible())], spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.xs)) {
                row("home.action.newTerminal", icon: "terminal", keys: "⌘T", id: "home.action.newTerminal") {
                    environment.editorRequest = .newTerminal(nil)
                }
                row("home.action.newProject", icon: "folder.badge.plus", keys: "⌘N", id: "home.action.newProject") {
                    environment.editorRequest = .newProject(.ungrouped)
                }
                row("home.action.newGroup", icon: "square.stack.3d.up", keys: "⇧⌘N", id: "home.action.newGroup") {
                    environment.editorRequest = .newGroup(parent: nil)
                }
            }
        }
    }

    private func webTitle(_ id: String) -> LocalizedStringKey {
        switch id {
        case "home.action.newTerminal": "home.web.newTerminal"
        case "home.action.newProject": "home.web.newProject"
        default: "home.web.newGroup"
        }
    }

    private func row(_ title: LocalizedStringKey, icon: String, keys: String?, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: metrics.space(.m)) {
                Image(systemName: icon).webProfileSized(14).frame(width: metrics.size(18)).foregroundStyle(theme[.textSecondary])
                if metrics.isWebInterface { Text(webTitle(id)).font(metrics.font(size: 12)) }
                else { Text(title) }
                Spacer()
                if let keys, !metrics.isWebInterface { Text(verbatim: keys).font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary]) }
            }
            .padding(.horizontal, metrics.size(metrics.isWebInterface ? 14 : 12))
            .padding(.vertical, metrics.size(metrics.isWebInterface ? 12 : 8))
            .contentShape(Rectangle())
            .frame(minHeight: metrics.isWebInterface ? metrics.size(44) : nil)
            .background(theme[metrics.isWebInterface ? .bgSunken : .surfaceCardDefault].opacity(metrics.isWebInterface ? 0.86 : 1), in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay {
                if metrics.isWebInterface {
                    RoundedRectangle(cornerRadius: metrics.radius(.md))
                        .strokeBorder(theme[.border], lineWidth: metrics.size(1))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

// MARK: - Footer

private struct HomeFooter: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics
    private static let repository = URL(string: "https://github.com/Kc1t/alethe-agents")!

    var body: some View {
        HStack(spacing: metrics.space(.xl)) {
            Link(destination: Self.repository) { Label { Text("home.repository") } icon: { Image(systemName: "chevron.left.forwardslash.chevron.right").webProfileSized(14) } }
            Link(destination: Self.repository.appending(path: "issues")) { Label { Text("home.issues") } icon: { Image(systemName: "smallcircle.filled.circle").webProfileSized(14) } }
            Link(destination: Self.repository.appending(path: "releases")) { Label { Text("home.releases") } icon: { Image(systemName: "shippingbox").webProfileSized(14) } }
            Spacer(minLength: 0)
            if !metrics.isWebInterface {
                Button { environment.editorRequest = .findJump } label: { Text("home.footer.search") }
                Button { environment.editorRequest = .onboarding } label: { Text("home.footer.help") }
                    .keyboardShortcut("?", modifiers: .command)
            }
        }
        .buttonStyle(.link)
        .font(metrics.isWebInterface ? metrics.monoFont(size: 10) : metrics.font(.footnote))
        .foregroundStyle(theme[.textTertiary])
        .padding(.top, metrics.isWebInterface ? metrics.size(14) : 0)
        .overlay(alignment: .top) {
            if metrics.isWebInterface { theme[.borderSubtle].frame(height: metrics.size(1)) }
        }
    }
}

/// Toolbar: Home ↔ workspace.
struct HomeButton: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme

    var body: some View {
        Button { environment.toggleHome() } label: {
            // The label's content never changes; only its tint marks Home as shown (see `icon`).
            Image(nsImage: Self.icon).webProfileSized(16)
                .foregroundStyle(environment.showingHome ? theme[.accent] : theme[.textSecondary])
        }
        .help(Text(environment.showingHome ? "menu.view.showWorkspace" : "menu.view.showHome"))
        .accessibilityLabel(Text("menu.view.showHome"))
        .accessibilityValue(Text(environment.showingHome ? "home.shown" : "home.hidden"))
        .accessibilityIdentifier("home.button")
    }

    // On macOS 27 the toolbar can hold this label in a 0×0 host (e.g. while its toolbar is hidden).
    // Swapping the glyph there made CoreUI rasterize `house.fill` at 0×0 and throw, crashing the
    // app; a swapped bitmap instead got laid out at 0×0 and vanished. So the label keeps one
    // pre-rendered bitmap for good: no content change to re-measure, no vector rasterization.
    private static let icon = templateBitmap("house")

    private static func templateBitmap(_ symbol: String) -> NSImage {
        let configuration = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        guard let glyph = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration) else { return NSImage() }
        let size = glyph.size
        let scale: CGFloat = 2
        guard size.width > 0, size.height > 0,
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
                                            pixelsWide: Int((size.width * scale).rounded(.up)),
                                            pixelsHigh: Int((size.height * scale).rounded(.up)),
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return NSImage() }
        bitmap.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        glyph.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        let image = NSImage(size: size)
        image.addRepresentation(bitmap)
        image.isTemplate = true
        return image
    }
}

// Shared by the toolbar and left sidebar Home controls.
extension AppEnvironment {
    func toggleHome() { showingHome.toggle() }
}

private struct QuickProjectStyle: ViewModifier {
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        if metrics.isWebInterface { content.buttonStyle(HomeQuickFieldStyle()) }
        else { content }
    }
}

private struct HomeWebNotifications: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(12)) {
            HStack {
                HomeSectionHeader(title: "notifications.title", count: environment.notifier.log.entries.isEmpty ? nil : environment.notifier.log.entries.count)
                Spacer()
                if !environment.notifier.log.entries.isEmpty {
                    Button("notifications.clear") { environment.notifier.clear() }.buttonStyle(.plain)
                }
            }
            VStack(spacing: 0) {
                if environment.notifier.log.entries.isEmpty {
                    VStack(spacing: metrics.size(10)) {
                        Image(systemName: "checkmark.circle").webProfileSized(18).font(metrics.font(size: 18))
                            .foregroundStyle(theme[.statusWorking])
                            .frame(width: metrics.size(56), height: metrics.size(56))
                            .background(theme[.statusWorking].opacity(0.14), in: RoundedRectangle(cornerRadius: metrics.size(18)))
                        Text("home.web.caughtUp").font(metrics.font(size: 14, weight: .semibold))
                        Text("home.notifications.emptyDetail").font(metrics.font(size: 12))
                            .foregroundStyle(theme[.textTertiary])
                    }
                    .padding(metrics.size(20)).frame(maxWidth: .infinity, minHeight: metrics.size(148))
                }
                ForEach(environment.notifier.log.entries.prefix(5)) { entry in
                    Button {
                        if let tab = entry.tab { environment.notifier.open(tab) }
                    } label: {
                        HStack(alignment: .top, spacing: metrics.size(11)) {
                            Group {
                                if let agent = entry.agent {
                                    AgentLogo(agent: agent, size: 14)
                                } else {
                                    Image(systemName: "bell").webProfileSized(14).font(metrics.font(size: 14))
                                }
                            }
                                .foregroundStyle(theme[entry.agent.map { AgentTokens.accent(for: $0) } ?? .textSecondary])
                                .frame(width: metrics.size(26), height: metrics.size(26))
                            VStack(alignment: .leading, spacing: metrics.size(2)) {
                                Text(verbatim: entry.title).font(metrics.font(size: 12, weight: .medium)).lineLimit(1)
                                Text(verbatim: entry.body).font(metrics.font(size: 11)).foregroundStyle(theme[.textTertiary]).lineLimit(2)
                            }
                            Spacer()
                            Text(entry.createdAt, format: .relative(presentation: .named)).font(metrics.monoFont(size: 10))
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        }
                        .padding(.horizontal, metrics.size(14)).padding(.vertical, metrics.size(12))
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("notifications.entry")
                }
            }
            .background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg))
                .strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("notifications.list")
    }
}

private struct HomeWebHelp: ViewModifier {
    let text: String
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        if metrics.isWebInterface { content.help(Text(verbatim: text)) }
        else { content }
    }
}

private struct HomeWebTerminalBarClip: ViewModifier {
    @Environment(\.metrics) private var metrics
    func body(content: Content) -> some View {
        if metrics.isWebInterface {
            content.clipShape(UnevenRoundedRectangle(
                topLeadingRadius: metrics.radius(.lg), topTrailingRadius: metrics.radius(.lg)))
        } else { content }
    }
}
