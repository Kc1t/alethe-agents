import Foundation
import Testing
@testable import AletheAgents

struct AIUsageTests {
    @Test func codexCredentialDetection() {
        for json in [#"{"tokens":{"access_token":"token"}}"#, #"{"tokens":{"refresh_token":"refresh"}}"#] {
            #expect(AIUsage.codexAuthenticated(Data(json.utf8)))
        }
        for json in ["{}", "null", "invalid", #"{"tokens":{"access_token":""}}"#, #"{"OPENAI_API_KEY":"key"}"#] {
            #expect(!AIUsage.codexAuthenticated(Data(json.utf8)))
        }
    }

    @Test func authenticatedVisibilityRespectsOptOut() {
        #expect(AIUsage.showsPill(authenticated: true, enabled: true))
        #expect(!AIUsage.showsPill(authenticated: true, enabled: false))
        #expect(!AIUsage.showsPill(authenticated: false, enabled: true))
        #expect(!AIUsage.showsPill(authenticated: false, enabled: false))
    }

    @Test func failedReadRetainsFiguresButSignOutClearsThem() {
        let good = ProviderUsage(agent: .claude, status: .ready,
                                 windows: [UsageWindow(label: "5h", usedPercent: 42, resetsAt: nil)])
        let failed = ProviderUsage(agent: .claude, status: .unavailable("network"))
        #expect(AIUsage.retainedReading(previous: good, fresh: failed) == good)
        #expect(AIUsage.retainedReading(previous: nil, fresh: failed) == failed)
        let signedOut = ProviderUsage(agent: .claude, status: .noAuth)
        #expect(AIUsage.retainedReading(previous: good, fresh: signedOut) == signedOut)
    }

    @Test func claudeWindows() throws {
        let body = Data(#"{"five_hour":{"utilization":42.5,"resets_at":"2026-09-25T15:00:00.123Z"},"seven_day":{"utilization":100,"resets_at":"2026-09-30T00:00:00Z"},"seven_day_opus":null}"#.utf8)
        let usage = try #require(AIUsage.parseClaude(body))
        #expect(usage.windows.map(\.label) == ["5h", "7d"])
        #expect(usage.windows[0].usedPercent == 42.5)
        #expect(usage.windows[0].resetsAt != nil)
        #expect(usage.rateLimited)
        #expect(usage.peak?.label == "7d")
        #expect(AIUsage.parseClaude(Data("nope".utf8)) == nil)
    }

    @Test func claudeTokenFromSecret() {
        #expect(AIUsage.claudeToken(fromSecret: Data(#"{"claudeAiOauth":{"accessToken":"abc"}}"#.utf8)) == "abc")
        #expect(AIUsage.claudeToken(fromSecret: Data(#"{"claudeAiOauth":{"accessToken":""}}"#.utf8)) == nil)
    }

    @Test func codexLimitsAndCredits() throws {
        let result: [String: Any] = [
            "rateLimits": [
                "primary": ["usedPercent": 30, "windowDurationMins": 300, "resetsAt": 1_790_000_000],
                "secondary": ["usedPercent": 75, "windowDurationMins": 10080],
                "planType": "plus",
                "rateLimitReachedType": NSNull(),
            ] as [String: Any],
            "rateLimitResetCredits": ["credits": [
                ["id": "c1", "status": "available", "title": "Reset", "description": "One reset"],
                ["id": "c2", "status": "consumed"],
            ]],
        ]
        let usage = try #require(AIUsage.parseCodex(result))
        #expect(usage.windows.map(\.label) == ["5h", "7d"])
        #expect(usage.windows[0].resetsAt == Date(timeIntervalSince1970: 1_790_000_000))
        #expect(usage.plan == "plus")
        #expect(!usage.rateLimited)
        #expect(usage.resetCredits.map(\.id) == ["c1"])
        #expect(AIUsage.parseCodex([:]) == nil)
    }

    @Test func codexRateLimited() throws {
        let usage = try #require(AIUsage.parseCodex(["rateLimits": ["rateLimitReachedType": "primary"]]))
        #expect(usage.rateLimited)
    }

    @Test func antigravityBuckets() throws {
        let body = Data(#"""
        {"models":{
          "gemini-pro":{"displayName":"Gemini 3 Pro","quotaInfo":{"remainingFraction":0.25,"resetTime":"2026-09-25T18:00:00Z"}},
          "gemini-flash":{"displayName":"Gemini 3 Flash","quotaInfo":{"remainingFraction":0.25,"resetTime":"2026-09-25T18:00:00Z"}},
          "claude-sonnet":{"displayName":"Claude Sonnet","quotaInfo":{"remainingFraction":1}},
          "no-quota":{"displayName":"Other"}
        }}
        """#.utf8)
        let usage = try #require(AIUsage.parseAntigravity(body))
        #expect(usage.windows.map(\.label) == ["Gemini", "Claude"])
        #expect(usage.windows[0].usedPercent == 75)
        #expect(usage.windows[1].usedPercent == 0)
        #expect(!usage.rateLimited)
        #expect(AIUsage.parseAntigravity(Data(#"{"models":{}}"#.utf8)) == nil)
    }

    @Test func limitResets() {
        let now = Date(timeIntervalSince1970: 1000)
        let before = ProviderUsage(agent: .claude, status: .ready, windows: [
            UsageWindow(label: "5h", usedPercent: 100, resetsAt: Date(timeIntervalSince1970: 900)),
            UsageWindow(label: "7d", usedPercent: 100, resetsAt: Date(timeIntervalSince1970: 5000)),
            UsageWindow(label: "7d Opus", usedPercent: 40, resetsAt: nil),
        ])
        let after = ProviderUsage(agent: .claude, status: .ready, windows: [
            UsageWindow(label: "5h", usedPercent: 3, resetsAt: nil),
            UsageWindow(label: "7d", usedPercent: 99, resetsAt: nil),
            UsageWindow(label: "7d Opus", usedPercent: 0, resetsAt: nil),
        ])
        #expect(AIUsage.resets(from: before, to: after, now: now).map(\.label) == ["5h"])
    }
}
