import Foundation
import Speech

private func statusCode(_ status: SFSpeechRecognizerAuthorizationStatus) -> Int32 {
    switch status {
    case .authorized: return 3
    case .restricted: return 2
    case .denied: return 1
    default: return 0
    }
}

private let missingUsageDescription: Int32 = 4

/// The bridge runs on Swift concurrency, whose runtime ships with macOS 12 and later; on 10.15/11
/// the first task would crash. Checked before any other entry point, and uses no concurrency itself.
@_cdecl("alethe_speech_supported")
public func aletheSpeechSupported() -> Bool {
    if #available(macOS 12.0, *) {
        return true
    } else {
        return false
    }
}

@_cdecl("alethe_speech_authorization_status")
public func aletheSpeechAuthorizationStatus() -> Int32 {
    statusCode(SFSpeechRecognizer.authorizationStatus())
}

@_cdecl("alethe_speech_authorize")
public func aletheSpeechAuthorize() -> Int32 {
    let current = SFSpeechRecognizer.authorizationStatus()
    guard current == .notDetermined else { return statusCode(current) }
    guard Bridge.usageDescriptionPresent(in: Bundle.main.infoDictionary ?? [:]) else {
        return missingUsageDescription
    }
    let done = DispatchSemaphore(value: 0)
    let granted = Box<SFSpeechRecognizerAuthorizationStatus>()
    SFSpeechRecognizer.requestAuthorization { status in
        granted.value = status
        done.signal()
    }
    _ = done.wait(timeout: .now() + 120)
    return statusCode(granted.value ?? current)
}

@_cdecl("alethe_speech_locales")
public func aletheSpeechLocales() -> UnsafeMutablePointer<CChar>? {
    let locales = Bridge.blocking(timeout: 20) { await Recognition.locales() } ?? []
    return strdup(Bridge.encode(locales))
}

@_cdecl("alethe_speech_install")
public func aletheSpeechInstall(_ locale: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let id = String(cString: locale)
    switch Bridge.blocking(timeout: 3_600, { await Recognition.install(id) }) {
    case .none: return strdup("timeout")
    case .some(.none): return nil
    case .some(.some(let reason)): return strdup(reason)
    }
}

@_cdecl("alethe_speech_install_progress")
public func aletheSpeechInstallProgress(_ locale: UnsafePointer<CChar>) -> Double {
    InstallProgress.shared.fraction(String(cString: locale))
}

@_cdecl("alethe_speech_transcribe")
public func aletheSpeechTranscribe(
    _ samples: UnsafePointer<Float>,
    _ count: Int,
    _ sampleRate: Int32,
    _ locale: UnsafePointer<CChar>
) -> UnsafeMutablePointer<CChar>? {
    let id = String(cString: locale)
    let pcm = Array(UnsafeBufferPointer(start: samples, count: count))
    let timeout = Bridge.transcribeTimeout(count: count, sampleRate: sampleRate)
    let outcome = Bridge.blocking(timeout: timeout) {
        await Recognition.transcribe(pcm, sampleRate: Double(sampleRate), locale: id)
    } ?? .error("timeout")
    return strdup(Bridge.encode(TranscribeResult(outcome)))
}

@_cdecl("alethe_speech_free")
public func aletheSpeechFree(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}
