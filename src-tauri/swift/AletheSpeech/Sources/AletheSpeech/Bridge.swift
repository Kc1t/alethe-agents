import AVFoundation
import Foundation

struct LocaleInfo: Codable, Equatable {
    let id: String
    let name: String
    let installed: Bool
}

enum Outcome {
    case text(String)
    case error(String)
}

struct TranscribeResult: Codable {
    var text: String?
    var error: String?

    init(_ outcome: Outcome) {
        switch outcome {
        case .text(let value): text = value
        case .error(let value): error = value
        }
    }
}

/// Result slot written by a detached task and read by the waiting C entry point.
final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T?

    var value: T? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}

/// Helpers shared by the recognizers and the C entry points. Kept free of Speech-framework calls so
/// they can be tested on any Mac.
enum Bridge {
    static func bcp47(_ locale: Locale) -> String {
        locale.identifier.replacingOccurrences(of: "_", with: "-")
    }

    static func displayName(_ id: String) -> String {
        Locale.current.localizedString(forIdentifier: id) ?? id
    }

    static func encode<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value), let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }

    static func joinSegments(_ segments: [String]) -> String {
        segments
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Seconds a transcription may take: twice the audio's length, never under 30 s, so a long
    /// capture on a slow engine finishes while a stuck call still gives up.
    static func transcribeTimeout(count: Int, sampleRate: Int32) -> Double {
        guard sampleRate > 0 else { return 30 }
        return max(30, 2 * Double(count) / Double(sampleRate))
    }

    /// macOS terminates a process that asks for speech-recognition access without this key.
    static func usageDescriptionPresent(in info: [String: Any]) -> Bool {
        guard let text = info["NSSpeechRecognitionUsageDescription"] as? String else { return false }
        return !text.isEmpty
    }

    static func makeBuffer(_ samples: UnsafeBufferPointer<Float>, sampleRate: Double) -> AVAudioPCMBuffer? {
        guard
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        if let source = samples.baseAddress, let channel = buffer.floatChannelData?[0] {
            channel.update(from: source, count: samples.count)
        }
        return buffer
    }

    static func convert(_ input: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        if input.format == format { return input }
        guard let converter = AVAudioConverter(from: input.format, to: format) else { return nil }
        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1_024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var consumed = false
        var failure: NSError?
        let status = converter.convert(to: output, error: &failure) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .endOfStream
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return input
        }
        return status == .error ? nil : output
    }

    /// Runs async work from a synchronous C entry point and waits for it. Rust calls every entry point
    /// from a blocking worker thread, never the main thread, so waiting here cannot deadlock the UI.
    static func blocking<T>(timeout: TimeInterval, _ work: @escaping @Sendable () async -> T) -> T? {
        let box = Box<T>()
        let done = DispatchSemaphore(value: 0)
        let task = Task.detached {
            box.value = await work()
            done.signal()
        }
        guard done.wait(timeout: .now() + timeout) == .success else {
            task.cancel()
            return nil
        }
        return box.value
    }
}
