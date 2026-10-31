import AVFoundation
import Foundation
import Speech

/// Progress of running locale installs, read by `alethe_speech_install_progress`.
final class InstallProgress: @unchecked Sendable {
    static let shared = InstallProgress()
    private let lock = NSLock()
    private var running: [String: Progress] = [:]

    func set(_ id: String, _ progress: Progress?) {
        lock.lock()
        running[id] = progress
        lock.unlock()
    }

    func fraction(_ id: String) -> Double {
        lock.lock()
        defer { lock.unlock() }
        return running[id].map(\.fractionCompleted) ?? -1
    }
}

enum Recognition {
    static func locales() async -> [LocaleInfo] {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
            let installed = Set(await SpeechTranscriber.installedLocales.map(Bridge.bcp47))
            return await SpeechTranscriber.supportedLocales
                .map { locale -> LocaleInfo in
                    let id = Bridge.bcp47(locale)
                    return LocaleInfo(id: id, name: Bridge.displayName(id), installed: installed.contains(id))
                }
                .sorted { $0.name < $1.name }
        }
        #endif
        return SFSpeechRecognizer.supportedLocales()
            .compactMap { locale -> LocaleInfo? in
                guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
                    return nil
                }
                let id = Bridge.bcp47(locale)
                return LocaleInfo(id: id, name: Bridge.displayName(id), installed: true)
            }
            .sorted { $0.name < $1.name }
    }

    /// nil on success, otherwise the reason.
    static func install(_ id: String) async -> String? {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
            let locale = Locale(identifier: id)
            let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
            do {
                _ = try? await AssetInventory.reserve(locale: locale)
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    InstallProgress.shared.set(id, request.progress)
                    defer { InstallProgress.shared.set(id, nil) }
                    try await request.downloadAndInstall()
                }
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        #endif
        return "install_unsupported"
    }

    static func transcribe(_ samples: [Float], sampleRate: Double, locale id: String) async -> Outcome {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
            return await transcribeWithAnalyzer(samples, sampleRate: sampleRate, locale: id)
        }
        #endif
        return await transcribeWithRecognizer(samples, sampleRate: sampleRate, locale: id)
    }

    #if compiler(>=6.2)
    @available(macOS 26.0, *)
    private static func transcribeWithAnalyzer(_ samples: [Float], sampleRate: Double, locale id: String) async -> Outcome {
        let transcriber = SpeechTranscriber(locale: Locale(identifier: id), preset: .transcription)
        guard let input = samples.withUnsafeBufferPointer({ Bridge.makeBuffer($0, sampleRate: sampleRate) }) else {
            return .error("audio_buffer")
        }
        // No format means the language assets are missing; a raw Float32 buffer can trap in Speech.
        guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            return .error("assets_missing")
        }
        guard let buffer = Bridge.convert(input, to: target) else { return .error("audio_convert") }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Task { () throws -> [String] in
            var segments: [String] = []
            for try await result in transcriber.results where result.isFinal {
                segments.append(String(result.text.characters))
            }
            return segments
        }
        do {
            let stream = AsyncStream<AnalyzerInput> { continuation in
                continuation.yield(AnalyzerInput(buffer: buffer))
                continuation.finish()
            }
            _ = try await analyzer.analyzeSequence(stream)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            return .text(Bridge.joinSegments(try await collector.value))
        } catch {
            collector.cancel()
            return .error(error.localizedDescription)
        }
    }
    #endif

    private static func transcribeWithRecognizer(_ samples: [Float], sampleRate: Double, locale id: String) async -> Outcome {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: id)) else {
            return .error("locale_unsupported")
        }
        // Never Apple's servers: a locale without local support is refused, not sent away.
        guard recognizer.supportsOnDeviceRecognition else { return .error("on_device_unavailable") }
        guard let buffer = samples.withUnsafeBufferPointer({ Bridge.makeBuffer($0, sampleRate: sampleRate) }) else {
            return .error("audio_buffer")
        }
        // The default callback queue is the main queue; keep results off it.
        recognizer.queue = OperationQueue()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.append(buffer)
        request.endAudio()
        // The recognizer, request and task must outlive the suspension; optimized builds would
        // otherwise release them and the callback would never fire.
        let task = Box<SFSpeechRecognitionTask>()
        let outcome = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
                let lock = NSLock()
                var resumed = false
                func finish(_ outcome: Outcome) {
                    lock.lock()
                    defer { lock.unlock() }
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: outcome)
                }
                task.value = recognizer.recognitionTask(with: request) { result, error in
                    if let result, result.isFinal {
                        finish(.text(result.bestTranscription.formattedString))
                    } else if let error {
                        finish(.error(error.localizedDescription))
                    }
                }
            }
        } onCancel: {
            task.value?.cancel()
        }
        withExtendedLifetime((recognizer, request, task)) {}
        return outcome
    }
}
