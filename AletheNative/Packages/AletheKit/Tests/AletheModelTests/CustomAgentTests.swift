import Foundation
import Testing
@testable import AletheModel

@Suite struct CustomAgentTests {
    @Test func cliTokenizationMatchesWebAndRejectsShellSyntax() {
        #expect(CustomAgentDefinition.tokenize(#""/opt/My CLI/agent" --chat 'two words'"#) == ["/opt/My CLI/agent", "--chat", "two words"])
        for text in ["agent; echo", "agent $(id)", "agent | sh", "agent `id`", "agent 'unfinished", "agent ''"] {
            #expect(CustomAgentDefinition.tokenize(text) == nil)
        }
    }
    @Test func validatesIdentityFlagsURLsAndIconBytes() throws {
        var agent = CustomAgentDefinition()
        agent.id = "my-agent"; agent.label = "My agent"; agent.cliCommand = "my-cli --chat"
        #expect(agent.validationError(existing: [], builtins: ["claude"], editing: nil) == nil)
        agent.id = "claude"
        #expect(agent.validationError(existing: [], builtins: ["claude"], editing: nil) == "idBuiltin")
        agent.id = "my-agent"; agent.unrestrictedFlag = "--all;echo"
        #expect(agent.validationError(existing: [], builtins: [], editing: nil) == "cliUnsafe")
        #expect(CustomAgentDefinition.validURL("https://example.com/icon.png?size=20"))
        for url in ["http://example.com/icon.png", "https://user:pass@example.com/icon.jpg", "https://example.com/icon.svg", "data:image/png;base64,AA=="] {
            #expect(!CustomAgentDefinition.validURL(url))
        }
        #expect(CustomAgentDefinition.icoError(Data([0, 0, 1, 0, 1, 0, 32, 32])) == nil)
        #expect(CustomAgentDefinition.icoError(Data([0, 0, 1, 0, 1, 0, 32, 64])) == "iconFileNotSquare")
        #expect(CustomAgentDefinition.icoError(Data(count: 512 * 1024 + 1)) == "iconFileTooLarge")
        #expect(CustomAgentDefinition.icoError(Data([1, 2, 3, 4])) == "iconFileInvalid")
    }
    @Test func definitionAndDiscriminatedIconsRoundTrip() throws {
        for icon in [CustomAgentIconSpec(kind: "preset", key: "bot"), .init(kind: "url", href: "https://example.com/icon.jpg"), .init(kind: "file", assetId: "my-agent")] {
            var agent = CustomAgentDefinition()
            agent.id = "my-agent"; agent.iconSpec = icon
            let data = try JSONEncoder().encode(agent)
            #expect(try JSONDecoder().decode(CustomAgentDefinition.self, from: data) == agent)
        }
    }
}
