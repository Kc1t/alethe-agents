import Foundation

/// ImageInput.tsx stores original bytes without resizing or recompression.
public enum ProjectImageInput {
    public static let maximumBytes = 2 * 1024 * 1024

    public enum ValidationError: Error, Equatable {
        case mustBeImage
        case tooLarge
    }

    public static func dataURL(_ data: Data, mimeType: String) throws -> String {
        guard mimeType.hasPrefix("image/") else { throw ValidationError.mustBeImage }
        guard data.count <= maximumBytes else { throw ValidationError.tooLarge }
        return "data:\(mimeType);base64,\(data.base64EncodedString())"
    }

    /// Read at most the web limit plus one byte, including files that grow after selection.
    public static func fileDataURL(_ url: URL, mimeType: String) throws -> String {
        guard mimeType.hasPrefix("image/") else { throw ValidationError.mustBeImage }
        let attributes = try url.resourceValues(forKeys: [.fileSizeKey])
        guard (attributes.fileSize ?? 0) <= maximumBytes else { throw ValidationError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        return try dataURL(data, mimeType: mimeType)
    }

    public static func normalized(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
