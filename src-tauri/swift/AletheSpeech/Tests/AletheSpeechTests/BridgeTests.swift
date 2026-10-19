import AVFoundation
import Foundation
import Testing

@testable import AletheSpeech

@Test func buffersCarryEverySample() {
    let samples: [Float] = [0.1, 0.2, 0.3]
    let buffer = samples.withUnsafeBufferPointer { Bridge.makeBuffer($0, sampleRate: 16_000) }
    #expect(buffer?.frameLength == 3)
    #expect(buffer?.format.sampleRate == 16_000)
    #expect(buffer?.floatChannelData?[0][2] == 0.3)
}

@Test func convertsToAnotherSampleRate() throws {
    let samples = [Float](repeating: 0.25, count: 1_600)
    let input = try #require(samples.withUnsafeBufferPointer { Bridge.makeBuffer($0, sampleRate: 16_000) })
    let target = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false))
    let output = try #require(Bridge.convert(input, to: target))
    #expect(output.format.sampleRate == 48_000)
    #expect(abs(Int(output.frameLength) - 4_800) < 128)
}

@Test func returnsTheSameBufferWhenTheFormatAlreadyMatches() throws {
    let samples: [Float] = [0.1, 0.2]
    let input = try #require(samples.withUnsafeBufferPointer { Bridge.makeBuffer($0, sampleRate: 16_000) })
    #expect(Bridge.convert(input, to: input.format) === input)
}

@Test func localeIdsUseHyphens() {
    #expect(Bridge.bcp47(Locale(identifier: "pt_BR")) == "pt-BR")
    #expect(Bridge.bcp47(Locale(identifier: "en-US")) == "en-US")
}

@Test func localesEncodeAsSortedJson() {
    let json = Bridge.encode([LocaleInfo(id: "pt-BR", name: "Portuguese (Brazil)", installed: true)])
    #expect(json == #"[{"id":"pt-BR","installed":true,"name":"Portuguese (Brazil)"}]"#)
}

@Test func transcriptionResultsEncodeOneField() {
    #expect(Bridge.encode(TranscribeResult(.text("oi"))) == #"{"text":"oi"}"#)
    #expect(Bridge.encode(TranscribeResult(.error("timeout"))) == #"{"error":"timeout"}"#)
}

@Test func segmentsJoinWithSingleSpaces() {
    #expect(Bridge.joinSegments(["Olá,", " tudo bem? ", "", "Sim."]) == "Olá, tudo bem? Sim.")
}

@Test func blockingWorkTimesOut() {
    let value: Int? = Bridge.blocking(timeout: 0.2) {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        return 1
    }
    #expect(value == nil)
}

@Test func blockingWorkReturnsItsValue() {
    let value: Int? = Bridge.blocking(timeout: 5) { 42 }
    #expect(value == 42)
}

@Test func authorizationNeedsAUsageDescription() {
    #expect(Bridge.usageDescriptionPresent(in: ["NSSpeechRecognitionUsageDescription": "x"]))
    #expect(!Bridge.usageDescriptionPresent(in: [:]))
    #expect(!Bridge.usageDescriptionPresent(in: ["NSSpeechRecognitionUsageDescription": ""]))
}

@Test func timedOutWorkIsCancelled() {
    let cancelled = Box<Bool>()
    let value: Int? = Bridge.blocking(timeout: 0.1) {
        do {
            try await Task.sleep(nanoseconds: 2_000_000_000)
        } catch {
            cancelled.value = Task.isCancelled
        }
        return 1
    }
    #expect(value == nil)
    let deadline = Date().addingTimeInterval(1)
    while cancelled.value == nil, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.01)
    }
    #expect(cancelled.value == true)
}

@Test func transcriptionTimeoutScalesWithTheAudio() {
    #expect(Bridge.transcribeTimeout(count: 16_000, sampleRate: 16_000) == 30)
    #expect(Bridge.transcribeTimeout(count: 16_000 * 15, sampleRate: 16_000) == 30)
    #expect(Bridge.transcribeTimeout(count: 16_000 * 60, sampleRate: 16_000) == 120)
    #expect(Bridge.transcribeTimeout(count: 48_000 * 40, sampleRate: 48_000) == 80)
    #expect(Bridge.transcribeTimeout(count: 16_000, sampleRate: 0) == 30)
    #expect(Bridge.transcribeTimeout(count: 16_000, sampleRate: -1) == 30)
}

@Test func theNativeEngineIsSupportedOnThisMac() {
    // The test host runs macOS 12+, where the Swift concurrency runtime ships with the OS.
    #expect(aletheSpeechSupported())
}
