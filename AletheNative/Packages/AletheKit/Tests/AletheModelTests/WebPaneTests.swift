import Foundation
import Testing
@testable import AletheModel

/// Ports of upstream `browserUrl.test.ts` and `browserResourcePolicy.test.ts`.
@Suite struct WebPaneTests {
    @Test func defaultsPublicHostsToHTTPS() {
        #expect(WebAddress.normalize("example.com/docs")?.absoluteString == "https://example.com/docs")
    }

    @Test func usesHTTPForLocalDevelopmentAddresses() {
        #expect(WebAddress.normalize("localhost:1422")?.absoluteString == "http://localhost:1422/")
        #expect(WebAddress.normalize("127.0.0.1:3000/app")?.absoluteString == "http://127.0.0.1:3000/app")
        #expect(WebAddress.normalize("  http://LOCALHOST:8080/x?y=1 ")?.absoluteString == "http://LOCALHOST:8080/x?y=1")
    }

    @Test func rejectsNonHTTPProtocolsAndInvalidInput() {
        #expect(WebAddress.normalize("javascript:alert(1)") == nil)
        #expect(WebAddress.normalize("file:///tmp/readme.html") == nil)
        #expect(WebAddress.normalize("") == nil)
        #expect(WebAddress.normalize("   ") == nil)
    }

    @Test func releasesHiddenPagesByMode() {
        #expect(WebResourceMode.appFirst.hiddenEvictionDelay(underMemoryPressure: false) == .seconds(1))
        #expect(WebResourceMode.balanced.hiddenEvictionDelay(underMemoryPressure: false) == .seconds(30))
        #expect(WebResourceMode.keepAlive.hiddenEvictionDelay(underMemoryPressure: false) == nil)
        #expect(WebResourceMode.balanced.hiddenEvictionDelay(underMemoryPressure: true) == .zero)
        #expect(WebResourceMode.keepAlive.hiddenEvictionDelay(underMemoryPressure: true) == .zero)
    }

    @Test func optionsDefaultWhenMissing() throws {
        let decoded = try JSONDecoder().decode(WebPaneOptions.self, from: Data("{}".utf8))
        #expect(decoded == WebPaneOptions())
        #expect(try JSONDecoder().decode(WebResourceMode.self, from: Data(#""keep-alive""#.utf8)) == .keepAlive)
    }
    @Test func namedBrowserOptionsRoundTripAndOldPanesStillDecode() throws {
        let options = WebPaneOptions(resourceMode: .keepAlive, javascriptEnabled: false, zoom: 1.25, name: "  Preview  ")
        let content = PaneContent.web(url: "http://localhost:3000/", options: options)
        let encoded = try JSONEncoder().encode(content)
        #expect(try JSONDecoder().decode(PaneContent.self, from: encoded) == content)
        #expect(options.name == "Preview")
        #expect(WebPaneOptions(name: "  ").name == nil)
        let old = try JSONDecoder().decode(WebPaneOptions.self, from: Data(#"{"zoom":1.5,"javascriptEnabled":false}"#.utf8))
        #expect(old.name == nil)
        #expect(old.zoom == 1.5 && !old.javascriptEnabled)
    }

}
