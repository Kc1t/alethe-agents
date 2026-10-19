import AppKit
import Foundation
import UniformTypeIdentifiers

/// Smart paste and drop (upstream `read_clipboard_payload` + `formatDroppedPaths`): files become
/// their paths, an image with no file behind it is saved as a PNG and pasted as that file's path, so
/// an agent can open it. Text keeps going through Ghostty's own paste (bracketed paste, newlines).
public enum SmartPaste {
    /// `terminalInput.ts`: CRLF, LF and CR all become a single PTY carriage return.
    public static func normalizeText(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\n", with: "\r")
    }

    /// What a pasteboard hands a terminal, in upstream's priority: files, then image, then text.
    public enum Payload: Equatable, Sendable {
        case paths([String])
        case image(Data)
        case text(String)
        case empty
    }

    /// Image representations taken from a pasteboard, most faithful first.
    static let imageTypes: [NSPasteboard.PasteboardType] = [
        .png, NSPasteboard.PasteboardType(UTType.jpeg.identifier),
        NSPasteboard.PasteboardType(UTType.heic.identifier), .tiff,
    ]

    public static func payload(from pasteboard: NSPasteboard) -> Payload {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        let files = (pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
        if !files.isEmpty { return .paths(files.map(\.path)) }
        for type in imageTypes {
            if let data = pasteboard.data(forType: type), !data.isEmpty { return .image(data) }
        }
        if let text = pasteboard.string(forType: .string), !text.isEmpty { return .text(text) }
        return .empty
    }

    /// Paths as typed at a prompt: shell-escaped like Ghostty's macOS app (backslashes, not quotes),
    /// space-separated, with a trailing space so the next word can follow (upstream).
    public static func format(paths: [String]) -> String {
        let escaped = paths.filter { !$0.isEmpty }.map(escape)
        return escaped.isEmpty ? "" : escaped.joined(separator: " ") + " "
    }

    /// Characters a POSIX shell would interpret in a word (Ghostty's `Shell.escape` set).
    private static let escapedCharacters: Set<Character> = [
        "\\", " ", "(", ")", "[", "]", "{", "}", "<", ">", "\"", "'", "`",
        "!", "#", "$", "&", ";", "|", "*", "?", "\t",
    ]

    static func escape(_ path: String) -> String {
        var result = ""
        for character in path {
            if escapedCharacters.contains(character) { result.append("\\") }
            result.append(character)
        }
        return result
    }

    /// Where pasted and dropped images are written.
    public static var imageDirectory: URL {
        FileManager.default.temporaryDirectory.appending(path: "Alethe/Pasted Images", directoryHint: .isDirectory)
    }

    /// Writes image data as a PNG (converting other formats) and returns its path.
    public static func saveImage(_ data: Data, in directory: URL = imageDirectory, now: Date = Date()) throws -> String {
        let png: Data
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
            png = data
        } else if let converted = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) {
            png = converted
        } else {
            throw CocoaError(.fileWriteUnknown)
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = formatter.string(from: now)
        let url = directory.appending(path: "image-\(stamp)-\(UUID().uuidString.prefix(6)).png")
        try png.write(to: url, options: .atomic)
        return url.path
    }
}
