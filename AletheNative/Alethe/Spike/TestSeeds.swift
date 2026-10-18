#if DEBUG
import AletheModel
import AppKit
import Foundation

/// Sample workspaces for UI tests (`-AletheUITestSeed <name>`); applied only to an empty workspace.
enum TestSeeds {
    static func apply(_ name: String, to doc: inout WorkspaceDocument) {
        switch name {
        case "sidebar":
            let work = doc.addGroup(name: "Work", color: .purple)
            let clients = doc.addGroup(name: "Clients", parent: work)
            doc.addProject(name: "alpha", folder: "/private/tmp", color: .orange, in: .group(work))
            doc.addProject(name: "beta", folder: "/private/tmp", color: .blue, in: .group(work))
            doc.addProject(name: "client-site", folder: "/private/tmp", color: .teal, in: .group(clients))
            doc.addProject(name: "scratch", folder: "/private/tmp", color: .pink)
        case "cliOpen":
            // Two projects in their own folders inside the throwaway data root, neither shown (P5-8).
            let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
            for name in ["api", "web"] {
                let folder = URL(filePath: root).appending(path: name)
                try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                doc.addProject(name: name, folder: folder.path, color: .teal)
            }
        case "terminals":
            let project = doc.addProject(name: "scratch", folder: "/private/tmp", color: .pink)
            doc.addPane(to: project, tab: PaneTab(agent: "claude"))
        case "panes":
            let api = doc.addProject(name: "api", folder: "/private/tmp", color: .orange)
            let web = doc.addProject(name: "web", folder: "/private/tmp", color: .teal)
            for title in ["one", "two", "three"] { doc.addPane(to: api, tab: PaneTab(agent: "shell", title: title)) }
            doc.addPane(to: web, tab: PaneTab(agent: "shell", title: "four"))
        case "grid":
            // Three panes in a 2×2 custom grid: one, two on top, three below with a free slot beside it.
            let api = doc.addProject(name: "api", folder: "/private/tmp", color: .orange)
            let panes = ["one", "two", "three"].compactMap { doc.addPane(to: api, tab: PaneTab(agent: "shell", title: $0)) }
            doc.setGridLayout(.auto(panes.map(\.rawValue)), for: api)
        case "subtabs":
            let project = doc.addProject(name: "scratch", folder: "/private/tmp", color: .pink)
            let pane = doc.addPane(to: project, tab: PaneTab(agent: "shell", title: "one"))
            if let pane { doc.addTab(PaneTab(agent: "shell", title: "two"), to: pane) }
        case "markdown":
            // A README inside the throwaway data root, so the test never touches real files.
            let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
            let file = URL(filePath: root).appending(path: "README.md")
            try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
            try? Data("# Seeded\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n".utf8).write(to: file)
            let project = doc.addProject(name: "docs", folder: root, color: .teal)
            doc.addPane(to: project, content: .markdown(path: file.path))
        case "media":
            // A 64×64 PNG inside the throwaway data root.
            let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
            let file = URL(filePath: root).appending(path: "shot.png")
            try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
            if let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8,
                                          samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                          colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) {
                try? rep.representation(using: .png, properties: [:])?.write(to: file)
            }
            let project = doc.addProject(name: "media", folder: root, color: .orange)
            doc.addPane(to: project, content: .image(path: file.path))
        case "diff":
            // A throwaway repository with one uncommitted change.
            let repo = seedRepository()
            let project = doc.addProject(name: "repo", folder: repo.path, color: .green)
            doc.addPane(to: project, content: .diff(path: nil, staged: false))
        case "git":
            // The same repository plus an untracked file, for Git Control (P4-5).
            let repo = seedRepository()
            try? Data("draft\n".utf8).write(to: repo.appending(path: "draft.txt"))
            _ = doc.addProject(name: "repo", folder: repo.path, color: .green)
        case "worktrees":
            // A throwaway repository with one locked agent worktree (P4-9).
            let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
            let repo = URL(filePath: root).appending(path: "wtrepo")
            try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
            try? Data("seed\n".utf8).write(to: repo.appending(path: "README.md"))
            let worktree = repo.appending(path: ".alethe/worktrees/seed").path
            for arguments in [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "seed"],
                              ["worktree", "add", "-q", "-b", "alethe/agent-seed", worktree, "HEAD"],
                              ["worktree", "lock", "--reason", "seeded", worktree]] {
                let git = Process()
                git.executableURL = URL(filePath: "/usr/bin/git")
                git.arguments = ["-C", repo.path, "-c", "user.name=seed", "-c", "user.email=seed@local",
                                 "-c", "commit.gpgsign=false"] + arguments
                try? git.run()
                git.waitUntilExit()
            }
            _ = doc.addProject(name: "wtrepo", folder: repo.path, color: .green)
        case "clone":
            // A local bare repository (`origin.git` in the data root) to clone from (P5-5).
            let repo = seedRepository()
            let bare = repo.deletingLastPathComponent().appending(path: "origin.git")
            let git = Process()
            git.executableURL = URL(filePath: "/usr/bin/git")
            git.arguments = ["clone", "-q", "--bare", "--", repo.path, bare.path]
            try? git.run()
            git.waitUntilExit()
            _ = doc.addProject(name: "repo", folder: repo.path, color: .green)
        case "agentLibrary":
            // A project in the data root whose `.claude/agents` holds one agent Alethe did not write (P5-16).
            let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
            let folder = URL(filePath: root).appending(path: "agentsproj")
            let agents = folder.appending(path: ".claude/agents")
            try? FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
            try? Data("---\nname: mine\ndescription: My own agent.\n---\n".utf8).write(to: agents.appending(path: "mine.md"))
            _ = doc.addProject(name: "agentsproj", folder: folder.path, color: .purple)
        case "web":
            // Port 9 (discard) is closed on a Mac: the page fails fast without touching the network.
            let project = doc.addProject(name: "site", folder: "/private/tmp", color: .blue)
            doc.addPane(to: project, content: .web(url: "http://127.0.0.1:9/", options: WebPaneOptions()))
        case "graphify":
            // A repository with a Graphify graph and one older, smaller snapshot; no pane yet (P5-23).
            let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
            let repo = URL(filePath: root).appending(path: "graphrepo")
            let graph = #"{"nodes":[{"id":"alpha","label":"alpha","source_file":"README.md","community":0},{"id":"beta","label":"beta","community":0},{"id":"delta","label":"delta","community":1},{"id":"epsilon","label":"epsilon","community":1}],"edges":[{"source":"alpha","target":"beta"},{"source":"beta","target":"delta"},{"source":"delta","target":"epsilon"}]}"#
            let older = #"{"nodes":[{"id":"alpha"},{"id":"beta"}],"edges":[{"source":"alpha","target":"beta"}]}"#
            for folder in [".git", "graphify-out", ".alethe/graph-snapshots"] {
                try? FileManager.default.createDirectory(at: repo.appending(path: folder), withIntermediateDirectories: true)
            }
            try? Data("# Graph\n".utf8).write(to: repo.appending(path: "README.md"))
            try? Data(graph.utf8).write(to: repo.appending(path: "graphify-out/graph.json"))
            try? Data(older.utf8).write(to: repo.appending(path: ".alethe/graph-snapshots/1750000000000.json"))
            _ = doc.addProject(name: "graphrepo", folder: repo.path, color: .purple)
        case "orchestrator":
            // One project, no panes; the orchestrator feature is turned on below (P6-13).
            doc.addProject(name: "scratch", folder: "/private/tmp", color: .pink)
        case "orchestratorBoard", "orchestratorLarge":
            // A board beside a disabled Claude Code planner tab (`tab-lead`), over a jobs file in the
            // profile: the core restores it on first use (P6-14).
            let folder = seedOrchestratorJobs(large: name == "orchestratorLarge")
            let project = doc.addProject(name: "board", folder: folder.path, color: .purple)
            if let pane = doc.addPane(to: project, tab: PaneTab(id: TabID(rawValue: "tab-lead"), agent: "claude", title: "lead")) {
                doc.setDisabled(pane, true)
            }
            doc.addPane(to: project, content: .orchestrator)
            doc.workspace.selectedProjectID = project
        case orchestratorWorker:
            seedOrchestratorWorker(into: &doc)
        case "orchestratorApply":
            // A done worker whose worktree holds one uncommitted file, beside its disabled planner
            // tab (`tab-lead`): applying it merges cleanly into `main` (P6-16).
            let folder = seedApplyRepository()
            let project = doc.addProject(name: "applyrepo", folder: folder.path, color: .purple)
            if let pane = doc.addPane(to: project, tab: PaneTab(id: TabID(rawValue: "tab-lead"), agent: "claude", title: "lead")) {
                doc.setDisabled(pane, true)
            }
            doc.addPane(to: project, content: .orchestrator)
            doc.workspace.selectedProjectID = project
        case "skills":
            seedSkills()
        case "gsdSync":
            // A repository with a GSD Sync child session mid-planning, in a project holding a disabled
            // OpenCode tab: GSD Sync is available without spawning OpenCode (P5-24).
            let repo = seedPlanningRepository()
            let project = doc.addProject(name: "gsdproj", folder: repo.path, color: .purple)
            if let pane = doc.addPane(to: project, tab: PaneTab(agent: "opencode")) { doc.setDisabled(pane, true) }
            doc.workspace.selectedProjectID = project
        case "mcp":
            seedMcp()
        case "multiagent", "multiagentLive":
            // A committed `.planning/` roadmap with one of three items done (P6-22); the live variant
            // keeps changing `.planning/notes.md`, as an agent would, so autocommit has work.
            let repo = seedSchedulerRepository()
            doc.addProject(name: "agentrepo", folder: repo.path, color: .purple)
            if name == "multiagentLive" { touchPlanningPeriodically(in: repo) }
        case "prompt":
            // Folder from -AletheUITestFolder (a folder the agent already trusts).
            let folder = UserDefaults.standard.string(forKey: "AletheUITestFolder") ?? "/private/tmp"
            let project = doc.addProject(name: "prompted", folder: folder, color: .purple)
            doc.addPane(to: project, tab: PaneTab(agent: "claude", initialPrompt: "/help"))
        default:
            seedRemote(name, into: &doc)
            seedDiscord(name, into: &doc)
            seedSpotify(name, into: &doc)
            seedGistSync(name, into: &doc)
            seedRouter9(name, into: &doc)
        }
    }

    /// Preferences a seed needs (applied with the workspace seed).
    static func apply(_ name: String, to preferences: inout PreferencesDocument) {
        if let style = UserDefaults.standard.string(forKey: "AletheUITestVisualStyle") { preferences.visualStyle = style }
        if let theme = UserDefaults.standard.string(forKey: "AletheUITestTheme") { preferences.themeID = theme }
        switch name {
        case "gsdSync":
            preferences.features.set(.gsdSync, on: true)
        case orchestratorWorker:
            seedOrchestratorWorker(into: &preferences)
        case "orchestrator", "orchestratorBoard", "orchestratorLarge", "orchestratorApply", "multiagent", "multiagentLive":
            preferences.features.set(.orchestrator, on: true)
        default:
            seedRemote(name, into: &preferences)
            seedDiscord(name, into: &preferences)
            seedSpotify(name, into: &preferences)
            seedGistSync(name, into: &preferences)
            seedRouter9(name, into: &preferences)
        }
    }

    /// What a seed sets up in the running app once the peripheral controllers started (Phase 7).
    /// Unlike the document seeds it runs on every launch with the seed, since Keychain items of a
    /// test launch live in memory only.
    @MainActor
    static func apply(_ name: String, to environment: AppEnvironment) {
        seedRemote(name, environment: environment)
        seedDiscord(name, environment: environment)
        seedSpotify(name, environment: environment)
        seedGistSync(name, environment: environment)
        seedRouter9(name, environment: environment)
    }

    /// `boardrepo` in the data root and `profiles/default/orchestrator-jobs.json` (upstream's v2
    /// shape). The small board: planner `tab-lead` with run-01 (done, failed, interrupted workers)
    /// and run-02 (one done worker in a worktree), plus run-03 delegated from outside a terminal.
    /// The large one: 100 workers in five runs under `tab-lead`.
    private static func seedOrchestratorJobs(large: Bool) -> URL {
        let root = URL(filePath: UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp")
        let folder = root.appending(path: "boardrepo")
        let profile = root.appending(path: "profiles/default")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        let start: UInt64 = 1_750_000_000_000
        func job(_ id: Int, run: Int, label: String, planner: String?, agent: String = "codex", status: String,
                 summary: String = "", extra: [String: Any] = [:]) -> [String: Any] {
            var record: [String: Any] = [
                "id": String(format: "job-%02d", id), "agent": agent, "runId": String(format: "run-%02d", run),
                "runLabel": label, "spec": "Task \(id)", "cwd": folder.path, "status": status,
                "plan": [String](), "summary": summary, "approvalPolicy": "\"never\"", "sandbox": "workspace-write",
                "webSearch": false, "startedAt": start, "endedAt": start + UInt64(40_000 + id * 1000),
            ]
            if let planner { record["plannerId"] = planner }
            return record.merging(extra) { _, new in new }
        }
        var jobs: [[String: Any]] = []
        if large {
            for id in 1...100 {
                let run = (id - 1) / 20 + 1
                jobs.append(job(id, run: run, label: "Batch \(run)", planner: "tab-lead",
                                status: id % 7 == 0 ? "failed" : "done", summary: "Worker \(id) finished.\nAll good."))
            }
        } else {
            jobs = [
                job(1, run: 1, label: "Refactor parser", planner: "tab-lead", status: "done",
                    summary: "Split the parser into modules.\nAll tests pass.",
                    extra: ["plan": ["Read the parser", "Split it"],
                            "tokens": ["total": ["totalTokens": 12_345], "modelContextWindow": 200_000]]),
                job(2, run: 1, label: "Refactor parser", planner: "tab-lead", agent: "claude", status: "failed",
                    extra: ["outcome": "the worker exited with status 1"]),
                job(3, run: 1, label: "Refactor parser", planner: "tab-lead", status: "running",
                    extra: ["threadId": "thread-3"]),
                job(4, run: 2, label: "Docs", planner: "tab-lead", agent: "claude", status: "done",
                    summary: "Docs updated.", extra: ["worktree": folder.appending(path: ".alethe/worktrees/job-04").path]),
                job(5, run: 3, label: "Outside", planner: nil, status: "done", summary: "Done from outside."),
            ]
        }
        let file: [String: Any] = [
            "version": 2,
            "jobs": jobs,
            "planners": [["id": "tab-lead", "label": "lead", "agent": "claude"]],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: file) {
            try? data.write(to: profile.appending(path: "orchestrator-jobs.json"))
        }
        return folder
    }

    /// `applyrepo` in the data root: `main` with one commit (local identity, no global config needed)
    /// and job `job-01`'s worktree on `alethe/agent-job-01` holding an uncommitted `feature.txt`;
    /// the profile's jobs file has that job done under planner `tab-lead`.
    private static func seedApplyRepository() -> URL {
        let root = URL(filePath: UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp")
        let repo = root.appending(path: "applyrepo")
        let profile = root.appending(path: "profiles/default")
        let worktree = repo.appending(path: ".alethe/worktrees/job-01")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try? Data("seed\n".utf8).write(to: repo.appending(path: "README.md"))
        for arguments in [["init", "-q", "-b", "main"], ["config", "user.name", "seed"],
                          ["config", "user.email", "seed@local"], ["config", "commit.gpgsign", "false"],
                          ["add", "."], ["commit", "-q", "-m", "seed"],
                          ["worktree", "add", "-q", "-b", "alethe/agent-job-01", worktree.path, "HEAD"]] {
            let git = Process()
            git.executableURL = URL(filePath: "/usr/bin/git")
            git.arguments = ["-C", repo.path] + arguments
            try? git.run()
            git.waitUntilExit()
        }
        try? Data("from the worker\n".utf8).write(to: worktree.appending(path: "feature.txt"))
        let start: UInt64 = 1_750_000_000_000
        let job: [String: Any] = [
            "id": "job-01", "agent": "codex", "runId": "run-01", "runLabel": "Feature", "spec": "Add the feature",
            "cwd": repo.path, "status": "done", "plan": [String](), "summary": "Added feature.txt.",
            "approvalPolicy": "\"never\"", "sandbox": "workspace-write", "webSearch": false,
            "startedAt": start, "endedAt": start + 30_000, "plannerId": "tab-lead", "worktree": worktree.path,
        ]
        let file: [String: Any] = [
            "version": 2, "jobs": [job], "planners": [["id": "tab-lead", "label": "lead", "agent": "claude"]],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: file) {
            try? data.write(to: profile.appending(path: "orchestrator-jobs.json"))
        }
        return repo
    }

    /// `gsdrepo` in the data root: a repository whose `.planning/` has a busy child session, a
    /// status and a three-item roadmap with one item checked.
    private static func seedPlanningRepository() -> URL {
        let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
        let repo = URL(filePath: root).appending(path: "gsdrepo")
        let planning = repo.appending(path: ".planning")
        try? FileManager.default.createDirectory(at: planning, withIntermediateDirectories: true)
        let git = Process()
        git.executableURL = URL(filePath: "/usr/bin/git")
        git.arguments = ["-C", repo.path, "init", "-q"]
        try? git.run()
        git.waitUntilExit()
        let files = [
            ".gsd-child-session": "ses_seededchild\n",
            ".gsd-child-busy": "",
            "status.md": "Status: In Progress\nProgress: 40%\n",
            "task.md": "- [x] Map the API\n- [ ] Write the client\n- [ ] Ship it\n",
            "plan.md": "# Plan\n\n1. Map the API\n",
        ]
        for (name, text) in files { try? Data(text.utf8).write(to: planning.appending(path: name)) }
        return repo
    }

    /// `agentrepo` in the data root: `.planning/task.md` (1 of 3 checked) committed as an audit commit,
    /// with a local identity so later audit commits need no global git config.
    private static func seedSchedulerRepository() -> URL {
        let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
        let repo = URL(filePath: root).appending(path: "agentrepo")
        let planning = repo.appending(path: ".planning")
        try? FileManager.default.createDirectory(at: planning, withIntermediateDirectories: true)
        try? Data("- [x] Map the API\n- [ ] Write the client\n- [ ] Ship it\n".utf8)
            .write(to: planning.appending(path: "task.md"))
        try? Data("# Plan\n".utf8).write(to: planning.appending(path: "plan.md"))
        for arguments in [["init", "-q", "-b", "main"], ["config", "user.name", "seed"], ["config", "user.email", "seed@local"],
                          ["config", "commit.gpgsign", "false"], ["add", "."],
                          ["commit", "-q", "-m", "gsd(alethe): seed", "-m", "Alethe-Agent: seed"]] {
            let git = Process()
            git.executableURL = URL(filePath: "/usr/bin/git")
            git.arguments = ["-C", repo.path] + arguments
            try? git.run()
            git.waitUntilExit()
        }
        return repo
    }

    /// Appends to `.planning/notes.md` every 3 s for five minutes.
    private static func touchPlanningPeriodically(in repo: URL) {
        let notes = repo.appending(path: ".planning/notes.md")
        Task.detached(priority: .utility) {
            for tick in 0..<100 {
                try? await Task.sleep(for: .seconds(3))
                let line = "tick \(tick)\n"
                if let handle = try? FileHandle(forWritingTo: notes) {
                    handle.seekToEndOfFile()
                    handle.write(Data(line.utf8))
                    try? handle.close()
                } else {
                    try? Data(line.utf8).write(to: notes)
                }
            }
        }
    }

    /// Skills in the `-AletheIntegrationsHome` folder (P5-15): `brand` in the shared store linked
    /// from Claude Code, `motion` only in Claude Code, and Codex's bundled `imagegen`.
    private static func seedSkills() {
        guard let home = UserDefaults.standard.string(forKey: "AletheIntegrationsHome") else { return }
        let root = URL(filePath: home, directoryHint: .isDirectory)
        func skill(_ path: String, _ text: String) -> URL {
            let dir = root.appending(path: path, directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? Data(text.utf8).write(to: dir.appending(path: "SKILL.md"))
            return dir
        }
        let brand = skill(".agents/skills/brand", "---\nname: brand\ndescription: Brand system\n---\n\n# Brand\n\nUse the palette.\n")
        try? FileManager.default.createDirectory(at: root.appending(path: ".claude/skills"), withIntermediateDirectories: true)
        try? FileManager.default.createSymbolicLink(at: root.appending(path: ".claude/skills/brand"), withDestinationURL: brand)
        let motion = skill(".claude/skills/motion", "---\nname: motion\ndescription: >\n  Creates motion\n  graphics\n---\n\n# Motion guide\n")
        try? FileManager.default.createDirectory(at: motion.appending(path: "references"), withIntermediateDirectories: true)
        try? Data("notes".utf8).write(to: motion.appending(path: "references/timing.md"))
        _ = skill(".codex/skills/.system/imagegen", "---\ndescription: Generates images\n---\n\n# Images\n")
    }

    /// MCP configs in the `-AletheIntegrationsHome` folder (P5-25): Claude Code's `alpha` with a secret
    /// env value, Codex's `beta`, an empty Cursor config, and the folders the other agents write to.
    private static func seedMcp() {
        guard let home = UserDefaults.standard.string(forKey: "AletheIntegrationsHome") else { return }
        let root = URL(filePath: home, directoryHint: .isDirectory)
        func write(_ path: String, _ text: String) {
            let file = root.appending(path: path)
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data(text.utf8).write(to: file)
        }
        write(".claude.json", """
            {"mcpServers": {"alpha": {"type": "stdio", "command": "npx", "args": ["-y", "alpha-mcp"],
              "env": {"API_KEY": "sk-test-0123456789abcd"}}}}
            """)
        write(".codex/config.toml", "[mcp_servers.beta]\ncommand = \"uvx\"\nargs = [\"beta-mcp\"]\n")
        write(".cursor/mcp.json", "{\"mcpServers\": {}}\n")
        for folder in [".config/opencode", ".gemini/config"] {
            try? FileManager.default.createDirectory(at: root.appending(path: folder), withIntermediateDirectories: true)
        }
    }

    /// `repo` in the data root: `notes.txt` committed on `main`, then modified in the worktree.
    private static func seedRepository() -> URL {
        let root = UserDefaults.standard.string(forKey: "AletheDataRoot") ?? "/private/tmp"
        let repo = URL(filePath: root).appending(path: "repo")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let file = repo.appending(path: "notes.txt")
        try? Data("alpha\nbeta\n".utf8).write(to: file)
        for arguments in [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "seed"]] {
            let git = Process()
            git.executableURL = URL(filePath: "/usr/bin/git")
            git.arguments = ["-C", repo.path, "-c", "user.name=seed", "-c", "user.email=seed@local",
                             "-c", "commit.gpgsign=false"] + arguments
            try? git.run()
            git.waitUntilExit()
        }
        try? Data("alpha\nbeta two\ngamma\n".utf8).write(to: file)
        return repo
    }
}
#endif
