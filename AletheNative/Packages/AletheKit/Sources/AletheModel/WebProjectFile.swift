import AletheFoundation
import Foundation

/// The web sidebar exports a bare Project, including terminals, rather than a settings envelope.
public enum WebProjectFile {
    public enum Failure: Error { case invalidProject }

    public static func decode(_ data: Data) throws -> Project {
        let raw = try JSONDecoder().decode(JSONObject.self, from: data)
        guard let name = raw["name"]?.stringValue, let terminals = raw["terminals"]?.arrayValue,
              terminals.allSatisfy({ $0.objectValue != nil }) else { throw Failure.invalidProject }
        let folder = raw["defaultCwd"]?.stringValue
            ?? terminals.first?.objectValue?["cwd"]?.stringValue ?? ""
        var project = Project(name: name, color: TauriImport.projectColor(raw["color"]?.stringValue) ?? .blue,
                              folder: folder)
        var stored = raw
        stored["terminals"] = .array(terminals.map { value in
            guard var terminal = value.objectValue else { return value }
            terminal["tabs"] = .array((terminal["tabs"]?.arrayValue ?? []).map { value in
                guard var tab = value.objectValue else { return value }
                tab["ptyId"] = .null
                return .object(tab)
            })
            return .object(terminal)
        })
        project.webConfiguration = stored
        project.archived = false
        project.hidden = boolean(raw["hidden"])
        project.iconUrl = raw["iconUrl"]?.stringValue
        project.layoutMode = raw["layoutMode"]?.stringValue.flatMap(PaneLayoutMode.init(rawValue:))
        project.gridLayout = decodeValue(raw["gridLayout"])
        project.gridLayoutHistory = decodeValue(raw["gridLayoutHistory"])
        project.paneGroups = decodeValue(raw["paneGroups"])
        project.activeGridID = raw["activeGridId"]?.stringValue.flatMap { $0 == "default" ? nil : ProjectGridID(rawValue: $0) }
        project.grids = raw["grids"]?.arrayValue?.compactMap { value in
            guard let grid = value.objectValue, let id = grid["id"]?.stringValue, id != "default",
                  let name = grid["name"]?.stringValue else { return nil }
            return ProjectGrid(id: ProjectGridID(rawValue: id), name: name,
                               layoutMode: grid["layoutMode"]?.stringValue.flatMap(PaneLayoutMode.init(rawValue:)),
                               gridLayout: decodeValue(grid["gridLayout"]), gridLayoutHistory: decodeValue(grid["gridLayoutHistory"]))
        }
        if let main = raw["grids"]?.arrayValue?.compactMap(\.objectValue).first(where: { $0["id"]?.stringValue == "default" }) {
            project.layoutMode = main["layoutMode"]?.stringValue.flatMap(PaneLayoutMode.init(rawValue:))
            project.gridLayout = decodeValue(main["gridLayout"])
            project.gridLayoutHistory = decodeValue(main["gridLayoutHistory"])
        }
        project.autoWorktree = boolean(raw["autoWorktree"])
        project.worktreeMode = raw["worktreeMode"]?.stringValue.flatMap(ProjectWorktreeMode.init(rawValue:))
        project.githubURL = raw["githubUrl"]?.stringValue
        project.graphifyEnabled = boolean(raw["graphifyEnabled"])
        project.validationCommands = decodeValue(raw["validationCommands"])
        project.healthCheckCommand = raw["healthCheckCommand"]?.stringValue
        project.healthCheckPath = raw["healthCheckPath"]?.stringValue
        project.conflictAgentProvider = raw["conflictAgentProvider"]?.stringValue
        project.conflictAgentModel = raw["conflictAgentModel"]?.stringValue
        project.gsdWatcherEnabled = boolean(raw["gsdWatcherEnabled"])
        project.panes = try terminals.compactMap { value -> Pane? in
            guard let terminal = value.objectValue, let id = terminal["id"]?.stringValue,
                  let tabs = terminal["tabs"]?.arrayValue else { throw Failure.invalidProject }
            let path = terminal["filePath"]?.stringValue ?? ""
            let content: PaneContent
            switch terminal["kind"]?.stringValue ?? "terminal" {
            case "terminal": content = .terminal
            case "orchestrator": content = .orchestrator
            case "graphify": content = .graphify
            case "markdown": content = .markdown(path: path)
            case "image": content = .image(path: path)
            case "video": content = .video(path: path)
            case "diff": content = .diff(path: terminal["filePath"]?.stringValue, staged: boolean(terminal["staged"]) ?? false)
            case "web": content = .web(url: terminal["url"]?.stringValue ?? "", options: WebPaneOptions())
            case "file": content = .markdown(path: path)
            default: return nil
            }
            let decodedTabs = try tabs.map { value -> PaneTab in
                guard let tab = value.objectValue, let tabID = tab["id"]?.stringValue,
                      let agent = tab["type"]?.stringValue else { throw Failure.invalidProject }
                let args: [String] = decodeValue(tab["extraArgs"]) ?? []
                var result = PaneTab(id: TabID(rawValue: tabID), agent: agent, title: tab["name"]?.stringValue,
                                     workingDirectory: tab["cwd"]?.stringValue ?? terminal["cwd"]?.stringValue ?? folder,
                                     sessionID: tab["sessionId"]?.stringValue, extraArguments: args,
                                     initialPrompt: tab["initialInput"]?.stringValue)
                result.unrestricted = unrestrictedFlags[agent].map { args.contains($0) } ?? false
                result.useRouter9 = boolean(tab["useRouter9"])
                result.worktreeAgentID = terminal["worktreeAgentId"]?.stringValue
                return result
            }
            var pane = Pane(id: PaneID(rawValue: id), content: content, tabs: decodedTabs,
                            activeTabID: terminal["activeTabId"]?.stringValue.map { TabID(rawValue: $0) },
                            laneVisible: boolean(terminal["laneVisible"]))
            pane.disabled = boolean(terminal["disabled"])
            pane.remoteShared = boolean(terminal["remoteShared"])
            pane.gridID = terminal["gridId"]?.stringValue.flatMap { $0 == "default" ? nil : ProjectGridID(rawValue: $0) }
            return pane
        }
        guard Set(project.panes.map(\.id)).count == project.panes.count,
              Set(project.panes.flatMap(\.tabs).map(\.id)).count == project.panes.flatMap(\.tabs).count else {
            throw Failure.invalidProject
        }
        project.reconcilePaneGroups()
        return project
    }

    public static func data(_ project: Project, group: GroupID? = nil) throws -> Data {
        var raw = project.webConfiguration ?? [:]
        raw["id"] = .string(project.id.rawValue)
        raw["name"] = .string(project.name)
        if TauriImport.projectColor(raw["color"]?.stringValue) != project.color {
            raw["color"] = .string(project.color.rawValue)
        }
        raw["defaultCwd"] = .string(project.folder)
        raw["groupId"] = group.map { .string($0.rawValue) } ?? .null
        raw["archived"] = project.archived.map(JSONValue.bool)
        raw["hidden"] = project.hidden.map(JSONValue.bool)
        raw["iconUrl"] = project.iconUrl.map(JSONValue.string)
        raw["createdAt"] = .number(project.createdAt.timeIntervalSince1970 * 1000)
        raw["collapsed"] = raw["collapsed"] ?? .bool(false)
        raw["layoutMode"] = .string(project.layout.rawValue)
        raw["gridLayout"] = try value(project.activeArrangement.gridLayout)
        raw["gridLayoutHistory"] = try value(project.activeArrangement.gridLayoutHistory)
        raw["paneGroups"] = try value(project.paneGroups)
        if let grids = project.grids {
            var main = raw["grids"]?.arrayValue?.compactMap(\.objectValue).first { $0["id"]?.stringValue == "default" }
                ?? ["id": .string("default"), "name": .string("default")]
            main["layoutMode"] = .string((project.layoutMode ?? .auto).rawValue)
            main["gridLayout"] = try value(project.gridLayout)
            main["gridLayoutHistory"] = try value(project.gridLayoutHistory)
            raw["grids"] = .array([.object(main)] + (try value(grids)?.arrayValue ?? []))
        } else { raw["grids"] = nil }
        raw["activeGridId"] = project.activeGridID.map { .string($0.rawValue) }
        raw["autoWorktree"] = project.autoWorktree.map(JSONValue.bool)
        raw["worktreeMode"] = project.worktreeMode.map { .string($0.rawValue) }
        raw["githubUrl"] = project.githubURL.map(JSONValue.string)
        raw["graphifyEnabled"] = project.graphifyEnabled.map(JSONValue.bool)
        raw["validationCommands"] = try value(project.validationCommands)
        raw["healthCheckCommand"] = project.healthCheckCommand.map(JSONValue.string)
        raw["healthCheckPath"] = project.healthCheckPath.map(JSONValue.string)
        raw["conflictAgentProvider"] = project.conflictAgentProvider.map(JSONValue.string)
        raw["conflictAgentModel"] = project.conflictAgentModel.map(JSONValue.string)
        raw["gsdWatcherEnabled"] = project.gsdWatcherEnabled.map(JSONValue.bool)
        let originals = raw["terminals"]?.arrayValue?.compactMap(\.objectValue) ?? []
        raw["terminals"] = .array(project.panes.map { pane in
            var terminal = originals.first { $0["id"]?.stringValue == pane.id.rawValue } ?? [:]
            let originalTabs = terminal["tabs"]?.arrayValue?.compactMap(\.objectValue) ?? []
            terminal["id"] = .string(pane.id.rawValue)
            if terminal["kind"]?.stringValue != "file" || pane.content.kind != .markdown {
                terminal["kind"] = .string(pane.content.kind.rawValue)
            }
            terminal["name"] = terminal["name"] ?? .string(pane.activeTab?.title ?? pane.activeTab?.agent ?? pane.content.kind.rawValue)
            terminal["cwd"] = .string(pane.activeTab?.workingDirectory ?? project.folder)
            terminal["activeTabId"] = .string(pane.activeTabID?.rawValue ?? "")
            terminal["disabled"] = .bool(pane.disabled ?? false)
            terminal["laneVisible"] = pane.laneVisible.map(JSONValue.bool) ?? .null
            terminal["remoteShared"] = pane.remoteShared.map(JSONValue.bool)
            terminal["gridId"] = pane.gridID.map { .string($0.rawValue) }
            terminal["filePath"] = pane.content.filePath.map(JSONValue.string)
            if case .diff(let path, let staged) = pane.content {
                terminal["filePath"] = path.map(JSONValue.string)
                terminal["staged"] = .bool(staged)
            }
            if case .web(let url, _) = pane.content { terminal["url"] = .string(url) }
            terminal["worktreeAgentId"] = pane.activeTab?.worktreeAgentID.map(JSONValue.string)
            terminal["tabs"] = .array(pane.tabs.map { tab in
                var entry = originalTabs.first { $0["id"]?.stringValue == tab.id.rawValue } ?? [:]
                entry["id"] = .string(tab.id.rawValue)
                entry["type"] = .string(tab.agent)
                entry["name"] = .string(tab.title ?? tab.agent)
                entry["cwd"] = .string(tab.workingDirectory ?? project.folder)
                entry["ptyId"] = .null
                entry["sessionId"] = tab.sessionID.map(JSONValue.string)
                var arguments = tab.extraArguments
                if tab.unrestricted, let flag = unrestrictedFlags[tab.agent], !arguments.contains(flag) { arguments.append(flag) }
                entry["extraArgs"] = .array(arguments.map(JSONValue.string))
                entry["initialInput"] = tab.initialPrompt.map(JSONValue.string)
                entry["useRouter9"] = tab.useRouter9.map(JSONValue.bool)
                return .object(entry)
            })
            return .object(terminal)
        })
        // Unsupported web-only panes remain in the file for a lossless return to the web app.
        let knownKinds = Set(PaneContent.Kind.allCases.map(\.rawValue) + ["file"])
        let opaque = originals.filter { !knownKinds.contains($0["kind"]?.stringValue ?? "terminal") }
        raw["terminals"] = .array((raw["terminals"]?.arrayValue ?? []) + opaque.map { original in
            var terminal = original
            terminal["tabs"] = .array((terminal["tabs"]?.arrayValue ?? []).map { value in
                guard var tab = value.objectValue else { return value }
                tab["ptyId"] = .null
                return .object(tab)
            })
            return .object(terminal)
        })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(raw)
    }

    /// Web import creates a new project and clears live PTYs. Native ids are global, so conflicting
    /// pane/tab identities and their layout references are remapped together.
    public static func importing(_ data: Data, avoiding workspace: WorkspaceDocument) throws -> Project {
        let raw = try JSONDecoder().decode(JSONObject.self, from: data)
        let occupied = Set(workspace.projects.flatMap(\.panes).flatMap { [$0.id.rawValue] + $0.tabs.map(\.id.rawValue) })
        var replacements: [String: String] = [:]
        for terminal in raw["terminals"]?.arrayValue ?? [] {
            guard let pane = terminal.objectValue else { continue }
            let ids = [pane["id"]?.stringValue].compactMap { $0 }
                + (pane["tabs"]?.arrayValue ?? []).compactMap { $0.objectValue?["id"]?.stringValue }
            for id in ids where occupied.contains(id) { replacements[id] = PaneID.make().rawValue }
        }
        func rewrite(_ value: JSONValue, key: String = "") -> JSONValue {
            switch value {
            case .string(let id) where ["id", "activeTabId", "paneIds", "plannerId"].contains(key):
                return .string(replacements[id] ?? id)
            case .array(let items): return .array(items.map { rewrite($0, key: key) })
            case .object(let object):
                return .object(Dictionary(uniqueKeysWithValues: object.map { field, value in
                    (key == "cells" ? replacements[field] ?? field : field, rewrite(value, key: field))
                }))
            default: return value
            }
        }
        return try decode(JSONEncoder().encode(rewrite(.object(raw))))
    }

    private static let unrestrictedFlags = [
        "claude": "--dangerously-skip-permissions", "codex": "--dangerously-bypass-approvals-and-sandbox",
        "copilot": "--allow-all", "cursor": "--force", "opencode": "--dangerously-skip-permissions",
        "antigravity": "--dangerously-skip-permissions", "kiro": "--trust-all-tools", "kimi": "--yolo", "grok": "--yolo",
    ]

    private static func boolean(_ value: JSONValue?) -> Bool? {
        if case .bool(let result) = value { result } else { nil }
    }

    private static func decodeValue<T: Decodable>(_ value: JSONValue?) -> T? {
        guard let value, let data = try? JSONEncoder().encode(value) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try? decoder.decode(T.self, from: data)
    }

    private static func value<T: Encodable>(_ value: T?) throws -> JSONValue? {
        guard let value else { return nil }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return try JSONDecoder().decode(JSONValue.self, from: encoder.encode(value))
    }
}
