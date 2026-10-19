import AppKit
import Foundation
import Testing
@testable import AletheTerminal

@Suite struct SmartPasteTests {
    /// Port of `terminalInput.test.ts`'s clipboard newline regression.
    @Test func clipboardNewlinesBecomePTYCarriageReturns() {
        #expect(SmartPaste.normalizeText("one\r\ntwo\nthree\r") == "one\rtwo\rthree\r")
        #expect(SmartPaste.normalizeText("ação 🚀\r\n\r\nend") == "ação 🚀\r\rend")
        #expect(SmartPaste.normalizeText("") == "")
    }

    private func pasteboard() -> NSPasteboard {
        let board = NSPasteboard(name: NSPasteboard.Name("alethe-test-\(UUID().uuidString)"))
        board.clearContents()
        return board
    }

    /// 1×1 PNG and the same pixel as TIFF.
    private func image(_ type: NSBitmapImageRep.FileType) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.representation(using: type, properties: [:])!
    }

    @Test func pathsAreEscapedLikeGhosttyWithATrailingSpace() {
        #expect(SmartPaste.format(paths: ["/tmp/a.txt"]) == "/tmp/a.txt ")
        #expect(SmartPaste.format(paths: ["/tmp/my dir/b (1).png"]) == #"/tmp/my\ dir/b\ \(1\).png "#)
        #expect(SmartPaste.format(paths: ["/a", "/b c"]) == #"/a /b\ c "#)
        #expect(SmartPaste.format(paths: []) == "")
        #expect(SmartPaste.format(paths: ["", ""]) == "")
    }

    @Test func filesComeBeforeImagesAndText() {
        let board = pasteboard()
        board.writeObjects([URL(filePath: "/tmp/x.png") as NSURL])
        board.setString("x.png", forType: .string)
        #expect(SmartPaste.payload(from: board) == .paths(["/tmp/x.png"]))
    }

    @Test func imagesComeBeforeText() {
        let board = pasteboard()
        let png = image(.png)
        board.setData(png, forType: .png)
        board.setString("alt text", forType: .string)
        #expect(SmartPaste.payload(from: board) == .image(png))
    }

    @Test func textAndEmpty() {
        let board = pasteboard()
        #expect(SmartPaste.payload(from: board) == .empty)
        board.setString("hello", forType: .string)
        #expect(SmartPaste.payload(from: board) == .text("hello"))
    }

    @Test func savedImagesArePNGs() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "alethe-paste-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        for data in [image(.png), image(.tiff)] {
            let path = try SmartPaste.saveImage(data, in: directory)
            #expect(path.hasSuffix(".png"))
            let saved = try Data(contentsOf: URL(filePath: path))
            #expect(saved.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        }
        #expect(throws: (any Error).self) { try SmartPaste.saveImage(Data("nope".utf8), in: directory) }
    }
}
