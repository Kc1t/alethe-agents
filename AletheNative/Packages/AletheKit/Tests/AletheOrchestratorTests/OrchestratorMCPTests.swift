import Foundation
import Testing
import AletheIntegrations
@testable import AletheOrchestrator

/// Records tool calls and answers with a fixed value or error.
private struct StubHandler: OrchestratorToolHandler {
    var answer: @Sendable (String, OrderedJSONObject, String?) throws -> OrderedJSON

    func callTool(name: String, arguments: OrderedJSONObject, planner: String?) async throws -> OrderedJSON {
        try answer(name, arguments, planner)
    }
}

private let refusing = StubHandler { _, _, _ in throw OrchestratorToolError("not wired") }

private func rpc(
    _ method: String,
    id: OrderedJSON = 1,
    params: OrderedJSON = [:],
    handler: StubHandler = refusing,
    planner: String? = nil
) async throws -> OrderedJSONObject {
    let body: OrderedJSON = ["jsonrpc": "2.0", "id": id, "method": .string(method), "params": params]
    let raw = try #require(await OrchestratorMCP.handle(body: body.compactRendered(), planner: planner, handler: handler))
    return try #require(try OrderedJSON.parse(raw).objectValue)
}

private func toolNames(_ response: OrderedJSONObject) -> [String] {
    response["result"]?.objectValue?["tools"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue } ?? []
}

@Suite struct OrchestratorMCPTests {
    // Upstream `the_handshake_advertises_every_tool`.
    @Test func theHandshakeAdvertisesEveryTool() async throws {
        let initialized = try await rpc("initialize", id: 1)
        #expect(initialized["result"]?.objectValue?["serverInfo"]?.objectValue?["name"] == "alethe")

        let names = toolNames(try await rpc("tools/list", id: 2))
        for expected in [
            "alethe_delegate", "alethe_check", "alethe_status", "alethe_steer",
            "alethe_send", "alethe_cancel", "alethe_release", "alethe_diff",
        ] {
            #expect(names.contains(expected), "missing \(expected) in \(names)")
        }
    }

    // Upstream `a_notification_gets_no_response_body`.
    @Test func aNotificationGetsNoResponseBody() async {
        let body = #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        #expect(await OrchestratorMCP.handle(body: body, planner: nil, handler: refusing) == nil)
    }

    // Upstream `the_delegate_schema_points_at_the_live_reading_instead_of_quoting_numbers`.
    @Test func theDelegateSchemaPointsAtTheLiveReadingInsteadOfQuotingNumbers() async throws {
        let listed = try await rpc("tools/list")
        let delegate = try #require(listed["result"]?.objectValue?["tools"]?.arrayValue?.first {
            $0.objectValue?["name"] == "alethe_delegate"
        })
        let description = try #require(
            delegate.objectValue?["inputSchema"]?.objectValue?["properties"]?.objectValue?["agent"]?
                .objectValue?["description"]?.stringValue
        )
        #expect(description.contains("fitness"))
        #expect(description.contains("headroom"))
        // A description is a session-start snapshot on this transport, so a figure baked in would go stale.
        #expect(!description.contains("%"))
    }

    @Test func theResourceHoldsUpstreamAndQueueToolsInOrder() {
        let names = OrchestratorMCP.tools.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue }
        #expect(names == [
            "alethe_delegate", "alethe_check", "alethe_status", "alethe_steer", "alethe_send",
            "alethe_answer", "alethe_cancel", "alethe_release", "alethe_diff",
            "alethe_queue_add", "alethe_queue_list", "alethe_queue_cancel",
            "alethe_queue_run_now", "alethe_queue_reorder",
        ])
        for tool in OrchestratorMCP.tools.arrayValue ?? [] {
            let object = tool.objectValue
            #expect(object?.keys == ["name", "description", "inputSchema"])
            #expect(object?["inputSchema"]?.objectValue?["type"] == "object")
        }
    }

    @Test func initializeEchoesTheProtocolVersionOrFallsBack() async throws {
        let echoed = try await rpc("initialize", params: ["protocolVersion": "2024-11-05"])
        let result = try #require(echoed["result"]?.objectValue)
        #expect(result["protocolVersion"] == "2024-11-05")
        #expect(result["capabilities"] == ["tools": ["listChanged": false]])
        #expect(result["serverInfo"] == ["name": "alethe", "title": "Alethe", "version": "1"])

        let fallback = try await rpc("initialize", params: [:])
        #expect(fallback["result"]?.objectValue?["protocolVersion"] == "2025-06-18")
    }

    @Test func theResponseEchoesTheRequestIdAsSent() async throws {
        let numeric = try await rpc("ping", id: 42)
        #expect(numeric["id"] == 42)
        #expect(numeric["jsonrpc"] == "2.0")
        #expect(numeric["result"] == [:])
        let text = try await rpc("ping", id: "abc")
        #expect(text["id"] == "abc")
    }

    @Test func anUnknownMethodIsRefusedWithMethodNotFound() async throws {
        let response = try await rpc("resources/list", id: 7)
        let error = try #require(response["error"]?.objectValue)
        #expect(error["code"]?.intValue == -32601)
        #expect(error["message"] == "unknown method resources/list")
        #expect(response["result"] == nil)
    }

    @Test func aToolCallAnswersWithCompactTextAndPassesThePlanner() async throws {
        let handler = StubHandler { name, arguments, planner in
            ["tool": .string(name), "tasks": arguments["tasks"] ?? .null, "planner": .optional(planner)]
        }
        let response = try await rpc(
            "tools/call",
            params: ["name": "alethe_status", "arguments": ["tasks": ["a"]]],
            handler: handler,
            planner: "tab-1"
        )
        let result = try #require(response["result"]?.objectValue)
        #expect(result["isError"] == nil)
        let content = try #require(result["content"]?.arrayValue?.first?.objectValue)
        #expect(content["type"] == "text")
        #expect(content["text"] == #"{"tool":"alethe_status","tasks":["a"],"planner":"tab-1"}"#)
    }

    @Test func aToolCallWithoutArgumentsGetsAnEmptyObject() async throws {
        let handler = StubHandler { _, arguments, _ in .integer(arguments.count) }
        let response = try await rpc("tools/call", params: ["name": "alethe_status"], handler: handler)
        #expect(response["result"]?.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"] == "0")
    }

    @Test func aRefusedToolCallIsAnErrorResultNotAProtocolError() async throws {
        let handler = StubHandler { _, _, _ in throw OrchestratorToolError("tasks must contain at least one instruction") }
        let response = try await rpc("tools/call", params: ["name": "alethe_delegate", "arguments": [:]], handler: handler)
        #expect(response["error"] == nil)
        let result = try #require(response["result"]?.objectValue)
        #expect(result["isError"] == true)
        #expect(result["content"]?.arrayValue?.first?.objectValue?["text"] == "error: tasks must contain at least one instruction")
    }

    @Test func aBodyThatIsNotJSONGetsNoAnswer() async {
        #expect(await OrchestratorMCP.handle(body: "not json", planner: nil, handler: refusing) == nil)
        #expect(await OrchestratorMCP.handle(body: Data("[1]".utf8), planner: nil, handler: refusing) == nil)
    }
}
