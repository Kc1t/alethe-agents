import AletheAgents
import AletheDesign
import AletheModel
import AppKit
import SwiftUI
import UniformTypeIdentifiers

extension AppEnvironment {
    var agentRegistry: AgentRegistry {
        guard interfaceStyle == .web else { return .builtin }
        let definitions = preferences?.document.customAgents ?? []
        let builtins = Set(AgentRegistry.builtin.kinds.map(\.rawValue)).union(["wsl", "kimi", "grok", "codewhale"])
        let custom = definitions.compactMap { definition -> AgentDescriptor? in
            guard definition.validationError(existing: definitions, builtins: builtins, editing: definition.id) == nil,
                  let tokens = definition.tokens, let binary = tokens.first else { return nil }
            return AgentDescriptor(kind: .init(rawValue: definition.id), displayName: definition.label, cliCommand: binary,
                unrestrictedFlag: definition.unrestrictedFlag, defaultArguments: Array(tokens.dropFirst()))
        }
        return AgentRegistry(descriptors: AgentRegistry.builtin.descriptors + custom)
    }
    func customAgentIconURL(_ id: String) -> URL? {
        guard CustomAgentDefinition.isID(id), let locations, let profileID else { return nil }
        return locations.profileDirectory(profileID).appending(path: "custom-agent-icons/\(id).ico")
    }
}

struct CustomAgentIcon: View {
    let definition: CustomAgentDefinition
    var size: CGFloat = 20
    var previewFile: URL? = nil
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    private var spec: CustomAgentIconSpec { definition.iconSpec ?? .init(kind: "preset", key: definition.icon ?? "bot") }
    private var source: String? {
        if let previewFile, let bytes = try? previewFile.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           bytes <= 512 * 1024, let data = try? Data(contentsOf: previewFile), CustomAgentDefinition.icoError(data) == nil {
            return "data:image/x-icon;base64," + data.base64EncodedString()
        }
        if spec.kind == "url", let href = spec.href, CustomAgentDefinition.validURL(href) { return href }
        if spec.kind == "file", let id = spec.assetId, let url = environment.customAgentIconURL(id),
           let data = try? Data(contentsOf: url) { return "data:image/x-icon;base64," + data.base64EncodedString() }
        return nil
    }
    private var token: ThemeToken { AgentTokens.accent(for: (definition.accentToken ?? "--agent-shell").replacingOccurrences(of: "--agent-", with: "")) }
    var body: some View {
        Group {
            if let source {
                SidebarCoverImage(source: source, side: size, cornerRadius: 0) { fallback }
            } else if spec.key != "bot", let key = spec.key, CustomAgentDefinition.icons.contains(key) {
                AgentLogo(agent: key, size: size)
            } else { fallback }
        }.frame(width: metrics.size(size), height: metrics.size(size)).accessibilityHidden(true)
    }
    private var fallback: some View {
        Image(systemName: "cpu").resizable().aspectRatio(contentMode: .fit).foregroundStyle(theme[token])
    }
}

struct CustomAgentsSection: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    @State private var draft: CustomAgentDefinition?
    @State private var editing: String?
    @State private var mode = "preset"
    @State private var picked: URL?
    @State private var error: String?
    @State private var removing: CustomAgentDefinition?
    private var agents: [CustomAgentDefinition] { environment.preferences?.document.customAgents ?? [] }
    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: metrics.size(8)) {
                if agents.isEmpty, draft == nil { customLabel("customAgentsEmpty").font(metrics.font(size: 11)).foregroundStyle(theme[.fgFaint]) }
                ForEach(agents) { agent in row(agent) }
                if draft != nil { editor }
                else {
                    Button {
                        editing = nil; picked = nil; error = nil; mode = "preset"; draft = .init()
                    } label: { customLabel("customAgentAdd") }.buttonStyle(AletheCustomAgentButtonStyle())
                }
            }
        } header: { customLabel("customAgents") } footer: { customLabel("customAgentsDesc") }
        .webConfirm(isPresented: Binding { removing != nil } set: { if !$0 { removing = nil } },
                    message: removing?.label ?? "", title: String(localized: "settings.custom.customAgentConfirmRemove"),
                    destructive: true) {
            guard let removing else { return }
            environment.preferences?.update {
                $0.customAgents = agents.filter { $0.id != removing.id }
                $0.enabledAgents?.removeAll { $0 == removing.id }
            }
            if let file = environment.customAgentIconURL(removing.id) { try? FileManager.default.removeItem(at: file) }
            if editing == removing.id { draft = nil }
        }
        .confirmationDialog("settings.custom.customAgentConfirmRemove", isPresented: Binding {
            !metrics.isWebInterface && removing != nil
        } set: { if !$0 { removing = nil } }, titleVisibility: .visible) {
            Button(role: .destructive) {
                guard let removing else { return }
                environment.preferences?.update {
                    $0.customAgents = agents.filter { $0.id != removing.id }
                    $0.enabledAgents?.removeAll { $0 == removing.id }
                }
                if let file = environment.customAgentIconURL(removing.id) { try? FileManager.default.removeItem(at: file) }
                if editing == removing.id { draft = nil }
                self.removing = nil
            } label: { customLabel("customAgentRemove") }
            Button { removing = nil } label: { customLabel("customAgentCancel") }
        } message: { if let removing { Text(verbatim: removing.label) } }
    }
    private func row(_ agent: CustomAgentDefinition) -> some View {
        HStack(spacing: metrics.size(12)) {
            CustomAgentIcon(definition: agent).frame(width: metrics.size(36), height: metrics.size(36))
                .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(9)))
            VStack(alignment: .leading, spacing: metrics.size(3)) {
                Text(verbatim: agent.label).font(metrics.font(size: 12, weight: .bold))
                Text(verbatim: agent.cliCommand).font(metrics.monoFont(size: 10)).foregroundStyle(theme[.fgMuted]).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Toggle(isOn: enabled(agent.id)) { Text(verbatim: agent.label) }.labelsHidden().toggleStyle(.checkbox)
                .disabled(isEnabled(agent.id) && environment.agentRegistry.enabledKinds(environment.preferences?.document.enabledAgents).filter { $0 != .shell }.count <= 1)
            Button {
                draft = agent; editing = agent.id; mode = agent.iconSpec?.kind ?? "preset"; picked = nil; error = nil
            } label: { customLabel("customAgentEdit") }.buttonStyle(AletheCustomAgentButtonStyle(compact: true))
            Button { removing = agent } label: { customLabel("customAgentRemove") }.buttonStyle(AletheCustomAgentButtonStyle(compact: true))
        }.padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10)).modifier(CustomAgentPanel())
    }
    private var editor: some View {
        VStack(alignment: .leading, spacing: metrics.size(10)) {
            field("customAgentId", text: binding(\.id), disabled: editing != nil)
            hint("customAgentIdHint")
            field("customAgentLabel", text: binding(\.label))
            field("customAgentCli", text: binding(\.cliCommand))
            hint("customAgentCliHint")
            field("customAgentFlag", text: optional(\.unrestrictedFlag))
            hint("customAgentFlagHint")
            HStack(spacing: metrics.size(10)) {
                VStack(alignment: .leading, spacing: metrics.size(4)) {
                    customLabel("customAgentAccent").font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
                    AletheSelect(selection: optional(\.accentToken), options: CustomAgentDefinition.accents) { Text(verbatim: $0) }
                }
                if let draft { CustomAgentIcon(definition: draft, previewFile: mode == "file" ? picked : nil).frame(width: metrics.size(36), height: metrics.size(36)) }
            }
            VStack(alignment: .leading, spacing: metrics.size(6)) {
                customLabel("customAgentIconMode").font(metrics.font(size: 11))
                ForEach(["preset", "file", "url"], id: \.self) { option in
                    Button {
                        mode = option
                        draft?.iconSpec = .init(kind: option, key: option == "preset" ? "bot" : nil,
                            href: option == "url" ? "" : nil, assetId: option == "file" ? draft?.id : nil)
                    } label: {
                        HStack(spacing: metrics.size(8)) {
                            Image(systemName: mode == option ? "largecircle.fill.circle" : "circle").font(metrics.font(size: 16))
                            customLabel(option == "preset" ? "customAgentIconPreset" : option == "file" ? "customAgentIconFile" : "customAgentIconUrl")
                        }.font(metrics.font(size: 12))
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, metrics.size(12)).padding(.vertical, metrics.size(10)).modifier(CustomAgentPanel())
            if mode == "preset" {
                AletheSelect(selection: Binding { draft?.iconSpec?.key ?? "bot" } set: { draft?.iconSpec = .init(kind: "preset", key: $0) },
                             options: CustomAgentDefinition.icons) { Text(verbatim: $0) }
            } else if mode == "url" {
                field("customAgentIcon", text: Binding { draft?.iconSpec?.href ?? "" } set: { draft?.iconSpec = .init(kind: "url", href: $0) })
                hint("customAgentIconUrlHint")
            } else {
                Button { chooseIcon() } label: { customLabel("customAgentIconPick") }
                if let picked { Text(verbatim: picked.lastPathComponent).font(metrics.font(size: 10)) }
                else if editing != nil { hint("customAgentIconFileKept") }
                hint("customAgentIconFileHint")
            }
            if let error { customLabel("customAgentError" + error.prefix(1).uppercased() + error.dropFirst()).font(metrics.font(size: 11)).foregroundStyle(theme[.statusWaiting]) }
            HStack(spacing: metrics.size(8)) {
                Button(action: save) { customLabel("customAgentSave") }.buttonStyle(AletheCustomAgentButtonStyle(primary: true))
                Button { draft = nil; picked = nil } label: { customLabel("customAgentCancel") }.buttonStyle(AletheCustomAgentButtonStyle())
            }
        }.padding(metrics.size(12)).modifier(CustomAgentPanel())
    }
    private func field(_ key: String, text: Binding<String>, disabled: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: metrics.size(4)) {
            customLabel(key).font(metrics.font(size: 11)).foregroundStyle(theme[.fgMuted])
            TextField(text: text) { customLabel(key) }.modifier(ProjectGroupWebInput()).disabled(disabled)
        }
    }
    private func hint(_ key: String) -> some View { customLabel(key).font(metrics.font(size: 10)).foregroundStyle(theme[.fgFaint]) }
    private func binding(_ path: WritableKeyPath<CustomAgentDefinition, String>) -> Binding<String> {
        Binding { draft?[keyPath: path] ?? "" } set: { draft?[keyPath: path] = $0 }
    }
    private func optional(_ path: WritableKeyPath<CustomAgentDefinition, String?>) -> Binding<String> {
        Binding { draft?[keyPath: path] ?? "" } set: { draft?[keyPath: path] = $0 }
    }
    private func isEnabled(_ id: String) -> Bool { environment.preferences?.document.enabledAgents?.contains(id) ?? true }
    private func enabled(_ id: String) -> Binding<Bool> {
        Binding { isEnabled(id) } set: { on in
            environment.preferences?.update { $0.enabledAgents = environment.agentRegistry.enabled($0.enabledAgents, setting: .init(rawValue: id), on: on) }
        }
    }
    private func chooseIcon() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [UTType(filenameExtension: "ico") ?? .image]
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK { picked = panel.url }
    }
    private func save() {
        guard var next = draft else { return }
        next.id = next.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        next.label = next.label.trimmingCharacters(in: .whitespacesAndNewlines)
        next.cliCommand = next.cliCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        next.unrestrictedFlag = next.unrestrictedFlag?.trimmingCharacters(in: .whitespacesAndNewlines)
        if mode == "file" { next.iconSpec = .init(kind: "file", assetId: next.id) }
        next.icon = mode == "preset" ? next.iconSpec?.key : "bot"
        let builtins = Set(AgentRegistry.builtin.kinds.map(\.rawValue)).union(["wsl", "kimi", "grok", "codewhale"])
        if let error = next.validationError(existing: agents, builtins: builtins, editing: editing) { self.error = error; return }
        if mode == "file" {
            guard let destination = environment.customAgentIconURL(next.id) else { error = "iconFile"; return }
            if let picked {
                guard picked.pathExtension.lowercased() == "ico" else { error = "iconFileInvalid"; return }
                do {
                    let attributes = try picked.resourceValues(forKeys: [.fileSizeKey])
                    guard (attributes.fileSize ?? 0) <= 512 * 1024 else { error = "iconFileTooLarge"; return }
                    let data = try Data(contentsOf: picked)
                    if let error = CustomAgentDefinition.icoError(data) { self.error = error; return }
                    try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: destination, options: .atomic)
                } catch { self.error = "iconFile"; return }
            } else if !FileManager.default.fileExists(atPath: destination.path) { error = "iconFile"; return }
        }
        environment.preferences?.update {
            var list = agents
            if let index = list.firstIndex(where: { $0.id == editing }) { list[index] = next } else { list.append(next) }
            $0.customAgents = list
            if editing == nil, $0.enabledAgents != nil { $0.enabledAgents?.append(next.id) }
        }
        draft = nil; picked = nil; error = nil
    }
}

private struct CustomAgentPanel: ViewModifier {
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        content.background(theme[.bgSunken], in: RoundedRectangle(cornerRadius: metrics.radius(.md)))
            .overlay(RoundedRectangle(cornerRadius: metrics.radius(.md)).strokeBorder(theme[.border], lineWidth: metrics.size(1)))
    }
}

func customLabel(_ key: String) -> Text { Text(LocalizedStringKey(customAgentKeys[key] ?? key)) }
private let customAgentKeys: [String: String] = [
    "customAgentAccent": "settings.custom.customAgentAccent",
    "customAgentAdd": "settings.custom.customAgentAdd",
    "customAgentCancel": "settings.custom.customAgentCancel",
    "customAgentCli": "settings.custom.customAgentCli",
    "customAgentCliHint": "settings.custom.customAgentCliHint",
    "customAgentEdit": "settings.custom.customAgentEdit",
    "customAgentErrorCliEmpty": "settings.custom.customAgentErrorCliEmpty",
    "customAgentErrorCliUnsafe": "settings.custom.customAgentErrorCliUnsafe",
    "customAgentErrorIconFile": "settings.custom.customAgentErrorIconFile",
    "customAgentErrorIconFileInvalid": "settings.custom.customAgentErrorIconFileInvalid",
    "customAgentErrorIconFileNotSquare": "settings.custom.customAgentErrorIconFileNotSquare",
    "customAgentErrorIconFileTooLarge": "settings.custom.customAgentErrorIconFileTooLarge",
    "customAgentErrorIconUrl": "settings.custom.customAgentErrorIconUrl",
    "customAgentErrorIdBuiltin": "settings.custom.customAgentErrorIdBuiltin",
    "customAgentErrorIdFormat": "settings.custom.customAgentErrorIdFormat",
    "customAgentErrorIdTaken": "settings.custom.customAgentErrorIdTaken",
    "customAgentErrorLabelEmpty": "settings.custom.customAgentErrorLabelEmpty",
    "customAgentFlag": "settings.custom.customAgentFlag",
    "customAgentFlagHint": "settings.custom.customAgentFlagHint",
    "customAgentIcon": "settings.custom.customAgentIcon",
    "customAgentIconFile": "settings.custom.customAgentIconFile",
    "customAgentIconFileHint": "settings.custom.customAgentIconFileHint",
    "customAgentIconFileKept": "settings.custom.customAgentIconFileKept",
    "customAgentIconMode": "settings.custom.customAgentIconMode",
    "customAgentIconPick": "settings.custom.customAgentIconPick",
    "customAgentIconPreset": "settings.custom.customAgentIconPreset",
    "customAgentIconUrl": "settings.custom.customAgentIconUrl",
    "customAgentIconUrlHint": "settings.custom.customAgentIconUrlHint",
    "customAgentId": "settings.custom.customAgentId",
    "customAgentIdHint": "settings.custom.customAgentIdHint",
    "customAgentLabel": "settings.custom.customAgentLabel",
    "customAgentRemove": "settings.custom.customAgentRemove",
    "customAgentSave": "settings.custom.customAgentSave",
    "customAgents": "settings.custom.customAgents",
    "customAgentsDesc": "settings.custom.customAgentsDesc",
    "customAgentsEmpty": "settings.custom.customAgentsEmpty",
]
