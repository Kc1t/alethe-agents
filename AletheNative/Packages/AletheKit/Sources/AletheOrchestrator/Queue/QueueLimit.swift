import Foundation
import AletheIntegrations

public enum QueueLimit {
    public static func detected(in text: String) -> Bool {
        let lower = text.lowercased()
        return ["usage limit", "rate limit", "rate_limit", "usage_limit", "quota exceeded", "too many requests",
                "hit your limit", "limit reached"].contains { lower.contains($0) }
    }

    /// Only protocol error fields are inspected; prompts and successful replies can quote limits.
    public static func workerMessage(_ message: OrderedJSON) -> String? {
        guard let object = message.objectValue else { return nil }
        let params = object["params"]?.objectValue
        var errors: [OrderedJSON] = []
        if let error = object["error"] { errors.append(error) }
        if let error = params?["error"] { errors.append(error) }
        if let error = params?["turn"]?.objectValue?["error"] { errors.append(error) }
        if object["method"]?.stringValue == "error", let message = params?["message"] { errors.append(message) }
        return errors.map { $0.stringValue ?? $0.compactRendered() }.first { detected(in: $0) }
    }

    /// Explicit ISO timestamps or vendor clock messages ("try again at 5:47 PM").
    /// Unknown reset times wait for a healthy fitness reading, never an immediate retry loop.
    public static func reset(in text: String, now: Date = Date(), calendar: Calendar = .current) -> Date? {
        let iso = #"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})"#
        if let range = text.range(of: iso, options: .regularExpression) {
            let value = String(text[range])
            if let date = try? Date(value, strategy: .iso8601) { return date > now ? date : nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions.insert(.withFractionalSeconds)
            if let date = formatter.date(from: value), date > now { return date }
        }
        guard let regex = try? NSRegularExpression(pattern: #"(?i)(?:\bat\b|\bresets?\b)\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let hourRange = Range(match.range(at: 1), in: text),
              var hour = Int(text[hourRange])
        else { return nil }
        let minuteRange = Range(match.range(at: 2), in: text)
        let minute = minuteRange.flatMap { Int(text[$0]) } ?? 0
        guard minute < 60, minuteRange != nil || match.range(at: 3).location != NSNotFound else { return nil }
        if let suffix = Range(match.range(at: 3), in: text) {
            guard (1...12).contains(hour) else { return nil }
            hour = hour % 12 + (text[suffix].uppercased() == "PM" ? 12 : 0)
        }
        guard (0...23).contains(hour) else { return nil }
        return calendar.nextDate(after: now, matching: DateComponents(hour: hour, minute: minute), matchingPolicy: .nextTime)
    }
}
