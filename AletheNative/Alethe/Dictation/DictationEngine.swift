import AVFoundation
import Foundation
import Speech

/// On-device speech to text (ADR-7a): the microphone through `AVAudioEngine`, converted to the
/// analyzer's format, into `SpeechAnalyzer` with a `SpeechTranscriber`. Results arrive on the main
/// actor; volatile ones are replaced by the final text of the same stretch.
final class DictationEngine: @unchecked Sendable {
    enum StartError: Error { case languageUnsupported, unavailable }

    private let audio = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var tapInstalled = false

    /// Starts listening in `locale`'s language (the nearest supported one), installing its speech model
    /// on first use.
    func start(locale: Locale, microphone: String = "", onModelDownload: @escaping @MainActor () -> Void,
               onResult: @escaping @MainActor (_ text: String, _ isFinal: Bool) -> Void) async throws {
        guard SpeechTranscriber.isAvailable else { throw StartError.unavailable }
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw StartError.languageUnsupported
        }
        let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [],
                                            reportingOptions: [.volatileResults], attributeOptions: [])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            await onModelDownload()
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw StartError.unavailable
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        input = continuation
        results = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    await onResult(text, result.isFinal)
                }
            } catch {}
        }
        try await analyzer.start(inputSequence: stream)

        try Self.selectMicrophone(microphone, audio: audio)
        let node = audio.inputNode
        let source = node.outputFormat(forBus: 0)
        guard source.sampleRate > 0, let converter = AVAudioConverter(from: source, to: format) else {
            throw StartError.unavailable
        }
        node.installTap(onBus: 0, bufferSize: 4096, format: source) { buffer, _ in
            guard let converted = Self.convert(buffer, with: converter, to: format) else { return }
            continuation.yield(AnalyzerInput(buffer: converted))
        }
        tapInstalled = true
        audio.prepare()
        try audio.start()
    }

    /// Stops the microphone and waits for the last words.
    func stop() async {
        stopAudio()
        input?.finish()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await results?.value
        reset()
    }

    /// Stops without waiting; nothing more is reported.
    func cancel() async {
        stopAudio()
        results?.cancel()
        input?.finish()
        await analyzer?.cancelAndFinishNow()
        reset()
    }

    private func stopAudio() {
        if audio.isRunning { audio.stop() }
        if tapInstalled {
            audio.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private func reset() {
        analyzer = nil
        input = nil
        results = nil
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if supplied {
                state.pointee = .noDataNow
                return nil
            }
            supplied = true
            state.pointee = .haveData
            return buffer
        }
        return status == .error || output.frameLength == 0 ? nil : output
    }
}
