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
                VStack(alignment: .leading, spacing: metrics.isWebInterface ? metrics.size(18) : metrics.space(.xxl)) {
                    Spacer(minLength: metrics.size(28))
                    HomeHero(streak: ActivityDays.streak(activityDays))
                        .frame(maxWidth: .infinity)
                    QuickLaunch(workspace: workspace)
                        .frame(maxWidth: .infinity)
                    HStack(spacing: metrics.isWebInterface ? metrics.size(8) : metrics.space(.xl)) {
                        Button { environment.editorRequest = .newTerminal(nil) } label: {
                            Label("home.action.newTerminal", systemImage: "terminal")
                        }
                        Button { environment.editorRequest = .newProject(.ungrouped) } label: {
                            Label("home.action.newProject", systemImage: "folder.badge.plus")
                        }
                    }
                    .buttonStyle(.link)
                    .font(metrics.font(.footnote))
                    .frame(maxWidth: .infinity)
                    Spacer(minLength: metrics.size(42))
                    SetupWalkthroughView(workspace: workspace)
                }
                .frame(minHeight: metrics.isWebInterface
                       ? min(metrics.size(610), max(metrics.size(430), geometry.size.height * 0.56))
                       : metrics.size(430))
                .entrance(appeared, step: 0, reduced: metrics.reducesMotion, rise: metrics.size(8))
                (metrics.isWebInterface
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: metrics.size(20)))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: metrics.space(.xxl)))) {
                    RecentProjects(workspace: workspace)
                    HomeActions()
                        .frame(width: metrics.isWebInterface ? nil : metrics.size(240))
                }
                .entrance(appeared, step: 1, reduced: metrics.reducesMotion, rise: metrics.size(8))
                VStack(alignment: .leading, spacing: metrics.size(24)) {
                    UsageStrip()
                    ActivityGraph(days: $activityDays)
                    TimeAnalytics()
                    NotificationList(isHome: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .aletheCard()
                    HomeFooter()
                }
                .entrance(appeared, step: 2, reduced: metrics.reducesMotion, rise: metrics.size(8))
            }
            .frame(maxWidth: metrics.size(940), alignment: .leading)
            .padding(.horizontal, metrics.isWebInterface
                     ? min(metrics.size(28), max(metrics.size(16), geometry.size.width * 0.03))
                     : metrics.size(28))
            .padding(.bottom, metrics.size(18))
            .frame(maxWidth: .infinity)
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
        HStack(spacing: metrics.space(.s)) {
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
    let streak: Int
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    var body: some View {
        TimelineView(.everyMinute) { context in
            VStack(spacing: metrics.size(7)) {
                if metrics.isWebInterface {
                    avatar
                        .frame(width: metrics.size(116), height: metrics.size(46))
                        .overlay(alignment: .trailing) {
                            NowPlayingCard().fixedSize().offset(x: metrics.size(21))
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
                    .font(metrics.font(size: 34, weight: .medium))
                    .minimumScaleFactor(25.0 / 34.0)
                    .lineLimit(1)
                    .foregroundStyle(theme[.textPrimary])
                Text(context.date, format: .dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
                    .font(metrics.font(size: 11, weight: .medium))
                    .foregroundStyle(theme[.fg])
                    .padding(.vertical, metrics.size(3))
                    .padding(.horizontal, metrics.size(8))
                    .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.greeting")
    }

    private var firstName: String {
        let profile = environment.activeProfileName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !profile.isEmpty { return profile }
        return NSFullUserName().split(separator: " ").first.map(String.init) ?? NSUserName()
    }

    private var avatar: some View {
        Text(verbatim: String(firstName.prefix(1)).uppercased())
            .font(metrics.font(size: metrics.isWebInterface ? 16 : 28, weight: .medium))
            .foregroundStyle(theme[.accent])
            .frame(width: metrics.size(metrics.isWebInterface ? 44 : 64), height: metrics.size(metrics.isWebInterface ? 44 : 64))
            .background(theme[.bgSunken], in: Circle())
            .overlay(alignment: metrics.isWebInterface ? .leading : .bottomTrailing) {
                Label { Text(verbatim: "\(streak)") } icon: { Image(systemName: "flame.fill") }
                    .font(metrics.font(.caption))
                    .padding(metrics.space(.xs))
                    .background(theme[.panel], in: Capsule())
                    .offset(x: metrics.isWebInterface ? -metrics.size(30) : 0)
                    .accessibilityLabel(Text(String(format: String(localized: "home.activity.streak"), streak)))
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
        AgentRegistry.builtin.enabledKinds(environment.preferences?.document.enabledAgents).filter { $0 != .shell }
    }
    private var project: Project? {
        workspace.document.recentProjectIDs(limit: 1).first.flatMap(workspace.document.project)
    }
    private var descriptor: AgentDescriptor? { AgentRegistry.builtin.descriptor(for: agent) }

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.size(4)) {
            HStack(spacing: metrics.size(6)) {
                AletheStatusDot(.statusOffline, side: 7)
                AletheStatusDot(.statusWaiting, side: 7)
                AletheStatusDot(.statusWorking, side: 7)
                Text("home.quick.title")
                    .font(metrics.monoFont(size: 9))
                    .foregroundStyle(theme[.textTertiary])
                Spacer(minLength: 0)
            }
            .padding(.horizontal, metrics.size(11))
            .frame(height: metrics.size(27))
            .background(theme[.bgSunken])
            .padding(.horizontal, -metrics.size(7))
            .padding(.top, -metrics.size(7))
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            HStack(spacing: metrics.size(8)) {
                Text(verbatim: "›").font(metrics.monoFont(size: 17)).foregroundStyle(theme[.accent])
                TextField("home.quick.placeholder", text: $prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(metrics.monoFont(size: 12))
                    .lineLimit(1...(focused ? 6 : 1))
                    .focused($focused)
                    .onSubmit(send)
                    .accessibilityIdentifier("home.quick.prompt")
            }
            .padding(.horizontal, metrics.size(9))
            .frame(minHeight: metrics.size(42))
            .overlay(alignment: .bottom) { theme[.border].frame(height: metrics.size(1)) }
            HStack(spacing: metrics.size(5)) {
                AletheSelect(selection: $agent, options: agents) {
                    Text(verbatim: AgentLabels.name(for: $0.rawValue))
                }
                .frame(width: metrics.size(145))
                .accessibilityLabel(Text("home.quick.agent"))
                .accessibilityIdentifier("home.quick.agent")
                Button(action: chooseFolder) {
                    Label {
                        if let folder = workingDirectory ?? project?.folder {
                            Text(verbatim: (folder as NSString).abbreviatingWithTildeInPath)
                                .lineLimit(1).truncationMode(.middle)
                        } else {
                            Text("home.quick.project")
                        }
                    } icon: { Image(systemName: "folder") }
                }
                .modifier(QuickProjectStyle())
                .accessibilityLabel(Text("home.quick.project"))
                .accessibilityIdentifier("home.quick.project")
                if descriptor?.unrestrictedFlag != nil {
                    Group {
                        if metrics.isWebInterface {
                            AletheSelect(selection: $unrestricted, options: [false, true]) {
                                Text($0 ? "home.quick.unrestricted" : "home.quick.normal")
                            }.frame(width: metrics.size(132))
                        } else {
                            Picker("home.quick.mode", selection: $unrestricted) {
                                Text("home.quick.normal").tag(false)
                                Text("home.quick.unrestricted").tag(true)
                            }
                        }
                    }
                    .fixedSize()
                    .accessibilityLabel(Text("home.quick.mode"))
                    .accessibilityIdentifier("home.quick.mode")
                }
                Button(action: send) { Label("home.quick.send", systemImage: "paperplane")
                    .labelStyle(.iconOnly)
                    .frame(width: metrics.size(38), height: metrics.size(30))
                    .background(theme[.accent], in: RoundedRectangle(cornerRadius: metrics.radius(.sm)))
                    .foregroundStyle(theme[.accentOn]) }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(project == nil || agents.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(project == nil || agents.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.5 : 1)
                    .accessibilityLabel(Text("home.quick.send"))
                    .accessibilityIdentifier("home.quick.send")
            }
            .labelsHidden()
            .controlSize(.small)
        }
        .padding(metrics.size(7))
        .frame(maxWidth: metrics.size(620))
        .background(theme[.bg], in: RoundedRectangle(cornerRadius: metrics.radius(.lg)))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
        .shadow(color: theme.shadow(.lg).color.color, radius: metrics.size(theme.shadow(.lg).blur),
                x: metrics.size(theme.shadow(.lg).x), y: metrics.size(theme.shadow(.lg).y))
        .overlay(RoundedRectangle(cornerRadius: metrics.radius(.lg)).strokeBorder(focused ? theme[.accentBorder] : .clear))
        .onAppear {
            let last = AgentRegistry.builtin.parse(environment.preferences?.document.lastAgent)
            agent = last.flatMap { agents.contains($0) ? $0 : nil } ?? agents.first ?? .claude
            unrestricted = environment.preferences?.document.alwaysStartUnrestricted == true
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.quick")
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
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
            HStack {
                HomeSectionHeader(title: "home.recent", count: recent.isEmpty ? nil : recent.count)
                Spacer()
                Button("home.recent.viewAll") { environment.editorRequest = .findJump }
                    .buttonStyle(.link)
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
            HStack(spacing: metrics.space(.m)) {
                AletheMonogram(name: project.name, color: theme[project.color.token], side: 28)
                VStack(alignment: .leading, spacing: metrics.space(.xxs)) {
                    Text(verbatim: project.name).font(metrics.font(size: 11, weight: .semibold)).lineLimit(1)
                    TimelineView(.everyMinute) { _ in
                        HStack(spacing: metrics.space(.xxs)) {
                            Text(String(format: String(localized: "home.recent.terminals"), terminals))
                            if let lastUsed = lastUsed(project.id) {
                                Text(verbatim: "·")
                                Text(lastUsed, format: .relative(presentation: .named))
                            }
                        }
                        .font(metrics.monoFont(size: 9)).foregroundStyle(theme[.textTertiary])
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right").foregroundStyle(theme[.textTertiary])
                    .offset(x: hoveredProject == project.id && !metrics.reducesMotion ? metrics.size(2) : 0)
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
        VStack(alignment: .leading, spacing: metrics.space(.m)) {
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
                row("home.action.findJump", icon: "magnifyingglass", keys: "⌘K", id: "home.action.findJump") {
                    environment.editorRequest = .findJump
                }
            }
        }
    }

    private func row(_ title: LocalizedStringKey, icon: String, keys: String?, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: metrics.space(.m)) {
                Image(systemName: icon).frame(width: metrics.size(18)).foregroundStyle(theme[.textSecondary])
                Text(title)
                Spacer()
                if let keys { Text(verbatim: keys).font(metrics.font(.footnote)).foregroundStyle(theme[.textTertiary]) }
            }
            .padding(.horizontal, metrics.space(.l))
            .padding(.vertical, metrics.space(.m))
            .contentShape(Rectangle())
            .frame(minHeight: metrics.isWebInterface ? metrics.size(44) : nil)
            .background(theme[metrics.isWebInterface ? .bgSunken : .surfaceCardDefault], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
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
            Link(destination: Self.repository) { Label("home.repository", systemImage: "chevron.left.forwardslash.chevron.right") }
            Link(destination: Self.repository.appending(path: "issues")) { Label("home.issues", systemImage: "smallcircle.filled.circle") }
            Link(destination: Self.repository.appending(path: "releases")) { Label("home.releases", systemImage: "shippingbox") }
            Spacer(minLength: 0)
            Button { environment.editorRequest = .findJump } label: {
                Text("home.footer.search")
            }
            Button { environment.editorRequest = .onboarding } label: { Text("home.footer.help") }
                .keyboardShortcut("?", modifiers: .command)
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
            Image(nsImage: Self.icon)
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
        if metrics.isWebInterface { content.buttonStyle(AletheQuickFieldStyle()) }
        else { content }
    }
}
