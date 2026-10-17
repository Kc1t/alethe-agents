import Foundation
import Testing
@testable import AletheAgents

struct UsageCredentialsTests {
    @Test func oneReadAcrossPollsAndPromptFreeCacheHits() {
        let cache = UsageCredentialCache()
        var reads = 0
        func token(_ interaction: Bool = true) -> String? {
            cache.token(key: "claude", allowInteraction: interaction, local: { nil }, secret: {
                reads += 1
                return .init(token: "test-token", expiresAt: nil)
            })
        }
        #expect(token(false) == nil)
        #expect(reads == 0)
        for _ in 0..<10 { #expect(token() == "test-token") }
        #expect(token(false) == "test-token")
        #expect(reads == 1)
    }

    @Test func deniedAndMalformedCredentialsDoNotPromptAgainUntilReconnect() {
        let cache = UsageCredentialCache()
        var reads = 0
        func token() -> String? {
            cache.token(key: "claude", local: { nil }, secret: { reads += 1; return nil })
        }
        for _ in 0..<10 { #expect(token() == nil) }
        #expect(reads == 1)
        cache.reconnect()
        #expect(token() == nil)
        #expect(reads == 2)
    }

    @Test func expiryRefreshesOnceAndNoninteractiveProbeDoesNotRefresh() {
        let cache = UsageCredentialCache()
        let start = Date(timeIntervalSince1970: 100)
        var reads = 0
        func token(_ time: TimeInterval, interaction: Bool = true) -> String? {
            cache.token(key: "claude", allowInteraction: interaction, now: start.addingTimeInterval(time), local: { nil }, secret: {
                reads += 1
                return .init(token: "token-\(reads)", expiresAt: start.addingTimeInterval(Double(reads) * 10))
            })
        }
        #expect(token(0) == "token-1")
        #expect(token(9) == "token-1")
        #expect(token(10, interaction: false) == nil)
        #expect(reads == 1)
        #expect(token(10) == "token-2")
        #expect(token(11) == "token-2")
        #expect(reads == 2)
    }

    @Test func unauthorizedRefreshesButRepeatedRejectionDoesNotLoop() {
        for status in [401, 403] {
            let cache = UsageCredentialCache()
            var reads = 0
            func token() -> String? {
                cache.token(key: "claude", local: { nil }, secret: {
                    reads += 1
                    return .init(token: "unchanged-token", expiresAt: nil)
                })
            }
            #expect(token() == "unchanged-token")
            #expect(!cache.reject(key: "claude", token: "unchanged-token", status: 500))
            #expect(cache.reject(key: "claude", token: "unchanged-token", status: status))
            #expect(token() == "unchanged-token")
            #expect(!cache.reject(key: "claude", token: "unchanged-token", status: status))
            #expect(token() == "unchanged-token")
            #expect(reads == 2)
        }
    }

    @Test func unauthorizedResponseReadsFreshCredentialAndRetriesOnce() async {
        for status in [401, 403] {
            let cache = UsageCredentialCache()
            var reads = 0
            var requests: [String] = []
            let usage = await AIUsage.claudeUsage(discover: {
                cache.token(key: "claude", local: { nil }, secret: {
                    reads += 1
                    return .init(token: "token-\(reads)", expiresAt: nil)
                })
            }, refresh: { cache.reject(key: "claude", token: $0, status: $1) }, fetch: { token in
                requests.append(token)
                return token == "token-1" ? (Data(), status) : (Data("{}".utf8), 200)
            })
            #expect(usage.status == .ready)
            #expect(reads == 2)
            #expect(requests == ["token-1", "token-2"])
        }
    }

    @Test func localCredentialsNeverReadKeychain() {
        let cache = UsageCredentialCache()
        var reads = 0
        let token = cache.token(key: "claude", local: { .init(token: "file-token", expiresAt: nil) }, secret: {
            reads += 1
            return nil
        })
        #expect(token == "file-token")
        #expect(reads == 0)
    }

    @Test func claudeExpiryUsesMilliseconds() throws {
        let credential = try #require(AIUsage.claudeCredential(Data(
            #"{"claudeAiOauth":{"accessToken":"test-token","expiresAt":1790000000000}}"#.utf8)))
        #expect(credential.expiresAt == Date(timeIntervalSince1970: 1_790_000_000))
        #expect(AIUsage.claudeCredential(Data("invalid".utf8)) == nil)
    }

    @Test func presenceOnlyReadsAttributesAndSecretUsesOneUnqualifiedQuery() {
        var calls: [[String]] = []
        let reader = UsageKeychainReader(toolExists: { true }, run: { arguments in
            calls.append(arguments)
            return Data("test-output\n".utf8)
        }, fallback: { _, _, _ in
            Issue.record("An installed security tool must never fall back to direct access")
            return nil
        })
        #expect(reader.contains(service: "Claude Code-credentials"))
        #expect(calls == [["find-generic-password", "-s", "Claude Code-credentials"]])
        #expect(reader.read(service: "Claude Code-credentials") != nil)
        #expect(calls.count == 2)
        #expect(calls[1] == ["find-generic-password", "-s", "Claude Code-credentials", "-w"])
    }

    @Test func deniedToolDoesNotFallBackButMissingToolDoes() {
        var fallbacks = 0
        var reader = UsageKeychainReader(toolExists: { true }, run: { _ in nil }, fallback: { service, account, interaction in
            #expect(service == "gemini")
            #expect(account == "antigravity")
            #expect(interaction)
            fallbacks += 1
            return Data("test-secret".utf8)
        })
        #expect(reader.read(service: "gemini", account: "antigravity") == nil)
        #expect(fallbacks == 0)
        reader.toolExists = { false }
        #expect(reader.read(service: "gemini", account: "antigravity") != nil)
        #expect(fallbacks == 1)
    }
}
