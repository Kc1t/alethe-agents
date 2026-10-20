import Foundation
import Testing
@testable import AletheTerminal

/// Cases from origin/main src/components/XTermView/terminalLinks.test.ts.
@Suite struct DetectedTerminalLinkTests {
    @Test(arguments: [
        ("https://github.com/login/device in your browser...", ["https://github.com/login/device"]),
        ("(https://github.com/login/device in your browser)", ["https://github.com/login/device"]),
        (#"D:\public launch\src\file.ts"#, [#"D:\public launch\src\file.ts"#]),
        (#""D:\tmp\shot-lab-strips\ a PNG per shot, name = slug.""#, [#"D:\tmp\shot-lab-strips\"#]),
        ("Updated README.md", ["README.md"]),
        ("40-Conteudo/youtube/roteiros-yt/kimi-k3-patrocinado/sorteio-vencedores.md.",
         ["40-Conteudo/youtube/roteiros-yt/kimi-k3-patrocinado/sorteio-vencedores.md"]),
        ("See src/components/App.tsx:42", ["src/components/App.tsx:42"]),
        ("user@example.com", []),
        (#"at ~\Desktop\para-gpt\validation.zip (sha256 e5de322d)"#, [#"~\Desktop\para-gpt\validation.zip"#]),
        (#"~\projects\alethe runs in dev"#, [#"~\projects\alethe"#]),
        (#"~\projects\alethe ~\Desktop\notes.md"#, [#"~\projects\alethe"#, #"~\Desktop\notes.md"#]),
        (#"~\Desktop\ see readme.md"#, [#"~\Desktop\"#, "readme.md"]),
        ("/pt-br/vitrine-dupla/trajetoria — 5 variations", ["/pt-br/vitrine-dupla/trajetoria"]),
        ("/api/users returns 401 when the token expires", ["/api/users"]),
        ("~/projects/alethe runs in dev and prod", ["~/projects/alethe"]),
        ("/tmp/my folder/readme.md", ["/tmp/my folder/readme.md"]),
        ("/ Zambia / India", []),
        ("Residential/mobile IP + UA", []),
        ("foo/bar", []),
        ("src/file.ts package.json user@example.com", ["src/file.ts", "package.json"]),
        ("(/pt-br/vitrine-dupla/projects and /en/double-showcase/projects)",
         ["/pt-br/vitrine-dupla/projects", "/en/double-showcase/projects"]),
        ("see (/tmp/my folder/readme.md) now", ["/tmp/my folder/readme.md"]),
        (#"Written to D:\vault\content\projection.md with two projections"#, [#"D:\vault\content\projection.md"#]),
        (#"D:\Videos\motion-kit-hype-video.mp4 and listen"#, [#"D:\Videos\motion-kit-hype-video.mp4"#])
    ])
    func detection(_ input: String, _ expected: [String]) {
        #expect(TerminalLinks.detect(input).map(\.text) == expected)
    }

    @Test func protocolsAndBareDomains() {
        let links = TerminalLinks.detect("Deploy at verzel-elite-dev-painel.vercel.app (Https://verzel-elite-dev-painel.vercel.app).")
        #expect(links.map(\.target) == ["https://verzel-elite-dev-painel.vercel.app", "https://verzel-elite-dev-painel.vercel.app"])
        #expect(links.allSatisfy { $0.kind == .url && $0.fileKind == nil })
        #expect(TerminalLinks.detect("localhost:5173/dashboard").first?.target == "http://localhost:5173/dashboard")
    }

    @Test func escapedSpacesKeepTheirVisualRange() throws {
        let link = try #require(TerminalLinks.detect(#"/tmp/my\ file/readme.md"#).first)
        #expect(link.text == "/tmp/my file/readme.md")
        #expect(link.displayLength == (#"/tmp/my\ file/readme.md"# as NSString).length)
        #expect(link.fileKind == .markdown)
        #expect(link.index == 0)
    }

    @Test func classification() {
        #expect(TerminalLinks.detect("/tmp/shot.png").first?.fileKind == .image)
        #expect(TerminalLinks.detect("/tmp/main.ts:42:10").first?.fileKind == .text)
        #expect(TerminalLinks.detect("/tmp/notes.md").first?.fileKind == .markdown)
        #expect(TerminalLinks.detect("/tmp/trailer.mp4").first?.fileKind == .video)
        #expect(TerminalLinks.detect("https://example.com/x").first?.fileKind == nil)
    }

    @Test func resolvesPathsWithoutRequiringExistence() {
        #expect(TerminalLinks.resolvePath("README.md", cwd: #"D:\repo"#) == #"D:\repo\README.md"#)
        #expect(TerminalLinks.resolvePath("./docs/README.md:12", cwd: "/workspace/repo") == "/workspace/repo/docs/README.md")
        #expect(TerminalLinks.resolvePath(#"D:\repo\README.md"#, cwd: #"D:\other"#) == #"D:\repo\README.md"#)
        #expect(TerminalLinks.resolvePath(#"~\Desktop\validation.zip"#, cwd: #"C:\repo"#, home: #"C:\Users\me"#)
                == #"C:\Users\me\Desktop\validation.zip"#)
        #expect(TerminalLinks.resolvePath("~/notes.md:3", cwd: "/work/repo", home: "/home/me/") == "/home/me/notes.md")
        #expect(TerminalLinks.resolvePath("~", cwd: #"C:\repo"#, home: #"C:\Users\me"#) == #"C:\Users\me"#)
        #expect(TerminalLinks.resolvePath(#"~\notes.md"#, cwd: #"C:\repo"#) == #"~\notes.md"#)
        #expect(TerminalLinks.resolvePath(#"~other\notes.md"#, cwd: #"C:\repo"#, home: #"C:\Users\me"#) == #"C:\repo\~other\notes.md"#)
    }

    @Test func wrappedRowsAndMultilineRange() throws {
        let rows: [TerminalLinks.Row] = [.init("go https:/"), .init("/example.c", isWrapped: true),
                                         .init("om/docs", isWrapped: true)]
        let logical = try #require(TerminalLinks.logicalLine(rows, lineNumber: 2))
        #expect(logical.text == "go https://example.com/docs")
        #expect(logical.startLine == 1)
        let link = try #require(TerminalLinks.detect(logical.text).first)
        let range = try #require(TerminalLinks.range(link, startLine: logical.startLine, columns: 10))
        #expect(range.start.x == 4 && range.start.y == 1)
        #expect(range.end.x == 7 && range.end.y == 3)
        #expect(TerminalLinks.logicalLine(rows, lineNumber: 0) == nil)
        #expect(TerminalLinks.logicalLine(rows, lineNumber: 4) == nil)
    }

    @Test func newestWorktreeAndNamedWorktreePrefix() {
        let dates = ["/feature/docs/report.md": Date(timeIntervalSince1970: 20),
                     "/other/docs/report.md": Date(timeIntervalSince1970: 10)]
        let roots = ["/main", "/feature", "/other"]
        #expect(TerminalLinks.findRelativePath("docs/report.md", cwd: "/main", worktrees: roots,
            exists: { _ in false }, modifiedAt: { dates[$0] }) == "/feature/docs/report.md")
        #expect(TerminalLinks.findRelativePath("other/docs/report.md", cwd: "/main", worktrees: roots,
            exists: { _ in false }, modifiedAt: { dates[$0] }) == "/other/docs/report.md")
        #expect(TerminalLinks.findRelativePath("docs/report.md", cwd: "/main", worktrees: roots,
            exists: { $0 == "/main/docs/report.md" }, modifiedAt: { dates[$0] }) == "/main/docs/report.md")
        #expect(TerminalLinks.findRelativePath("missing.md", cwd: "/main", worktrees: roots,
            exists: { _ in false }, modifiedAt: { dates[$0] }) == nil)
    }

    @Test func relativePathsForWorktreeLookup() {
        #expect(TerminalLinks.relativePath("./docs/report.md:12") == "docs/report.md")
        #expect(TerminalLinks.relativePath(#"repo-feature\docs\report.md"#) == #"repo-feature\docs\report.md"#)
        for path in [#"D:\repo\README.md"#, "/workspace/README.md", "~/notes.md"] {
            #expect(TerminalLinks.relativePath(path) == nil)
        }
    }
}
