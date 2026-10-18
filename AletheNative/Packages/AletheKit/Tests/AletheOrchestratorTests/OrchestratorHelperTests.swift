import Foundation
import Testing
import AletheAgents
import AletheIntegrations
@testable import AletheOrchestrator

/// The `alethe-orchestrator-mcp` helper (P6-10): bridge framing, the stdio loop, the standalone
/// setup and handshake, Codex planner wiring, and the built binary against a stub endpoint.
@Suite(.timeLimit(.minutes(1))) struct OrchestratorHelperTests {
    // MARK: Bridge

    private actor Posts {
        var bodies: [String] = []
        func add(_ body: Data) { bodies.append(String(decoding: body, as: UTF8.self)) }
    }

    private func bridge(status: Int = 200, reply: String = "", posts: Posts) -> OrchestratorBridge {
        OrchestratorBridge { body in
            await posts.add(body)
            return (status, Data(reply.utf8))
        }
    }

    @Test func aRequestIsForwardedAndItsAnswerIsOneLine() async throws {
        let posts = Posts()
        let pretty = "{\n  \"jsonrpc\": \"2.0\",\n  \"id\": 7,\n  \"result\": {}\n}\n"
        let line = await bridge(reply: pretty, posts: posts).handle(line: #"  {"jsonrpc":"2.0","id":7,"method":"ping"}  "#)
        #expect(line == #"{"jsonrpc":"2.0","id":7,"result":{}}"#)
        #expect(await posts.bodies == [#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#])

        let compact = #"{"jsonrpc":"2.0","id":"a","result":{"tools":[]}}"#
        #expect(await bridge(reply: compact + "\n", posts: posts).handle(line: #"{"jsonrpc":"2.0","id":"a","method":"tools/list"}"#) == compact)
    }

    @Test func aNotificationIsForwardedButGetsNoLine() async {
        let posts = Posts()
        let line = await bridge(status: 202, posts: posts).handle(line: #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        #expect(line == nil)
        #expect(await posts.bodies.count == 1)
    }

    @Test func blankAndNonJSONLinesAreNotPosted() async {
        let posts = Posts()
        let bridge = bridge(posts: posts)
        #expect(await bridge.handle(line: "   ") == nil)
        #expect(await bridge.handle(line: "not json") == nil)
        #expect(await bridge.handle(line: "[1,2]") == nil)
        #expect(await posts.bodies.isEmpty)
    }

    @Test func aFailedPostAnswersTheRequestWithAnError() async throws {
        let unreachable = OrchestratorBridge { _ in throw URLError(.cannotConnectToHost) }
        let error = try errorObject(await unreachable.handle(line: #"{"jsonrpc":"2.0","id":3,"method":"ping"}"#))
        #expect(error.id == 3 && error.code == OrchestratorBridge.unavailableCode)
        #expect(await unreachable.handle(line: #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#) == nil)

        let posts = Posts()
        let refused = try errorObject(await bridge(status: 401, posts: posts).handle(line: #"{"jsonrpc":"2.0","id":4,"method":"ping"}"#))
        #expect(refused.id == 4 && refused.message.contains("credentials"))
        let off = try errorObject(await bridge(status: 404, posts: posts).handle(line: #"{"jsonrpc":"2.0","id":5,"method":"ping"}"#))
        #expect(off.id == 5 && off.message.contains("off"))
        let empty = try errorObject(await bridge(status: 200, reply: " \n", posts: posts).handle(line: #"{"jsonrpc":"2.0","id":6,"method":"ping"}"#))
        #expect(empty.id == 6)
    }

    private func errorObject(_ line: String?) throws -> (id: Int?, code: Int?, message: String) {
        let text = try #require(line)
        let object = try #require(try OrderedJSON.parse(text).objectValue)
        let error = try #require(object["error"]?.objectValue)
        return (object["id"]?.intValue, error["code"]?.intValue, error["message"]?.stringValue ?? "")
    }

    @Test func theRequestCarriesTheTokenAndPlannerAsHeaders() throws {
        let file = OrchestratorBridgeFile(endpoint: "http://127.0.0.1:5000/", token: "tok", planner: "tab1")
        let request = try #require(OrchestratorBridge.request(for: file, body: Data("{}".utf8)))
        #expect(request.url?.absoluteString == "http://127.0.0.1:5000/mcp")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "X-Alethe-Token") == "tok")
        #expect(request.value(forHTTPHeaderField: "X-Alethe-Planner") == "tab1")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    // MARK: Bridge file

    @Test func theBridgeFileIsPrivateAndRoundTrips() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "alethe-bridge-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: OrchestratorPlannerLaunch.bridgeFileName(tab: "tab1"))
        let file = OrchestratorBridgeFile(endpoint: "http://127.0.0.1:5000", token: "secret-token", planner: "tab1")
        try file.write(to: url)
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o600)
        #expect(try OrchestratorBridgeFile.read(from: url) == file)
        #expect(!file.description.contains("secret-token"))

        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        #expect(throws: OrchestratorBridgeFile.ReadError.notPrivate) { try OrchestratorBridgeFile.read(from: url) }

        let malformed = folder.appending(path: "malformed.json")
        FileManager.default.createFile(atPath: malformed.path, contents: Data(#"{"endpoint":"https://x","token":"t","planner":"p"}"#.utf8),
                                       attributes: [.posixPermissions: 0o600])
        #expect(throws: OrchestratorBridgeFile.ReadError.malformed) { try OrchestratorBridgeFile.read(from: malformed) }
        #expect(throws: OrchestratorBridgeFile.ReadError.unreadable) { try OrchestratorBridgeFile.read(from: folder.appending(path: "missing")) }
    }

    @Test func codexPlannersGetTheHelperWithOnlyTheFileAsArgument() {
        let server = OrchestratorPlannerLaunch.bridgeServer(helper: "/Apps/Alethe.app/Contents/Helpers/alethe-orchestrator-mcp",
                                                            bridgeFile: "/tmp/alethe-hooks-1/orchestrator-bridge-tab1.json")
        #expect(server.name == "alethe" && !server.isHTTP && server.environment.isEmpty)
        #expect(McpLaunchConfig.codexArguments([server]) == [
            "-c", #"mcp_servers.alethe.command="/Apps/Alethe.app/Contents/Helpers/alethe-orchestrator-mcp""#,
            "-c", #"mcp_servers.alethe.args=["--bridge","/tmp/alethe-hooks-1/orchestrator-bridge-tab1.json"]"#,
        ])
        #expect(OrchestratorPlannerLaunch.helper(inApp: URL(filePath: "/Apps/Alethe.app")).path
            == "/Apps/Alethe.app/Contents/Helpers/alethe-orchestrator-mcp")
        #expect(OrchestratorPlannerLaunch.bridgeFileName(tab: "a/b c") == "orchestrator-bridge-a_b_c.json")
    }

    // MARK: Stdio loop

    private func serve(_ input: String, handle: @escaping @Sendable (String) async -> String?) async -> [String] {
        let stdin = Pipe(), stdout = Pipe()
        stdin.fileHandleForWriting.write(Data(input.utf8))
        try? stdin.fileHandleForWriting.close()
        await OrchestratorStdio.serve(input: stdin.fileHandleForReading, output: stdout.fileHandleForWriting, handle: handle)
        try? stdout.fileHandleForWriting.close()
        let data = (try? stdout.fileHandleForReading.readToEnd()) ?? Data()
        return String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    @Test func linesSplitOnNewlinesOnlyAndBlankOnesAreSkipped() async {
        let seen = Posts()
        let output = await serve("one\r\n\n   \ntwo\u{2028}still two\nlast") { line in
            await seen.add(Data(line.utf8))
            return line == "one" ? "ONE" : nil
        }
        #expect(Set(await seen.bodies) == ["one", "two\u{2028}still two", "last"])
        #expect(output == ["ONE", ""])
    }

    @Test func aSlowAnswerDoesNotHoldUpTheNext() async {
        let gate = Posts()
        let output = await serve("slow\nfast\n") { line in
            if line == "fast" {
                await gate.add(Data())
                return "fast"
            }
            for _ in 0..<200 {
                if await !gate.bodies.isEmpty { break }
                try? await Task.sleep(for: .milliseconds(10))
            }
            return "slow"
        }
        #expect(output == ["fast", "slow", ""])
    }

    // MARK: Standalone

    @Test func standaloneFindsCodexAndReadsTheWorkerLimit() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "alethe-standalone-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let codex = folder.appending(path: "codex")
        FileManager.default.createFile(atPath: codex.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])

        let fromPath = OrchestratorStandalone.setup(environment: ["PATH": "/nonexistent:\(folder.path)", "ALETHE_MAX_WORKERS": "7"])
        #expect(fromPath.codex?.path == codex.path)
        #expect(try fromPath.configuration.launchers.launcher(for: WorkerAgent.codex).arguments == ["app-server", "--stdio"])
        #expect(fromPath.configuration.concurrencyLimit == 7)

        let explicit = OrchestratorStandalone.setup(environment: ["ALETHE_CODEX": codex.path, "PATH": ""])
        #expect(explicit.codex?.path == codex.path)

        let missing = OrchestratorStandalone.setup(environment: ["PATH": "/nonexistent", "ALETHE_CODEX": "/nonexistent/codex",
                                                                 "ALETHE_MAX_WORKERS": "many"])
        #expect(missing.codex == nil)
        #expect(missing.configuration.concurrencyLimit == OrchestratorLimits.defaultConcurrency)
        #expect(throws: WorkerLaunchError.self) { try missing.configuration.launchers.launcher(for: WorkerAgent.codex) }
    }

    @Test func theStandaloneHandshake() async throws {
        let core = OrchestratorCore(configuration: OrchestratorStandalone.setup(environment: ["PATH": "/nonexistent"]).configuration)
        let input = [
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        ].joined(separator: "\n") + "\n"
        let output = await serve(input, handle: OrchestratorStdio.standalone(core)).filter { !$0.isEmpty }
        await core.shutdown()
        #expect(output.count == 2)
        let replies = try output.map { try #require(try OrderedJSON.parse($0).objectValue) }
        let initialize = try #require(replies.first { $0["id"]?.intValue == 1 }?["result"]?.objectValue)
        #expect(initialize["protocolVersion"]?.stringValue == "2025-03-26")
        #expect(initialize["serverInfo"]?.objectValue?["name"]?.stringValue == "alethe")
        let tools = try #require(replies.first { $0["id"]?.intValue == 2 }?["result"]?.objectValue?["tools"]?.arrayValue)
        #expect(tools.count == 14)
    }

    // MARK: The built helper

    private final class Marker {}

    /// Next to the test bundle in SwiftPM's products folder.
    private func builtHelper() throws -> URL {
        let url = Bundle(for: Marker.self).bundleURL.deletingLastPathComponent().appending(path: OrchestratorPlannerLaunch.helperName)
        try #require(FileManager.default.isExecutableFile(atPath: url.path), "build the package first: \(url.path)")
        return url
    }

    private actor Planners {
        var seen: [String?] = []
        func add(_ planner: String?) { seen.append(planner) }
    }

    /// Runs the helper, writes `lines` to it, reads `expected` answer lines, then closes its stdin.
    /// A watchdog ends the process so a broken helper fails the test instead of hanging it.
    private func run(_ helper: URL, arguments: [String], environment: [String: String]? = nil,
                     lines: [String], expected: Int) async throws -> (answers: [String], status: Int32) {
        let process = Process()
        process.executableURL = helper
        process.arguments = arguments
        if let environment { process.environment = environment }
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        let watchdog = Task.detached {
            try await Task.sleep(for: .seconds(20))
            process.terminate()
        }
        defer { watchdog.cancel() }
        for line in lines { stdin.fileHandleForWriting.write(Data((line + "\n").utf8)) }
        var answers: [String] = []
        var buffer = Data()
        let reader = stdout.fileHandleForReading
        while answers.count < expected {
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                answers.append(String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self))
                buffer.removeSubrange(buffer.startIndex...newline)
            }
        }
        try stdin.fileHandleForWriting.close()
        process.waitUntilExit()
        return (answers, process.terminationStatus)
    }

    @Test func theBuiltHelperBridgesToAStubEndpoint() async throws {
        let helper = try builtHelper()
        let planners = Planners()
        let core = OrchestratorCore()
        let server = AgentHookServer(token: "stubtoken") { _, _, _ in }
        server.setMcpHandler { body, planner in
            await planners.add(planner)
            guard let reply = await OrchestratorMCP.handle(body: body, planner: planner, handler: core) else { return .accepted }
            return .body(reply)
        }
        let endpoint = try #require(await server.start())
        defer { server.stop() }

        let folder = FileManager.default.temporaryDirectory.appending(path: "alethe-bridge-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appending(path: OrchestratorPlannerLaunch.bridgeFileName(tab: "tab1"))
        try OrchestratorBridgeFile(endpoint: endpoint, token: server.token, planner: "tab1").write(to: file)

        let result = try await run(helper, arguments: ["--bridge", file.path], lines: [
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
        ], expected: 2)
        #expect(result.status == 0)
        let ids = Set(try result.answers.compactMap { try OrderedJSON.parse($0).objectValue?["id"]?.intValue })
        #expect(ids == [1, 2])
        #expect(result.answers.contains { $0.contains(#""protocolVersion":"2025-06-18""#) })
        let seen = await planners.seen
        #expect(seen.count == 3 && Set(seen) == ["tab1"])
        await core.shutdown()

        // A wrong token gets an error answer, not silence.
        try OrchestratorBridgeFile(endpoint: endpoint, token: "wrong", planner: "tab1").write(to: file)
        let refused = try await run(helper, arguments: ["--bridge", file.path],
                                    lines: [#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#], expected: 1)
        #expect(refused.answers.count == 1 && refused.answers[0].contains(#""error""#))

        // A file others can read is not used.
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        let exposed = try await run(helper, arguments: ["--bridge", file.path], lines: [], expected: 0)
        #expect(exposed.status == 66)
    }

    @Test func theBuiltHelperAnswersTheStandaloneHandshake() async throws {
        let helper = try builtHelper()
        let result = try await run(helper, arguments: [], environment: ["PATH": "/nonexistent"], lines: [
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        ], expected: 2)
        #expect(result.status == 0)
        #expect(result.answers.contains { $0.contains(#""protocolVersion":"\#(OrchestratorMCP.defaultProtocolVersion)""#) })
        let tools = result.answers.compactMap { try? OrderedJSON.parse($0).objectValue }
            .first { $0["id"]?.intValue == 2 }?["result"]?.objectValue?["tools"]?.arrayValue
        #expect(tools?.count == 14)
    }
}
