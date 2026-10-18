import Foundation

/// What to run in a new terminal for one agent tab.
public struct AgentLaunchRequest: Sendable {
    public var kind: AgentKind
    public var workingDirectory: String?
    /// Saved extra arguments of the tab (`SubTab.extraArguments`).
    public var extraArguments: [String]
    /// Session to resume, when the tab already owns one.
    public var sessionID: String?
    public var unrestricted: Bool
    /// Hook bridge wiring for this launch (P3-9): Claude's `--settings` file, Codex's `notify`.
    public var hooks: HookLaunch?
    /// MCP servers added to this launch only (P5-4); agents without wiring ignore them.
    public var mcpServers: [McpLaunchServer]
    /// The per-launch file written from `mcpServers` for agents that read one (`McpLaunchConfig.needsFile`):
    /// Claude's `--mcp-config`, OpenCode's `OPENCODE_CONFIG`. Without it those agents get no servers.
    public var mcpConfigPath: String?
    /// Variables added to this launch (9router routing, P7-17), set after the scrubbed ones so they
    /// win over a scrubbed name. Values may be secrets: never log them.
    public var environment: [String: String]

    public struct HookLaunch: Sendable {
        public var claudeSettingsPath: String?
        public var codexArguments: [String]

        public init(claudeSettingsPath: String? = nil, codexArguments: [String] = []) {
            self.claudeSettingsPath = claudeSettingsPath
            self.codexArguments = codexArguments
        }
    }

    public init(kind: AgentKind, workingDirectory: String? = nil, extraArguments: [String] = [],
                sessionID: String? = nil, unrestricted: Bool = false, hooks: HookLaunch? = nil,
                mcpServers: [McpLaunchServer] = [], mcpConfigPath: String? = nil, environment: [String: String] = [:]) {
        self.kind = kind
        self.workingDirectory = workingDirectory
        self.extraArguments = extraArguments
        self.sessionID = sessionID
        self.unrestricted = unrestricted
        self.hooks = hooks
        self.mcpServers = mcpServers
        self.mcpConfigPath = mcpConfigPath
        self.environment = environment
    }
}

/// A launch ready for the PTY host: the line the user's login shell runs (nil = an interactive
/// shell) plus environment changes on top of the terminal's own environment.
public struct AgentCommand: Equatable, Sendable {
    /// Passed to `$SHELL -l -c`; nil opens the login shell itself.
    public var shellCommand: String?
    public var workingDirectory: String?
    /// Variables to set (non-nil) or remove (nil).
    public var environment: [String: String?]
    public var sessionID: String?
    public var createdSession: Bool
    /// Absolute path of the agent CLI, for display and diagnostics.
    public var executable: String?
}

public enum AgentLaunchError: Error, Equatable, Sendable {
    case unknownAgent(String)
    /// The CLI is not installed (or not where we look); `command` is the binary name.
    case launcherNotFound(command: String)
}

/// Turns a request into a command. Upstream: `command_builder_for_terminal` (`cli_resolver.rs`)
/// plus `buildAgentLaunch` and the unrestricted flag from `UNRESTRICTED_FLAG`.
public struct AgentLauncher: Sendable {
    public let registry: AgentRegistry
    public let launchers: LauncherCache
    /// Per-agent CLI path overrides from preferences (`cliPaths`), keyed by agent raw value.
    public var overrides: [String: String]

    public init(registry: AgentRegistry = .builtin, launchers: LauncherCache = LauncherCache(),
                overrides: [String: String] = [:]) {
        self.registry = registry
        self.launchers = launchers
        self.overrides = overrides
    }

    /// Variables a terminal child must not inherit from however Alethe itself was started: editor
    /// hooks (VS Code, git askpass) and a parent Claude Code session. `CLAUDE_CODE_CHILD_SESSION`
    /// matters most: with it, Claude Code stops saving transcripts, so its sessions cannot be resumed.
    public static let scrubbedVariables = [
        "EDITOR", "VISUAL", "TERM_PROGRAM_VERSION",
        "VSCODE_CWD", "VSCODE_IPC_HOOK", "VSCODE_IPC_HOOK_CLI", "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_IPC_HANDLE",
        "GIT_ASKPASS", "ELECTRON_RUN_AS_NODE",
        "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE_PARENT_PID", "CLAUDE_PID",
        "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_EXECPATH",
    ]

    public func command(for request: AgentLaunchRequest,
                        makeSessionID: () -> String = { UUID().uuidString.lowercased() }) throws(AgentLaunchError) -> AgentCommand {
        guard let descriptor = registry.descriptor(for: request.kind) else {
            throw .unknownAgent(request.kind.rawValue)
        }
        var environment: [String: String?] = [:]
        for key in Self.scrubbedVariables { environment[key] = .some(nil) }
        for (key, value) in request.environment { environment[key] = .some(value) }

        guard let cli = descriptor.cliCommand else {
            return AgentCommand(shellCommand: nil, workingDirectory: request.workingDirectory, environment: environment,
                                sessionID: nil, createdSession: false, executable: nil)
        }
        guard let executable = launchers.resolve(cli, override: overrides[request.kind.rawValue]) else {
            throw .launcherNotFound(command: cli)
        }

        var base = descriptor.defaultArguments + request.extraArguments
        if request.unrestricted, let flag = descriptor.unrestrictedFlag, !base.contains(flag) {
            base.append(flag)
        }
        var session = AgentArguments.build(for: request.kind, base: base, sessionID: request.sessionID,
                                           makeSessionID: makeSessionID)
        let mcpFile = request.mcpServers.isEmpty ? nil : request.mcpConfigPath
        switch request.kind {
        case .claude:
            // After the session flags, MCP then settings, as upstream places them. `--mcp-config` is
            // variadic, so the `=` form keeps it from swallowing a positional argument after it.
            var flags = mcpFile.map { ["--mcp-config=\($0)"] } ?? []
            if let path = request.hooks?.claudeSettingsPath { flags += ["--settings", path] }
            session.arguments.insert(contentsOf: flags, at: min(2, session.arguments.count))
        case .codex:
            // Config overrides go before a `resume` subcommand.
            let mcp = McpLaunchConfig.codexArguments(request.mcpServers)
            session.arguments = (request.hooks?.codexArguments ?? []) + mcp + session.arguments
        case .opencode:
            // Merged over the global config, under the project's own `opencode.json`. A user's own
            // OPENCODE_CONFIG is replaced for this launch.
            if let mcpFile { environment["OPENCODE_CONFIG"] = mcpFile }
        default:
            break
        }
        if request.kind == .opencode {
            // OpenTUI's explicit-width probe prints stray bytes in terminals that don't answer it.
            environment["OPENTUI_FORCE_EXPLICIT_WIDTH"] = "false"
        }

        // The CLI's own directory goes first on PATH: npm-installed agents start with
        // `#!/usr/bin/env node`, and that node lives next to them (nvm, fnm, volta…).
        let directory = (executable as NSString).deletingLastPathComponent
        let line = "export PATH=\(Self.quoted(directory)):\"$PATH\"; exec "
            + ([executable] + session.arguments).map(Self.quoted).joined(separator: " ")
        return AgentCommand(shellCommand: line, workingDirectory: request.workingDirectory, environment: environment,
                            sessionID: session.sessionID, createdSession: session.createdSession, executable: executable)
    }

    /// POSIX single-quoting.
    static func quoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
