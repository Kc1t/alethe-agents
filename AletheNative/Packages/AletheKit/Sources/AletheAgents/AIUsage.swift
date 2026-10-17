import Foundation

/// One rate-limit window of a provider (used share, when it resets).
public struct UsageWindow: Hashable, Sendable, Identifiable {
    public var label: String
    /// 0…100.
    public var usedPercent: Double
    public var resetsAt: Date?
    public var id: String { label }

    public init(label: String, usedPercent: Double, resetsAt: Date?) {
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// A reset credit Codex can spend to clear its limit early (upstream `CodexResetCredit`).
public struct CodexResetCredit: Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String
    public var expiresAt: Date?
}

/// What one provider reports (upstream `ClaudeUsage`, `CodexUsage`, `AntigravityUsage`).
public struct ProviderUsage: Hashable, Sendable {
    public enum Status: Hashable, Sendable {
        case ready
        /// No CLI installed.
        case noCLI
        /// Not signed in (no token found).
        case noAuth
        case unavailable(String)
    }

    public var agent: AgentKind
    public var status: Status
    public var windows: [UsageWindow]
    /// Account plan, when the provider tells it (Codex).
    public var plan: String?
    public var rateLimited: Bool
    public var resetCredits: [CodexResetCredit]

    public init(agent: AgentKind, status: Status, windows: [UsageWindow] = [], plan: String? = nil,
                rateLimited: Bool = false, resetCredits: [CodexResetCredit] = []) {
        self.agent = agent
        self.status = status
        self.windows = windows
        self.plan = plan
        self.rateLimited = rateLimited
        self.resetCredits = resetCredits
    }

    /// The most used window: what a toolbar pill shows.
    public var peak: UsageWindow? { windows.max { $0.usedPercent < $1.usedPercent } }
}

public enum AIUsage {
    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// Local credential discovery is independent of the usage endpoint and CLI availability.
    /// Keychain reads never display an authorization prompt during background discovery.
    public static func isAuthenticated(_ provider: AgentKind, homeDirectory: String = NSHomeDirectory()) -> Bool {
        switch provider {
        case .claude:
            return claudeToken(homeDirectory: homeDirectory, allowInteraction: false) != nil || keychainContains(service: "Claude Code-credentials")
        case .codex:
            let home = ProcessInfo.processInfo.environment["CODEX_HOME"] ?? "\(homeDirectory)/.codex"
            guard let data = FileManager.default.contents(atPath: "\(home)/auth.json") else { return false }
            return codexAuthenticated(data)
        case .antigravity: return keychainContains(service: "gemini", account: "antigravity")
        default: return false
        }
    }

    static func codexAuthenticated(_ data: Data) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let tokens = object["tokens"] as? [String: Any] else { return false }
        return ["access_token", "refresh_token"].contains { (tokens[$0] as? String)?.isEmpty == false }
    }

    /// A failed refresh keeps valid figures, but a sign-out clears them.
    public static func retainedReading(previous: ProviderUsage?, fresh: ProviderUsage) -> ProviderUsage {
        if case .unavailable = fresh.status, let previous, previous.status == .ready { return previous }
        return fresh
    }

    public static func showsPill(authenticated: Bool, enabled: Bool) -> Bool { authenticated && enabled }

    // MARK: - Claude Code

    /// `/api/oauth/usage` body: `five_hour`, `seven_day`, `seven_day_opus` windows (upstream
    /// `get_claude_usage`); absent windows are left out.
    public static func parseClaude(_ body: Data) -> ProviderUsage? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        let keys = [("five_hour", "5h"), ("seven_day", "7d"), ("seven_day_opus", "7d Opus")]
        let windows = keys.compactMap { key, label -> UsageWindow? in
            guard let window = object[key] as? [String: Any] else { return nil }
            return UsageWindow(label: label, usedPercent: (window["utilization"] as? NSNumber)?.doubleValue ?? 0,
                               resetsAt: date(window["resets_at"]))
        }
        return ProviderUsage(agent: .claude, status: .ready, windows: windows,
                             rateLimited: windows.contains { $0.usedPercent >= 100 })
    }

    /// Claude Code's OAuth token: `CLAUDE_OAUTH_TOKEN`, `~/.claude/.credentials.json`, then the
    /// Keychain item Claude Code writes (upstream `discover_token`). Never logged.
    public static func claudeToken(homeDirectory: String = NSHomeDirectory(), allowInteraction: Bool = true) -> String? {
        if let token = ProcessInfo.processInfo.environment["CLAUDE_OAUTH_TOKEN"], !token.isEmpty { return token }
        if let data = FileManager.default.contents(atPath: "\(homeDirectory)/.claude/.credentials.json"),
           let value = claudeCredential(data), value.expiresAt.map({ $0 > Date() }) ?? true { return value.token }
        return credentialCache.token(key: "claude:\(homeDirectory)", allowInteraction: allowInteraction,
                                     local: { nil }, secret: {
            keychainSecret(service: "Claude Code-credentials").flatMap(claudeCredential)
        })
    }

    private static let credentialCache = UsageCredentialCache()

    /// Call after an explicit reconnect/login action to permit credential discovery again.
    public static func reconnectCredentials() { credentialCache.reconnect() }

    static func claudeCredential(_ data: Data) -> UsageCredentialCache.Credential? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let oauth = object["claudeAiOauth"] as? [String: Any],
              let token = oauth["accessToken"] as? String, !token.isEmpty else { return nil }
        // Claude Code stores expiresAt as Unix milliseconds.
        let expiry = (oauth["expiresAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
            ?? date(oauth["expiresAt"])
        return .init(token: token, expiresAt: expiry)
    }

    static func claudeToken(fromSecret data: Data) -> String? {
        claudeCredential(data)?.token
    }

    public static func claude(session: URLSession = .shared) async -> ProviderUsage {
        await claudeUsage(discover: { claudeToken() }, refresh: { token, status in
            credentialCache.reject(key: "claude:\(NSHomeDirectory())", token: token, status: status)
        }, fetch: { token in
            var request = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!, timeoutInterval: 15)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
            guard let (data, response) = try? await session.data(for: request) else { return nil }
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        })
    }

    static func claudeUsage(discover: () -> String?, refresh: (String, Int) -> Bool,
                            fetch: (String) async -> (Data, Int)?) async -> ProviderUsage {
        for attempt in 0..<2 {
            guard let token = discover() else { return ProviderUsage(agent: .claude, status: .noAuth) }
            guard let (data, status) = await fetch(token) else {
                return ProviderUsage(agent: .claude, status: .unavailable("network"))
            }
            if status == 401 || status == 403 {
                if attempt == 0, refresh(token, status) { continue }
                return ProviderUsage(agent: .claude, status: .noAuth)
            }
            guard status == 200 else { return ProviderUsage(agent: .claude, status: .unavailable("HTTP \(status)")) }
            return parseClaude(data) ?? ProviderUsage(agent: .claude, status: .unavailable("format"))
        }
        return ProviderUsage(agent: .claude, status: .noAuth)
    }

    // MARK: - Codex

    /// The `account/rateLimits/read` result of `codex app-server` (upstream `fetch_usage`).
    public static func parseCodex(_ result: [String: Any]) -> ProviderUsage? {
        guard let limits = result["rateLimits"] as? [String: Any] else { return nil }
        func window(_ key: String) -> UsageWindow? {
            guard let window = limits[key] as? [String: Any] else { return nil }
            let minutes = (window["windowDurationMins"] as? NSNumber)?.intValue ?? 0
            let label = minutes >= 1440 ? "\(minutes / 1440)d" : minutes >= 60 ? "\(minutes / 60)h" : "\(minutes)m"
            return UsageWindow(label: label, usedPercent: (window["usedPercent"] as? NSNumber)?.doubleValue ?? 0,
                               resetsAt: (window["resetsAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) })
        }
        let credits = ((result["rateLimitResetCredits"] as? [String: Any])?["credits"] as? [[String: Any]] ?? [])
            .filter { $0["status"] as? String == "available" }
            .compactMap { credit -> CodexResetCredit? in
                guard let id = credit["id"] as? String else { return nil }
                return CodexResetCredit(id: id, title: credit["title"] as? String ?? "", detail: credit["description"] as? String ?? "",
                                        expiresAt: (credit["expiresAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) })
            }
        let plan = (limits["planType"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return ProviderUsage(agent: .codex, status: .ready, windows: [window("primary"), window("secondary")].compactMap { $0 },
                             plan: plan, rateLimited: !(limits["rateLimitReachedType"] is NSNull) && limits["rateLimitReachedType"] != nil,
                             resetCredits: credits)
    }

    /// One JSON-RPC exchange with `codex app-server`: initialize, then `method`, answering with its
    /// result (12 s at most).
    static func codexRPC(_ executable: String, method: String, params: [String: Any]? = nil) async -> [String: Any]? {
        var call: [String: Any] = ["id": 2, "method": method]
        if let params { call["params"] = params }
        let lines = [
            ["id": 1, "method": "initialize", "params": ["clientInfo": ["name": "alethe", "version": "1.0"]]],
            ["method": "initialized"], call,
        ].compactMap { try? JSONSerialization.data(withJSONObject: $0) }
        let result = await Task.detached { () -> Data? in
            let process = Process()
            process.executableURL = URL(filePath: executable)
            process.arguments = ["app-server"]
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = (executable as NSString).deletingLastPathComponent + ":" + (environment["PATH"] ?? "")
            process.environment = environment
            let input = Pipe(), output = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            guard (try? process.run()) != nil else { return nil }
            defer { if process.isRunning { process.terminate() } }
            // A silent server must not hold the read forever: ending it closes the pipe.
            let watchdog = Task.detached {
                try? await Task.sleep(for: .seconds(12))
                if process.isRunning { process.terminate() }
            }
            defer { watchdog.cancel() }
            for line in lines { input.fileHandleForWriting.write(line + Data("\n".utf8)) }
            let deadline = Date().addingTimeInterval(12)
            var buffer = Data()
            let reader = output.fileHandleForReading
            while Date() < deadline {
                let chunk = reader.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer.removeSubrange(buffer.startIndex...newline)
                    if let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                       (message["id"] as? NSNumber)?.intValue == 2 {
                        return (message["result"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
                    }
                }
            }
            return nil
        }.value
        return result.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
    }

    public static func codex(executable: String?) async -> ProviderUsage {
        guard let executable else { return ProviderUsage(agent: .codex, status: .noCLI) }
        guard let result = await codexRPC(executable, method: "account/rateLimits/read") else {
            return ProviderUsage(agent: .codex, status: .unavailable("codex app-server"))
        }
        return parseCodex(result) ?? ProviderUsage(agent: .codex, status: .noAuth)
    }

    /// Spends a reset credit (upstream `consume_codex_reset_credit`); answers the usage after it.
    public static func consumeCodexResetCredit(executable: String, credit: String?) async -> ProviderUsage? {
        var params: [String: Any] = ["idempotencyKey": UUID().uuidString]
        if let credit, !credit.isEmpty { params["creditId"] = credit }
        guard await codexRPC(executable, method: "account/rateLimitResetCredit/consume", params: params) != nil else { return nil }
        return await codex(executable: executable)
    }

    // MARK: - Antigravity

    /// Quota buckets from `fetchAvailableModels`: models sharing a remaining fraction and reset time
    /// are one bucket, named after their family (upstream `parse_usage`).
    public static func parseAntigravity(_ body: Data) -> ProviderUsage? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let models = object["models"] as? [String: [String: Any]] else { return nil }
        struct Key: Hashable { var remaining: Int; var reset: String }
        var groups: [Key: Set<String>] = [:]
        for (id, model) in models {
            guard let quota = model["quotaInfo"] as? [String: Any],
                  let remaining = (quota["remainingFraction"] as? NSNumber)?.doubleValue else { continue }
            let name = (model["displayName"] as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? id
            let key = Key(remaining: Int((min(max(remaining, 0), 1) * 1_000_000).rounded()), reset: quota["resetTime"] as? String ?? "")
            groups[key, default: []].insert(name.trimmingCharacters(in: .whitespaces))
        }
        guard !groups.isEmpty else { return nil }
        let windows = groups.map { key, names -> UsageWindow in
            let lower = names.map { $0.lowercased() }
            let label = lower.allSatisfy { $0.contains("gemini") } ? "Gemini"
                : lower.allSatisfy { $0.contains("claude") } ? "Claude"
                : lower.allSatisfy { $0.contains("gpt") } ? "GPT" : names.sorted().first ?? "Other"
            return UsageWindow(label: label, usedPercent: min(max(100 - Double(key.remaining) / 10_000, 0), 100),
                               resetsAt: date(key.reset))
        }
        .sorted { $0.usedPercent != $1.usedPercent ? $0.usedPercent > $1.usedPercent : $0.label < $1.label }
        return ProviderUsage(agent: .antigravity, status: .ready, windows: windows,
                             rateLimited: (windows.first?.usedPercent ?? 0) >= 99.9)
    }

    static func antigravityToken() -> String? {
        credentialCache.token(key: "antigravity", local: { nil }, secret: {
            guard let secret = keychainSecret(service: "gemini", account: "antigravity"),
                  let object = (try? JSONSerialization.jsonObject(with: secret)) as? [String: Any],
                  let oauth = object["token"] as? [String: Any],
                  let token = oauth["access_token"] as? String, !token.isEmpty else { return nil }
            let expiry = (oauth["expires_at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
            return .init(token: token, expiresAt: expiry)
        })
    }

    public static func antigravity(executable: String?, session: URLSession = .shared) async -> ProviderUsage {
        guard let executable else { return ProviderUsage(agent: .antigravity, status: .noCLI) }
        func fetch(_ token: String) async -> (Data, Int)? {
            var request = URLRequest(url: URL(string: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")!,
                                     timeoutInterval: 15)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
            guard let (data, response) = try? await session.data(for: request) else { return nil }
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        guard var token = antigravityToken() else { return ProviderUsage(agent: .antigravity, status: .noAuth) }
        var answer = await fetch(token)
        if let status = answer?.1, credentialCache.reject(key: "antigravity", token: token, status: status) {
            // `agy models` refreshes the stored credential (upstream `refresh_credential_with_agy`).
            _ = await CLIOutput.run(executable, ["models"], timeout: .seconds(12))
            guard let fresh = antigravityToken() else { return ProviderUsage(agent: .antigravity, status: .noAuth) }
            token = fresh
            answer = await fetch(token)
        }
        guard let (data, status) = answer else { return ProviderUsage(agent: .antigravity, status: .unavailable("network")) }
        if status == 401 || status == 403 { return ProviderUsage(agent: .antigravity, status: .noAuth) }
        guard status == 200 else { return ProviderUsage(agent: .antigravity, status: .unavailable("HTTP \(status)")) }
        return parseAntigravity(data) ?? ProviderUsage(agent: .antigravity, status: .unavailable("format"))
    }

    // MARK: - Keychain

    /// Attribute-only discovery never requests access to the secret.
    static func keychainContains(service: String, account: String? = nil) -> Bool {
        UsageKeychainReader().contains(service: service, account: account)
    }

    static func keychainSecret(service: String, account: String? = nil, allowInteraction: Bool = true) -> Data? {
        guard allowInteraction else { return nil }
        return UsageKeychainReader().read(service: service, account: account)
    }

    // MARK: - Limit resets

    /// Windows that were at their limit before and have reset since (upstream `limitResetWatch`).
    public static func resets(from previous: ProviderUsage, to current: ProviderUsage, now: Date = Date()) -> [UsageWindow] {
        current.windows.filter { window in
            guard let before = previous.windows.first(where: { $0.label == window.label }), before.usedPercent >= 99.9 else { return false }
            let passed = before.resetsAt.map { $0 <= now } ?? false
            return window.usedPercent < before.usedPercent && (passed || window.usedPercent < 50)
        }
    }
}
