# Native macOS Speech-to-Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Mac, transcribe dictation and voice conversation with Apple's on-device recognizer (SpeechAnalyzer on macOS 26+, SFSpeechRecognizer before), selectable next to the sherpa models.

**Architecture:** A Swift package (`src-tauri/swift/AletheSpeech`) exposes plain C functions; `build.rs` builds and links it on macOS through `swift-rs`'s `SwiftLinker` and sets `cfg(apple_speech_linked)`. Rust wraps it behind an `AppleBridge` trait (`speech_apple.rs`) and dispatches every speech command by model id through a `Transcriber` trait, so `apple-speech` is just one more catalog entry. The frontend gains a model picker, a native-language picker, one `speechEngineArgs` helper for the three consumers, and a one-time default switch.

**Tech Stack:** Swift 6 toolchain (Swift 5 language mode), Speech + AVFoundation frameworks, `swift-rs` 1.0.9 (build-dependency only), Rust/Tauri 2, React/TS, Vitest, Swift Testing.

**Spec:** [`docs/superpowers/specs/2026-10-14-macos-native-stt-design.md`](../specs/2026-10-14-macos-native-stt-design.md) — read it before any task.

## Global Constraints

- **Never commit, push, tag or release** (CLAUDE.md §3.2). Leave changes in the working tree; each task ends with a checkpoint.
- **Never start, stop or restart the app** (`npm run app` / `tauri dev`).
- **On-device only:** never use Apple's server recognition. `SFSpeechAudioBufferRecognitionRequest.requiresOnDeviceRecognition = true`; locales without `supportsOnDeviceRecognition` are not listed.
- **Model id** of the native engine: `apple-speech`. Catalog `kind`: `native` (sherpa entries: `download`).
- **Locale ids** are BCP-47 with a hyphen (`pt-BR`, `en-US`).
- **`dictationNativeLocale`** default `null`, device-specific, **not** added to `cloudSync.ts`.
- **`speechEngineMigrated`** default `false`, not synced.
- **Swift package** deployment target macOS **10.15**; SpeechAnalyzer code behind `#if compiler(>=6.2)` and `if #available(macOS 26.0, *)`. The native engine needs macOS **12+** (Swift concurrency runtime): `alethe_speech_supported()` gates `bridge()`, so 10.15/11 show no native engine.
- **Transcription timeout** in the bridge: **max(30 s, 2 × the audio's duration)**. Install timeout: **3600 s**. Install progress polling: **200 ms**.
- **Windows / Linux:** no Swift is built; `apple-speech` never appears; behaviour unchanged.
- **i18n:** every visible string through `t()`, keys in `en.ts`, `pt-BR.ts`, `zh-CN.ts`.
- **Styling:** CSS Modules + `src/styles/theme.css` tokens only; no hardcoded colors, no gradients.
- **English** code, comments, docs, changelog.
- CI runs `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `cargo check`, `cargo clippy --all-targets`, `cargo test` (mac runner included): keep touched files clean (`npx prettier --write`, `npx eslint`, no new clippy warnings). Known pre-existing failures: `npm run build` TS2550 ×2 (`CustomAgentsSection.tsx:102`, `customAgents.ts:168`), 6 pre-existing `format:check` files.
- Commands: `npx vitest run <file>`; `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>`; `swift test --package-path src-tauri/swift/AletheSpeech`.

## Review Focus

1. **A Mac with no Swift toolchain** (or Windows/Linux) must still build and run; `apple-speech` simply absent. Pinned in Task 2 (build.rs skip path) and Task 4 (catalog test with no bridge).
2. **`apple-speech` selected with no language** must never open the mic in dictation, the Jev bar or voice conversation. Pinned in Task 6 tests for all three consumers.
3. **Requesting speech authorization without a usage description crashes the process on macOS.** The bridge must check `NSSpeechRecognitionUsageDescription` exists before calling `requestAuthorization`. Pinned in Task 1 (`usageDescriptionPresent` guard + test of the pure check) and Task 2 (Info.plist key test).
4. **A saved Parakeet choice (downloaded) must survive the default switch**, and the switch must run only once. Pinned in Task 5 migration tests.
5. **The bridge hanging** (recognizer never calls back) must not freeze the app: 30 s timeout returns an error, and calls run on blocking threads. Pinned in Task 1 (`blocking` timeout test) and Task 4 (commands use `spawn_blocking`).

---

### Task 1: Swift bridge package

**Files:**
- Create: `src-tauri/swift/AletheSpeech/Package.swift`
- Create: `src-tauri/swift/AletheSpeech/Sources/AletheSpeech/Bridge.swift` (pure helpers)
- Create: `src-tauri/swift/AletheSpeech/Sources/AletheSpeech/Recognition.swift` (Apple API calls)
- Create: `src-tauri/swift/AletheSpeech/Sources/AletheSpeech/Exports.swift` (`@_cdecl` entry points)
- Create: `src-tauri/swift/AletheSpeech/Tests/AletheSpeechTests/BridgeTests.swift`
- Modify: `.gitignore` (add `src-tauri/swift/AletheSpeech/.build/`)

**Interfaces:**
- Produces (C ABI, all strings UTF-8, returned pointers freed with `alethe_speech_free`):
  ```c
  int32_t alethe_speech_authorization_status(void);   // 0 notDetermined, 1 denied, 2 restricted, 3 authorized, 4 missing usage description
  int32_t alethe_speech_authorize(void);              // same codes; prompts when notDetermined
  char*   alethe_speech_locales(void);                // JSON [{"id","installed","name"}]
  char*   alethe_speech_install(const char* locale);  // NULL on success, else error text
  double  alethe_speech_install_progress(const char* locale); // 0..1, or -1 when no install is running
  char*   alethe_speech_transcribe(const float* samples, intptr_t count, int32_t sample_rate, const char* locale); // JSON {"text":…} or {"error":…}
  void    alethe_speech_free(char* ptr);
  ```

- [ ] **Step 1: Package manifest.** `src-tauri/swift/AletheSpeech/Package.swift`:

```swift
// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "AletheSpeech",
    platforms: [.macOS(.v10_15)],
    products: [
        .library(name: "AletheSpeech", type: .static, targets: ["AletheSpeech"]),
    ],
    targets: [
        .target(
            name: "AletheSpeech",
            linkerSettings: [.linkedFramework("Speech"), .linkedFramework("AVFoundation")]
        ),
        .testTarget(name: "AletheSpeechTests", dependencies: ["AletheSpeech"]),
    ],
    swiftLanguageModes: [.v5]
)
```

Add `src-tauri/swift/AletheSpeech/.build/` to `.gitignore`.

- [ ] **Step 2: Write the failing tests.** `Tests/AletheSpeechTests/BridgeTests.swift` (Swift Testing — the Command Line Tools ship `Testing.framework`, not XCTest):

```swift
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `swift test --package-path src-tauri/swift/AletheSpeech`
Expected: FAIL to compile (`Bridge` not found).

- [ ] **Step 4: Pure helpers** — `Sources/AletheSpeech/Bridge.swift`:

```swift
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
            channel.assign(from: source, count: samples.count)
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
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var value: T?
        }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            let value = await work()
            box.lock.lock()
            box.value = value
            box.lock.unlock()
            done.signal()
        }
        guard done.wait(timeout: .now() + timeout) == .success else { return nil }
        box.lock.lock()
        defer { box.lock.unlock() }
        return box.value
    }
}
```

If the compiler rejects the generic local class `Box`, hoist it to a file-level `final class Box<T>: @unchecked Sendable` with the same members.

- [ ] **Step 5: Run the tests**

Run: `swift test --package-path src-tauri/swift/AletheSpeech`
Expected: PASS (all 10). If `Testing` cannot be imported with the installed toolchain, record the exact error in the report and continue (CI's Xcode runs it).

- [ ] **Step 6: Recognizers** — `Sources/AletheSpeech/Recognition.swift` (verify each Speech call against the SDK's `Speech.swiftmodule/arm64e-apple-macos.swiftinterface`; the names below were read from the macOS 26 SDK):

```swift
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
        if #available(macOS 26.0, *) {
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
        if #available(macOS 26.0, *) {
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
        if #available(macOS 26.0, *) {
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
        let buffer: AVAudioPCMBuffer
        if let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) {
            guard let converted = Bridge.convert(input, to: target) else { return .error("audio_convert") }
            buffer = converted
        } else {
            buffer = input
        }
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
        return await withCheckedContinuation { continuation in
            let lock = NSLock()
            var resumed = false
            func finish(_ outcome: Outcome) {
                lock.lock()
                defer { lock.unlock() }
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: outcome)
            }
            _ = recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    finish(.text(result.bestTranscription.formattedString))
                } else if let error {
                    finish(.error(error.localizedDescription))
                }
            }
        }
    }
}
```

- [ ] **Step 7: C entry points** — `Sources/AletheSpeech/Exports.swift`:

```swift
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
    var granted = current
    SFSpeechRecognizer.requestAuthorization { status in
        granted = status
        done.signal()
    }
    _ = done.wait(timeout: .now() + 120)
    return statusCode(granted)
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
    let outcome = Bridge.blocking(timeout: 30) {
        await Recognition.transcribe(pcm, sampleRate: Double(sampleRate), locale: id)
    } ?? .error("timeout")
    return strdup(Bridge.encode(TranscribeResult(outcome)))
}

@_cdecl("alethe_speech_free")
public func aletheSpeechFree(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}
```

- [ ] **Step 8: Build and test the package**

Run: `swift build --package-path src-tauri/swift/AletheSpeech -c release` then `swift test --package-path src-tauri/swift/AletheSpeech`
Expected: both succeed (fix compile errors against the real SDK; keep behaviour as written).

- [ ] **Step 9: Checkpoint** — working tree only, no commit.

---

### Task 2: Link the bridge into the Tauri build (macOS only)

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[target.'cfg(target_os = "macos")'.build-dependencies]`, `[lints.rust]` check-cfg)
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/tauri.conf.json` (`bundle.macOS.minimumSystemVersion`)
- Modify: `src-tauri/Info.plist` (`NSSpeechRecognitionUsageDescription`)
- Modify: `src/bundleInfoPlist.test.ts`

**Interfaces:**
- Consumes: the Swift package from Task 1.
- Produces: `cfg(apple_speech_linked)` set when the bridge is linked; the C symbols of Task 1 available to Rust.

- [ ] **Step 1: Failing test** — extend `src/bundleInfoPlist.test.ts`:

```ts
  it('explains why Alethe uses speech recognition', () => {
    const plist = readFileSync(resolve('src-tauri/Info.plist'), 'utf8')
    expect(plist).toMatch(
      /<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/,
    )
  })

  it('targets a macOS the Swift runtime supports', () => {
    const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'))
    expect(config.bundle.macOS.minimumSystemVersion).toBe('10.15')
  })
```

Run: `npx vitest run src/bundleInfoPlist.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement config.** In `src-tauri/Info.plist`, inside `<dict>`:

```xml
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Alethe uses Apple's on-device speech recognition when you pick it for dictation and voice conversation.</string>
```

In `src-tauri/tauri.conf.json`, inside `"bundle"` add `"macOS": { "minimumSystemVersion": "10.15" }` (the Swift runtime needs 10.15+). Do not touch the CSP. Run `npx vitest run src/bundleInfoPlist.test.ts src/securityPolicy.test.ts` — Expected: PASS.

- [ ] **Step 3: Build dependency.** `src-tauri/Cargo.toml`, below the existing `[target.'cfg(target_os = "macos")'.build-dependencies]` `cc = "1"` line:

```toml
swift-rs = { version = "1.0.9", features = ["build"] }
```

and in `[lints.rust]` extend the check-cfg list: `check-cfg = ["cfg(ghostty_linked)", "cfg(apple_speech_linked)"]` (translate the Portuguese comment above it to English while there).

- [ ] **Step 4: `build.rs`.** Call a new function from `main()` next to `link_libghostty()`:

```rust
    #[cfg(target_os = "macos")]
    link_apple_speech();
```

and add:

```rust
/// Builds and links the Swift bridge to Apple's speech recognition (src-tauri/swift/AletheSpeech).
/// Without a Swift toolchain the app still builds; the native engine is then simply absent.
/// Release builds require it, so a Mac release never ships without the native engine by accident.
#[cfg(target_os = "macos")]
fn link_apple_speech() {
    println!("cargo:rustc-check-cfg=cfg(apple_speech_linked)");
    println!("cargo:rerun-if-changed=swift/AletheSpeech/Package.swift");
    println!("cargo:rerun-if-changed=swift/AletheSpeech/Sources");
    let has_swift = std::process::Command::new("swift")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !has_swift {
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            panic!("a Swift toolchain is required for macOS release builds (Apple speech recognition)");
        }
        println!("cargo:warning=no Swift toolchain found: building without Apple speech recognition");
        return;
    }
    swift_rs::SwiftLinker::new("10.15")
        .with_package("AletheSpeech", "./swift/AletheSpeech")
        .link();
    println!("cargo:rustc-cfg=apple_speech_linked");
}
```

- [ ] **Step 5: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml` — Expected: builds; on this Mac the build log shows the Swift package compiling (no warning about a missing toolchain).
Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib speech` — Expected: existing tests pass (linking works in the test binary).

- [ ] **Step 6: Checkpoint** — working tree only, no commit.

---

### Task 3: Rust bridge wrapper (`speech_apple.rs`)

**Files:**
- Create: `src-tauri/src/speech_apple.rs`
- Modify: `src-tauri/src/lib.rs` (`mod speech_apple;`)

**Interfaces:**
- Consumes: the C ABI of Task 1, `cfg(apple_speech_linked)` from Task 2.
- Produces:
  ```rust
  pub struct NativeLocale { pub id: String, pub name: String, pub installed: bool }   // Serialize camelCase
  pub enum Authorization { NotDetermined, Denied, Restricted, Authorized, MissingUsageDescription }
  pub trait AppleBridge: Send + Sync {
      fn authorization(&self) -> Authorization;
      fn request_authorization(&self) -> Authorization;
      fn locales(&self) -> Vec<NativeLocale>;
      fn install(&self, locale: &str) -> Result<(), String>;
      fn install_progress(&self, locale: &str) -> Option<f64>;
      fn transcribe(&self, samples: &[f32], sample_rate: u32, locale: &str) -> Result<String, String>;
  }
  pub fn bridge() -> Option<&'static dyn AppleBridge>
  pub fn native_status(auth: Authorization, locales: &[NativeLocale], locale: Option<&str>) -> &'static str
  pub fn parse_locales(json: &str) -> Vec<NativeLocale>
  pub fn parse_transcription(json: &str) -> Result<String, String>
  ```

- [ ] **Step 1: Failing tests** — at the end of the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn locale(id: &str, installed: bool) -> NativeLocale {
        NativeLocale { id: id.into(), name: id.into(), installed }
    }

    #[test]
    fn authorization_codes_map_to_states() {
        assert_eq!(Authorization::from_code(0), Authorization::NotDetermined);
        assert_eq!(Authorization::from_code(1), Authorization::Denied);
        assert_eq!(Authorization::from_code(2), Authorization::Restricted);
        assert_eq!(Authorization::from_code(3), Authorization::Authorized);
        assert_eq!(Authorization::from_code(4), Authorization::MissingUsageDescription);
        assert_eq!(Authorization::from_code(99), Authorization::Denied);
    }

    #[test]
    fn status_follows_permission_then_locale() {
        let locales = [locale("pt-BR", true), locale("en-US", false)];
        assert_eq!(native_status(Authorization::Denied, &locales, Some("pt-BR")), "denied");
        assert_eq!(native_status(Authorization::Restricted, &locales, Some("pt-BR")), "denied");
        assert_eq!(native_status(Authorization::MissingUsageDescription, &locales, Some("pt-BR")), "denied");
        assert_eq!(native_status(Authorization::Authorized, &locales, None), "needs-locale");
        assert_eq!(native_status(Authorization::Authorized, &locales, Some("")), "needs-locale");
        assert_eq!(native_status(Authorization::Authorized, &locales, Some("fr-FR")), "unavailable");
        assert_eq!(native_status(Authorization::Authorized, &locales, Some("en-US")), "not-installed");
        assert_eq!(native_status(Authorization::Authorized, &locales, Some("pt-BR")), "ready");
        // Permission is asked when capture starts, so an undecided one does not block readiness.
        assert_eq!(native_status(Authorization::NotDetermined, &locales, Some("pt-BR")), "ready");
    }

    #[test]
    fn locales_parse_and_bad_json_is_empty() {
        assert_eq!(
            parse_locales(r#"[{"id":"pt-BR","installed":true,"name":"Português"}]"#),
            vec![NativeLocale { id: "pt-BR".into(), name: "Português".into(), installed: true }]
        );
        assert!(parse_locales("not json").is_empty());
    }

    #[test]
    fn transcription_results_parse() {
        assert_eq!(parse_transcription(r#"{"text":" oi "}"#), Ok("oi".to_string()));
        assert_eq!(parse_transcription(r#"{"error":"timeout"}"#), Err("timeout".to_string()));
        assert!(parse_transcription("garbage").is_err());
    }

    #[test]
    fn the_bridge_exists_only_when_linked() {
        assert_eq!(bridge().is_some(), cfg!(apple_speech_linked));
    }
}
```

Add `mod speech_apple;` to `lib.rs` (alphabetical, after `mod speech;`). Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib speech_apple` — Expected: FAIL to compile.

- [ ] **Step 2: Implement** (above the tests):

```rust
//! Apple's on-device speech recognition, through the Swift bridge in `src-tauri/swift/AletheSpeech`.
//! Every call blocks; callers run it on a blocking worker thread.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLocale {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authorization {
    NotDetermined,
    Denied,
    Restricted,
    Authorized,
    /// The running binary has no `NSSpeechRecognitionUsageDescription`; asking would crash it.
    MissingUsageDescription,
}

impl Authorization {
    pub fn from_code(code: i32) -> Self {
        match code {
            0 => Self::NotDetermined,
            2 => Self::Restricted,
            3 => Self::Authorized,
            4 => Self::MissingUsageDescription,
            _ => Self::Denied,
        }
    }
}

pub trait AppleBridge: Send + Sync {
    fn authorization(&self) -> Authorization;
    fn request_authorization(&self) -> Authorization;
    fn locales(&self) -> Vec<NativeLocale>;
    fn install(&self, locale: &str) -> Result<(), String>;
    fn install_progress(&self, locale: &str) -> Option<f64>;
    fn transcribe(&self, samples: &[f32], sample_rate: u32, locale: &str) -> Result<String, String>;
}

pub fn native_status(auth: Authorization, locales: &[NativeLocale], locale: Option<&str>) -> &'static str {
    if matches!(
        auth,
        Authorization::Denied | Authorization::Restricted | Authorization::MissingUsageDescription
    ) {
        return "denied";
    }
    let Some(id) = locale.filter(|id| !id.is_empty()) else {
        return "needs-locale";
    };
    match locales.iter().find(|candidate| candidate.id == id) {
        None => "unavailable",
        Some(found) if !found.installed => "not-installed",
        Some(_) => "ready",
    }
}

pub fn parse_locales(json: &str) -> Vec<NativeLocale> {
    serde_json::from_str(json).unwrap_or_default()
}

#[derive(Deserialize)]
struct TranscribeResult {
    text: Option<String>,
    error: Option<String>,
}

pub fn parse_transcription(json: &str) -> Result<String, String> {
    let result: TranscribeResult =
        serde_json::from_str(json).map_err(|e| format!("apple speech: bad result: {e}"))?;
    match (result.text, result.error) {
        (_, Some(error)) => Err(error),
        (Some(text), None) => Ok(text.trim().to_string()),
        (None, None) => Err("apple speech: empty result".to_string()),
    }
}

#[cfg(apple_speech_linked)]
mod linked {
    use super::{parse_locales, parse_transcription, AppleBridge, Authorization, NativeLocale};
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    extern "C" {
        fn alethe_speech_authorization_status() -> i32;
        fn alethe_speech_authorize() -> i32;
        fn alethe_speech_locales() -> *mut c_char;
        fn alethe_speech_install(locale: *const c_char) -> *mut c_char;
        fn alethe_speech_install_progress(locale: *const c_char) -> f64;
        fn alethe_speech_transcribe(
            samples: *const f32,
            count: isize,
            sample_rate: i32,
            locale: *const c_char,
        ) -> *mut c_char;
        fn alethe_speech_free(ptr: *mut c_char);
    }

    /// Copies and frees a string the bridge allocated; `None` for a null pointer.
    fn take(ptr: *mut c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        // SAFETY: the bridge returns a NUL-terminated strdup'd buffer, freed exactly once here.
        let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { alethe_speech_free(ptr) };
        Some(text)
    }

    fn c_locale(locale: &str) -> Result<CString, String> {
        CString::new(locale).map_err(|_| "apple speech: invalid locale".to_string())
    }

    pub struct Linked;

    impl AppleBridge for Linked {
        fn authorization(&self) -> Authorization {
            Authorization::from_code(unsafe { alethe_speech_authorization_status() })
        }

        fn request_authorization(&self) -> Authorization {
            Authorization::from_code(unsafe { alethe_speech_authorize() })
        }

        fn locales(&self) -> Vec<NativeLocale> {
            take(unsafe { alethe_speech_locales() })
                .map(|json| parse_locales(&json))
                .unwrap_or_default()
        }

        fn install(&self, locale: &str) -> Result<(), String> {
            let id = c_locale(locale)?;
            match take(unsafe { alethe_speech_install(id.as_ptr()) }) {
                None => Ok(()),
                Some(reason) => Err(reason),
            }
        }

        fn install_progress(&self, locale: &str) -> Option<f64> {
            let id = c_locale(locale).ok()?;
            let fraction = unsafe { alethe_speech_install_progress(id.as_ptr()) };
            (fraction >= 0.0).then_some(fraction)
        }

        fn transcribe(&self, samples: &[f32], sample_rate: u32, locale: &str) -> Result<String, String> {
            let id = c_locale(locale)?;
            let json = take(unsafe {
                alethe_speech_transcribe(
                    samples.as_ptr(),
                    samples.len() as isize,
                    sample_rate as i32,
                    id.as_ptr(),
                )
            })
            .ok_or_else(|| "apple speech: no result".to_string())?;
            parse_transcription(&json)
        }
    }
}

pub fn bridge() -> Option<&'static dyn AppleBridge> {
    #[cfg(apple_speech_linked)]
    {
        static LINKED: linked::Linked = linked::Linked;
        Some(&LINKED)
    }
    #[cfg(not(apple_speech_linked))]
    {
        None
    }
}
```

- [ ] **Step 3: Run tests + clippy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib speech_apple` — Expected: PASS (5).
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib` — Expected: no warnings in `speech_apple.rs`.

- [ ] **Step 4: Checkpoint** — working tree only, no commit.

---

### Task 4: `Transcriber` dispatch and speech commands

**Files:**
- Modify: `src-tauri/src/speech.rs` (manifest `kind`, catalog, `Engine`/`engine_for`, `Transcriber`, commands)
- Modify: `src-tauri/src/lib.rs` (register `speech::speech_native_locales`)

**Interfaces:**
- Consumes: `speech_apple::{bridge, native_status, AppleBridge, NativeLocale}` (Task 3).
- Produces:
  - `pub const APPLE_MODEL_ID: &str = "apple-speech";`
  - `SpeechModelManifest.kind: String` (`"download"` | `"native"`).
  - `enum Engine { Sherpa(&'static CatalogEntry), Apple { locale: String } }`; `fn engine_for(model_id: &str, locale: Option<&str>, apple_available: bool) -> Result<Engine, String>`.
  - `trait Transcriber { fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String>; }` with `SherpaTranscriber` and `AppleTranscriber`.
  - Commands (new optional `locale: Option<String>` argument, TS name `locale`): `speech_prepare`, `speech_stop_and_transcribe`, `speech_transcribe`, `speech_model_states`, `speech_download_model`; new `speech_native_locales() -> Vec<NativeLocale>`.

- [ ] **Step 1: Failing tests** — add to `speech.rs`'s `mod tests`:

```rust
    #[test]
    fn sherpa_ids_dispatch_to_their_catalog_entry() {
        match engine_for("parakeet-tdt-0.6b-v3-int8", None, true).unwrap() {
            Engine::Sherpa(entry) => assert_eq!(entry.id, "parakeet-tdt-0.6b-v3-int8"),
            Engine::Apple { .. } => panic!("expected sherpa"),
        }
        assert!(engine_for("nope", None, true).is_err());
    }

    #[test]
    fn the_native_engine_needs_the_bridge_and_a_locale() {
        assert!(engine_for(APPLE_MODEL_ID, Some("pt-BR"), false).is_err());
        assert!(engine_for(APPLE_MODEL_ID, None, true).is_err());
        assert!(engine_for(APPLE_MODEL_ID, Some("  "), true).is_err());
        match engine_for(APPLE_MODEL_ID, Some("pt-BR"), true).unwrap() {
            Engine::Apple { locale } => assert_eq!(locale, "pt-BR"),
            Engine::Sherpa(_) => panic!("expected apple"),
        }
    }

    #[test]
    fn the_catalog_lists_the_native_engine_only_with_the_bridge() {
        let with = catalog_manifests(true);
        let native: Vec<_> = with.iter().filter(|m| m.kind == "native").collect();
        assert_eq!(native.len(), 1);
        assert_eq!(native[0].id, APPLE_MODEL_ID);
        assert_eq!(native[0].size_bytes, 0);
        assert!(catalog_manifests(false).iter().all(|m| m.kind == "download"));
    }
```

Update the existing `catalog_recommends_exactly_one_downloadable_model` test to filter `kind == "download"` before asserting `size_bytes > 0`.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib speech::tests` — Expected: FAIL to compile.

- [ ] **Step 2: Catalog.** Add `kind: String` to `SpeechModelManifest`. Replace the body of `speech_list_models` with a call to a new pure function:

```rust
pub const APPLE_MODEL_ID: &str = "apple-speech";

fn catalog_manifests(apple_available: bool) -> Vec<SpeechModelManifest> {
    let mut list: Vec<SpeechModelManifest> = CATALOG
        .iter()
        .map(|entry| SpeechModelManifest {
            id: entry.id.to_string(),
            label: entry.label.to_string(),
            description: entry.description.to_string(),
            language: entry.language.to_string(),
            sample_rate: SAMPLE_RATE as u32,
            size_bytes: entry_size_bytes(entry),
            recommended: entry.recommended,
            kind: "download".to_string(),
        })
        .collect();
    if apple_available {
        list.insert(
            0,
            SpeechModelManifest {
                id: APPLE_MODEL_ID.to_string(),
                label: "Apple (native)".to_string(),
                description: "Apple's on-device speech recognition. Nothing to download; one language at a time.".to_string(),
                language: "single".to_string(),
                sample_rate: SAMPLE_RATE as u32,
                size_bytes: 0,
                recommended: false,
                kind: "native".to_string(),
            },
        );
    }
    list
}

#[tauri::command]
pub fn speech_list_models() -> Vec<SpeechModelManifest> {
    catalog_manifests(crate::speech_apple::bridge().is_some())
}
```

- [ ] **Step 3: Engine and transcribers.**

```rust
enum Engine {
    Sherpa(&'static CatalogEntry),
    Apple { locale: String },
}

fn engine_for(model_id: &str, locale: Option<&str>, apple_available: bool) -> Result<Engine, String> {
    if model_id != APPLE_MODEL_ID {
        return find_entry(model_id).map(Engine::Sherpa);
    }
    if !apple_available {
        return Err("Apple speech recognition is not available in this build.".to_string());
    }
    match locale.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Ok(Engine::Apple { locale: id.to_string() }),
        None => Err("Choose the native recognition language in Preferences → Integrations → Voice dictation.".to_string()),
    }
}

trait Transcriber: Send {
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String>;
}

struct SherpaTranscriber(Arc<OfflineRecognizer>);

impl Transcriber for SherpaTranscriber {
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        transcribe_samples(&self.0, samples, sample_rate)
    }
}

struct AppleTranscriber {
    bridge: &'static dyn crate::speech_apple::AppleBridge,
    locale: String,
}

impl Transcriber for AppleTranscriber {
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        let rate = if sample_rate == 0 { SAMPLE_RATE as u32 } else { sample_rate };
        self.bridge.transcribe(trim_silence(samples), rate, &self.locale)
    }
}

/// The transcriber for a model id, or why it cannot run yet.
fn transcriber_for(
    app: &AppHandle,
    state: &SpeechState,
    model_id: &str,
    locale: Option<&str>,
) -> Result<Box<dyn Transcriber>, String> {
    let bridge = crate::speech_apple::bridge();
    match engine_for(model_id, locale, bridge.is_some())? {
        Engine::Sherpa(entry) => {
            let dir = model_dir(app, model_id)?;
            if !model_ready(&dir, entry) {
                return Err(format!(
                    "Speech model '{model_id}' is not downloaded. Open Preferences → Integrations → Voice and download it."
                ));
            }
            Ok(Box::new(SherpaTranscriber(state.recognizer_for(&dir, entry.model_type)?)))
        }
        Engine::Apple { locale } => Ok(Box::new(AppleTranscriber {
            bridge: bridge.expect("engine_for checked the bridge"),
            locale,
        })),
    }
}
```

- [ ] **Step 4: Commands.** Rewrite the transcription commands to go through `transcriber_for` (keep the existing short-recording and silent-mic checks in `speech_stop_and_transcribe`):

```rust
#[tauri::command]
pub async fn speech_prepare(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
    locale: Option<String>,
) -> Result<bool, String> {
    if model_id == APPLE_MODEL_ID {
        let Some(bridge) = crate::speech_apple::bridge() else { return Ok(false) };
        let locale = locale.clone();
        return tokio::task::spawn_blocking(move || {
            use crate::speech_apple::{native_status, Authorization};
            if bridge.request_authorization() != Authorization::Authorized {
                return false;
            }
            native_status(Authorization::Authorized, &bridge.locales(), locale.as_deref()) == "ready"
        })
        .await
        .map_err(|e| format!("speech worker join: {e}"));
    }
    let entry = find_entry(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    if !model_ready(&dir, entry) {
        return Ok(false);
    }
    state.recognizer_for(&dir, entry.model_type)?;
    Ok(true)
}
```

`speech_stop_and_transcribe(app, state, model_id, locale: Option<String>)`: after the existing checks on `audio`, replace the model lookup and the `spawn_blocking` with:

```rust
    let transcriber = transcriber_for(&app, &state, &model_id, locale.as_deref())?;
    let samples = audio.samples;
    let sample_rate = audio.sample_rate;
    tokio::task::spawn_blocking(move || transcriber.transcribe(&samples, sample_rate))
        .await
        .map_err(|e| format!("speech worker join: {e}"))?
```

`speech_transcribe(app, state, model_id, samples, sample_rate, locale: Option<String>)`: same replacement after the empty check.

`speech_model_states(app, locale: Option<String>)` becomes `async` and appends the native entry when the bridge exists:

```rust
#[tauri::command]
pub async fn speech_model_states(
    app: AppHandle,
    locale: Option<String>,
) -> Result<Vec<SpeechModelState>, String> {
    let root = models_root(&app)?;
    let mut states: Vec<SpeechModelState> = CATALOG
        .iter()
        .map(|entry| {
            let status = if model_ready(&root.join(entry.id), entry) { "ready" } else { "not-downloaded" };
            SpeechModelState { id: entry.id.to_string(), status: status.to_string(), progress: None, error: None }
        })
        .collect();
    if let Some(bridge) = crate::speech_apple::bridge() {
        let status = tokio::task::spawn_blocking(move || {
            crate::speech_apple::native_status(bridge.authorization(), &bridge.locales(), locale.as_deref())
        })
        .await
        .map_err(|e| format!("speech worker join: {e}"))?;
        states.insert(0, SpeechModelState { id: APPLE_MODEL_ID.to_string(), status: status.to_string(), progress: None, error: None });
    }
    Ok(states)
}
```

`speech_download_model(app, state, model_id, locale: Option<String>)`: at the top, before `find_entry`, add the native branch:

```rust
    if model_id == APPLE_MODEL_ID {
        let bridge = crate::speech_apple::bridge()
            .ok_or_else(|| "Apple speech recognition is not available in this build.".to_string())?;
        let locale = locale
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Choose a language first.".to_string())?;
        let install_locale = locale.clone();
        let install = tokio::task::spawn_blocking(move || bridge.install(&install_locale));
        tokio::pin!(install);
        let started = Instant::now();
        loop {
            tokio::select! {
                result = &mut install => {
                    result.map_err(|e| format!("speech worker join: {e}"))??;
                    break;
                }
                _ = tokio::time::sleep(PROGRESS_INTERVAL) => {
                    let fraction = bridge.install_progress(&locale).unwrap_or(0.0);
                    let _ = app.emit("speech://download-progress", NativeInstallProgress::event(&model_id, &locale, fraction));
                    if started.elapsed() > Duration::from_secs(3_600) {
                        return Err("Installing the language took too long.".to_string());
                    }
                }
            }
        }
        return Ok(SpeechModelState { id: model_id, status: "ready".into(), progress: Some(1.0), error: None });
    }
```

`DownloadProgressEvent.file` is `&'static str`; the locale is not static, so change it to `file: String` (update the sherpa `emit` closure to pass `file.name.to_string()`) and add:

```rust
struct NativeInstallProgress;

impl NativeInstallProgress {
    fn event(model_id: &str, locale: &str, fraction: f64) -> DownloadProgressEvent {
        // The OS reports a fraction, not bytes; 1000 "units" give the bar something to fill.
        let units = 1_000u64;
        DownloadProgressEvent {
            model_id: model_id.to_string(),
            downloaded: (fraction.clamp(0.0, 1.0) * units as f64) as u64,
            total: units,
            fraction: fraction.clamp(0.0, 1.0),
            phase: "downloading",
            file: locale.to_string(),
            file_index: 1,
            file_count: 1,
        }
    }
}
```

(`tokio` has the `time` and `macros` features already; `tokio::select!`/`pin!` need `macros`.) Add the `speech_native_locales` command and register it in `lib.rs` after `speech::speech_transcribe,`:

```rust
#[tauri::command]
pub async fn speech_native_locales() -> Result<Vec<crate::speech_apple::NativeLocale>, String> {
    let Some(bridge) = crate::speech_apple::bridge() else { return Ok(Vec::new()) };
    tokio::task::spawn_blocking(move || bridge.locales())
        .await
        .map_err(|e| format!("speech worker join: {e}"))
}
```

`speech_delete_model('apple-speech')`: return `Err("The Apple engine has nothing to delete.")` before `find_entry`.

- [ ] **Step 5: Run tests, check, clippy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib speech` — Expected: PASS.
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib` — Expected: no new warnings in `speech.rs`.

- [ ] **Step 6: Checkpoint** — working tree only, no commit.

---

### Task 5: Frontend speech API, preferences fields, engine args, default switch

**Files:**
- Modify: `src/lib/tauri/speech.ts`
- Create: `src/lib/speech/engine.ts`, `src/lib/speech/engine.test.ts`
- Modify: `src/lib/types.ts` (Preferences + defaults), `src/stores/projectsStore.migrations.ts` (+ test)

**Interfaces:**
- Consumes: Task 4 command signatures.
- Produces:
  ```ts
  // speech.ts
  export const APPLE_SPEECH_MODEL_ID = 'apple-speech'
  SpeechModelManifest.kind: 'download' | 'native'
  export type NativeLocale = { id: string; name: string; installed: boolean }
  speechPrepare(modelId: string, locale?: string | null): Promise<boolean>
  speechStopAndTranscribe(modelId: string, locale?: string | null): Promise<string>
  speechTranscribe(modelId: string, samples, sampleRate: number, locale?: string | null): Promise<string>
  speechModelStates(locale?: string | null): Promise<SpeechModelState[]>
  speechDownloadModel(modelId: string, locale?: string | null): Promise<SpeechModelState>
  speechNativeLocales(): Promise<NativeLocale[]>
  // engine.ts
  export function speechEngineArgs(prefs: Pick<Preferences, 'dictationModelId' | 'dictationNativeLocale'>): { modelId: string; locale: string | null; needsLocale: boolean }
  export function shouldSwitchToNative(input: { migrated: boolean; modelId: string; nativeAvailable: boolean; parakeetReady: boolean }): boolean
  // Preferences
  dictationNativeLocale: string | null   // default null
  speechEngineMigrated: boolean          // default false
  ```

- [ ] **Step 1: Failing tests** — `src/lib/speech/engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { shouldSwitchToNative, speechEngineArgs } from './engine'

describe('speechEngineArgs', () => {
  it('passes no locale to a sherpa model', () => {
    expect(
      speechEngineArgs({ dictationModelId: 'parakeet-tdt-0.6b-v3-int8', dictationNativeLocale: 'pt-BR' }),
    ).toEqual({ modelId: 'parakeet-tdt-0.6b-v3-int8', locale: null, needsLocale: false })
  })

  it('passes the chosen language to the Apple engine', () => {
    expect(speechEngineArgs({ dictationModelId: 'apple-speech', dictationNativeLocale: 'pt-BR' })).toEqual({
      modelId: 'apple-speech',
      locale: 'pt-BR',
      needsLocale: false,
    })
  })

  it('flags the Apple engine without a language', () => {
    expect(speechEngineArgs({ dictationModelId: 'apple-speech', dictationNativeLocale: null })).toEqual({
      modelId: 'apple-speech',
      locale: null,
      needsLocale: true,
    })
  })

  it('falls back to the default model id when none is saved', () => {
    expect(speechEngineArgs({ dictationModelId: '', dictationNativeLocale: null }).modelId).toBe(
      'zipformer-gigaspeech-en-int8',
    )
  })
})

describe('shouldSwitchToNative', () => {
  const base = {
    migrated: false,
    modelId: 'parakeet-tdt-0.6b-v3-int8',
    nativeAvailable: true,
    parakeetReady: false,
  }

  it('switches an untouched default on a Mac with the native engine', () => {
    expect(shouldSwitchToNative(base)).toBe(true)
  })

  it('keeps a downloaded Parakeet', () => {
    expect(shouldSwitchToNative({ ...base, parakeetReady: true })).toBe(false)
  })

  it('keeps any other saved model', () => {
    expect(shouldSwitchToNative({ ...base, modelId: 'zipformer-small-en-int8' })).toBe(false)
  })

  it('runs once and only where the native engine exists', () => {
    expect(shouldSwitchToNative({ ...base, migrated: true })).toBe(false)
    expect(shouldSwitchToNative({ ...base, nativeAvailable: false })).toBe(false)
  })
})
```

Add to `src/stores/projectsStore.migrations.test.ts` (inside `describe('preference normalization')`):

```ts
  it('backfills the native speech preferences', () => {
    const preferences = normalizePreferences({})
    expect(preferences.dictationNativeLocale).toBeNull()
    expect(preferences.speechEngineMigrated).toBe(false)
  })

  it('keeps a chosen native language and drops a blank one', () => {
    expect(normalizePreferences({ dictationNativeLocale: ' pt-BR ' }).dictationNativeLocale).toBe('pt-BR')
    expect(normalizePreferences({ dictationNativeLocale: '  ' }).dictationNativeLocale).toBeNull()
  })
```

Run: `npx vitest run src/lib/speech/engine.test.ts src/stores/projectsStore.migrations.test.ts` — Expected: FAIL.

- [ ] **Step 2: Preferences.** `src/lib/types.ts`, after `dictationMicrophoneLabel` in `Preferences`:

```ts
  /** BCP-47 language for the Apple engine (`apple-speech`); null until chosen. Device-specific. */
  dictationNativeLocale: string | null
  /** The one-time switch of a Mac profile to the Apple engine has run. */
  speechEngineMigrated: boolean
```

defaults `dictationNativeLocale: null, speechEngineMigrated: false,`; in `normalizePreferences` after the dictation fields:

```ts
    dictationNativeLocale:
      typeof preferences.dictationNativeLocale === 'string' && preferences.dictationNativeLocale.trim()
        ? preferences.dictationNativeLocale.trim()
        : null,
    speechEngineMigrated: preferences.speechEngineMigrated === true,
```

Do **not** add either to `cloudSync.ts`.

- [ ] **Step 3: `src/lib/speech/engine.ts`:**

```ts
import { APPLE_SPEECH_MODEL_ID } from '../tauri/speech'
import type { Preferences } from '../types'
import { DEFAULT_SPEECH_MODEL_ID } from './audio'

const OLD_DEFAULT_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

/** What every speech consumer passes to the speech commands. */
export function speechEngineArgs(
  prefs: Pick<Preferences, 'dictationModelId' | 'dictationNativeLocale'>,
): { modelId: string; locale: string | null; needsLocale: boolean } {
  const modelId = prefs.dictationModelId || DEFAULT_SPEECH_MODEL_ID
  if (modelId !== APPLE_SPEECH_MODEL_ID) return { modelId, locale: null, needsLocale: false }
  const locale = prefs.dictationNativeLocale?.trim() || null
  return { modelId, locale, needsLocale: locale === null }
}

/** Spec §5.3: move an untouched default to the Apple engine once, never a real choice. */
export function shouldSwitchToNative(input: {
  migrated: boolean
  modelId: string
  nativeAvailable: boolean
  parakeetReady: boolean
}): boolean {
  return (
    !input.migrated &&
    input.nativeAvailable &&
    input.modelId === OLD_DEFAULT_MODEL_ID &&
    !input.parakeetReady
  )
}
```

- [ ] **Step 4: `src/lib/tauri/speech.ts`.** Add `kind: 'download' | 'native'` to `SpeechModelManifest`, `export const APPLE_SPEECH_MODEL_ID = 'apple-speech'`, `export type NativeLocale = { id: string; name: string; installed: boolean }`, and pass `locale: locale ?? null` in the invoke payloads of `speechPrepare`, `speechStopAndTranscribe`, `speechTranscribe`, `speechModelStates`, `speechDownloadModel` (each gains a trailing optional `locale?: string | null` parameter). Add:

```ts
export async function speechNativeLocales(): Promise<NativeLocale[]> {
  return invoke('speech_native_locales')
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/lib/speech src/stores/projectsStore.migrations.test.ts` — Expected: PASS.
Run: `npm run build` — Expected: only the 2 pre-existing TS2550 errors.

- [ ] **Step 6: Checkpoint** — working tree only, no commit.

---

### Task 6: Consumers use the engine args (dictation, Jev bar, voice conversation)

**Files:**
- Modify: `src/components/DictationButton/index.tsx`
- Modify: `src/components/VoiceCommand/index.tsx`
- Modify: `src/lib/voice/controller.ts` (+ `controller.test.ts`)
- Create: `src/components/DictationButton/DictationButton.test.tsx`
- Modify: i18n `en.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: `speechEngineArgs` (Task 5), locale-aware speech wrappers (Task 5).
- Produces: i18n keys `speech.nativeLocaleRequired`, `speech.nativeNotReady`.

i18n:

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `speech.nativeLocaleRequired` | Choose the native recognition language in Preferences → Integrations → Voice dictation. | Escolha o idioma do reconhecimento nativo em Preferências → Integrações → Ditado por voz. | 请在 偏好设置 → 集成 → 语音输入 中选择原生识别语言。 |
| `speech.nativeNotReady` | Apple speech recognition is not ready: allow it in System Settings → Privacy & Security → Speech Recognition, and install the language in Preferences. | O reconhecimento de fala da Apple não está pronto: permita em Ajustes do Sistema → Privacidade e Segurança → Reconhecimento de Fala e instale o idioma nas Preferências. | Apple 语音识别尚未就绪：请在 系统设置 → 隐私与安全性 → 语音识别 中允许，并在偏好设置中安装该语言。 |

- [ ] **Step 1: Failing tests.**
  - `src/lib/voice/controller.test.ts`: set the mocked prefs to `dictationModelId: 'apple-speech', dictationNativeLocale: null` in a new test → `press()` does not call `speechStartCapture` and the notice key is `speech.nativeLocaleRequired`; with `dictationNativeLocale: 'pt-BR'`, `speechPrepare` is called with `('apple-speech', 'pt-BR')` and `speechStopAndTranscribe` with `('apple-speech', 'pt-BR')`; when `speechPrepare` resolves `false` for `apple-speech`, the notice key is `speech.nativeNotReady` (not `voice.conv.modelMissing`).
  - `src/components/DictationButton/DictationButton.test.tsx`: mock `../../lib/tauri` (`speechStartCapture`, `speechStopAndTranscribe`, `speechStopCapture`, `writePty`) and `../../lib/i18n` (`useT` returns the key); with preferences `dictationEnabled: true, dictationModelId: 'apple-speech', dictationNativeLocale: null`, firing the Ctrl+E keydown shows `speech.nativeLocaleRequired` and never calls `speechStartCapture`; with `'pt-BR'`, a press-then-press calls `speechStopAndTranscribe('apple-speech', 'pt-BR')`. Use the real `useProjectsStore` with `setState` for preferences, as other component tests do (`grep -rl "useProjectsStore.setState" src --include=*.test.tsx`).
  - `src/components/VoiceCommand/VoiceCommand.test.tsx` (exists): with `apple-speech` and no locale, clicking the mic button (`voice.bar.startRecording` label) does not call `speechStartCapture` and shows `speech.nativeLocaleRequired`.

Run the three files — Expected: FAIL.

- [ ] **Step 2: Implement.**
  - Controller `press()`: compute `const engine = speechEngineArgs(p)`; if `engine.needsLocale` → notice `{ key: 'speech.nativeLocaleRequired' }`, return before preparing; `speechPrepare(engine.modelId, engine.locale)`; when it returns false use `speech.nativeNotReady` for `apple-speech`, `voice.conv.modelMissing` otherwise. `release()`: `speechStopAndTranscribe(engine.modelId, engine.locale)`.
  - `DictationButton`: read `dictationNativeLocale`; in `startCapture`, if `needsLocale`, `setError(t('speech.nativeLocaleRequired'))` and return; `stopCapture` passes `(engine.modelId, engine.locale)`.
  - `VoiceCommand`: same check in `listen()` (set `message`), `speechPrepare(modelId, locale)` and `speechStopAndTranscribe(modelId, locale)`.
  - Register the two i18n keys in all three locales.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/voice src/components/DictationButton src/components/VoiceCommand` — Expected: PASS.
Run: `npm run build` — Expected: only the 2 pre-existing TS2550 errors.

- [ ] **Step 4: Checkpoint** — working tree only, no commit.

---

### Task 7: Preferences — model picker, native language, install

**Files:**
- Modify: `src/components/modals/preferences/VoiceDictationSection.tsx`
- Create: `src/components/modals/preferences/VoiceDictationSection.test.tsx`
- Modify: `src/components/modals/PreferencesModal.tsx` (dictation search keywords)
- Modify: i18n `en.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: `speechListModels`, `speechModelStates(locale)`, `speechDownloadModel(id, locale)`, `speechNativeLocales`, `APPLE_SPEECH_MODEL_ID` (Task 5); `ModelDownloadProgress` (exists).

i18n:

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.dictationEngine` | Model | Modelo | 模型 |
| `prefs.dictationEngineNative` | No download · one language at a time | Sem download · um idioma por vez | 无需下载 · 一次一种语言 |
| `prefs.dictationEngineMultilingual` | {size} · detects the language | {size} · detecta o idioma | {size} · 自动识别语言 |
| `prefs.dictationEngineEnglish` | {size} · English | {size} · inglês | {size} · 英语 |
| `prefs.dictationNativeLocale` | Language | Idioma | 语言 |
| `prefs.dictationNativeLocaleChoose` | Choose a language | Escolha um idioma | 选择语言 |
| `prefs.dictationNativeLocaleInstalled` | {name} · installed | {name} · instalado | {name} · 已安装 |
| `prefs.dictationNativeLocaleNeedsInstall` | {name} · needs install | {name} · precisa instalar | {name} · 需要安装 |
| `prefs.dictationNativeNeedsLocale` | The native engine needs a language before it can listen. | O motor nativo precisa de um idioma antes de ouvir. | 原生引擎需要先选择语言才能识别。 |
| `prefs.dictationNativeInstall` | Install language | Instalar idioma | 安装语言 |
| `prefs.dictationNativeReady` | Ready to use. | Pronto para usar. | 可以使用。 |
| `prefs.dictationNativeDenied` | Speech recognition is not allowed. Turn it on in System Settings → Privacy & Security → Speech Recognition. | O reconhecimento de fala não está permitido. Ative em Ajustes do Sistema → Privacidade e Segurança → Reconhecimento de Fala. | 未允许语音识别。请在 系统设置 → 隐私与安全性 → 语音识别 中开启。 |
| `prefs.dictationNativeNoLocales` | This Mac has no language with on-device recognition. Use Parakeet instead. | Este Mac não tem idioma com reconhecimento local. Use o Parakeet. | 此 Mac 没有支持本地识别的语言，请改用 Parakeet。 |

- [ ] **Step 1: Failing tests** — `VoiceDictationSection.test.tsx` (mock `../../../lib/tauri` with `speechListModels` returning `[apple native entry, parakeet download entry]`, `speechModelStates`, `speechNativeLocales` returning `[{id:'pt-BR',name:'Português (Brasil)',installed:true},{id:'en-US',name:'English (US)',installed:false}]`, `speechDownloadModel`, `speechDeleteModel`, `speechListInputDevices`, `onSpeechDownloadProgress`; `useT` returns `key:params`):
  - the model dropdown lists both entries; picking Parakeet calls `setPreferences({ dictationModelId: 'parakeet-tdt-0.6b-v3-int8' })`;
  - with `apple-speech` and no locale, `prefs.dictationNativeNeedsLocale` is shown and the language dropdown offers both locales (labels via the installed / needs-install keys);
  - choosing `en-US` saves `dictationNativeLocale: 'en-US'`, and with model state `not-installed` the **Install language** button calls `speechDownloadModel('apple-speech', 'en-US')`;
  - model state `denied` shows `prefs.dictationNativeDenied`; an empty locale list shows `prefs.dictationNativeNoLocales`;
  - no Download/Delete buttons are rendered for the native engine.

Run: `npx vitest run src/components/modals/preferences/VoiceDictationSection.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement** in `VoiceDictationSection.tsx`:
  - `model` = selected entry (`dictationModelId || DEFAULT_SPEECH_MODEL_ID`, else first entry); a `Dropdown` (`rootClassName={styles.dictationMicSelect}`, `ariaLabel={t('prefs.dictationEngine')}`) lists every catalog entry; option labels are the entry label plus the subtitle key (`prefs.dictationEngineNative` for `kind === 'native'`, `…Multilingual` for `language === 'multilingual'`, `…English` otherwise, with `size` from the existing `formatBytes`). Changing it calls `setPreferences({ dictationModelId })`.
  - `refreshStates` passes `preferences.dictationNativeLocale` to `speechModelStates`; re-run it when the locale changes.
  - When `model.kind === 'native'`: load `speechNativeLocales()` once (store in state); render the language `Dropdown` (placeholder option `prefs.dictationNativeLocaleChoose`, value `dictationNativeLocale ?? ''`), saving `dictationNativeLocale`; below it a status line by model state: `needs-locale` → `prefs.dictationNativeNeedsLocale`, `denied` → `prefs.dictationNativeDenied`, `not-installed` → **Install language** button (calls `speechDownloadModel(APPLE_SPEECH_MODEL_ID, locale)` with the same `busy`/progress handling as today's download), `ready` → `prefs.dictationNativeReady`; an empty locale list → `prefs.dictationNativeNoLocales`. No Download/Delete buttons.
  - When `model.kind === 'download'`: today's controls (source hint, progress, Download/Delete).
  - Keep `ModelDownloadProgress` for both (native installs emit `fileIndex 1/1` with the locale as the file).
  - In `PreferencesModal.tsx`'s `dictation` search entry, append `apple native siri nativo modelo model` to `keywords`.

- [ ] **Step 3: Run tests + build + lint**

Run: `npx vitest run src/components/modals` — Expected: PASS.
Run: `npm run build` — Expected: only the 2 pre-existing TS2550 errors.

- [ ] **Step 4: Checkpoint** — working tree only, no commit.

---

### Task 8: Default switch at startup, docs, CI, verification

**Files:**
- Create: `src/hooks/useSpeechEngineDefault.ts`, `src/hooks/useSpeechEngineDefault.test.ts`
- Modify: `src/App.tsx` (call the hook once, next to `useAgentHookBridge()`)
- Modify: `docs/CHANGELOG.md`, `docs/FEATURES.md`
- Modify: `.github/workflows/release.yml` (macOS: select Xcode 26 when present and print whether the SpeechAnalyzer path compiled)
- Modify: `docs/superpowers/specs/2026-10-14-macos-native-stt-design.md` (status → implemented)

**Interfaces:**
- Consumes: `shouldSwitchToNative` (Task 5), `speechListModels`, `speechModelStates`.

- [ ] **Step 1: Failing test** — `src/hooks/useSpeechEngineDefault.test.ts` (mock `../lib/tauri`; real `useProjectsStore`):
  - native in catalog, Parakeet `not-downloaded`, `dictationModelId` = old default, not migrated → after the hook runs, `dictationModelId === 'apple-speech'` and `speechEngineMigrated === true`;
  - Parakeet `ready` → model unchanged, `speechEngineMigrated === true`;
  - already migrated → no tauri calls;
  - catalog without native (Windows/Linux) → model unchanged, `speechEngineMigrated === true`;
  - a rejected tauri call → preferences untouched (retried next launch).

Run: `npx vitest run src/hooks/useSpeechEngineDefault.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement** `src/hooks/useSpeechEngineDefault.ts`:

```ts
import { useEffect } from 'react'

import { shouldSwitchToNative } from '../lib/speech/engine'
import { APPLE_SPEECH_MODEL_ID, speechListModels, speechModelStates } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

const PARAKEET_ID = 'parakeet-tdt-0.6b-v3-int8'

/** Spec §5.3: once per profile, a Mac that never picked a model moves to the Apple engine. */
export function useSpeechEngineDefault(): void {
  useEffect(() => {
    const { preferences } = useProjectsStore.getState()
    if (preferences.speechEngineMigrated) return
    let cancelled = false
    void (async () => {
      try {
        const [models, states] = await Promise.all([speechListModels(), speechModelStates()])
        if (cancelled) return
        const current = useProjectsStore.getState().preferences
        const switchToNative = shouldSwitchToNative({
          migrated: current.speechEngineMigrated,
          modelId: current.dictationModelId,
          nativeAvailable: models.some((model) => model.id === APPLE_SPEECH_MODEL_ID),
          parakeetReady: states.some((state) => state.id === PARAKEET_ID && state.status === 'ready'),
        })
        useProjectsStore.getState().setPreferences(
          switchToNative
            ? { dictationModelId: APPLE_SPEECH_MODEL_ID, speechEngineMigrated: true }
            : { speechEngineMigrated: true },
        )
      } catch {
        // Try again on the next launch.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
}
```

Call `useSpeechEngineDefault()` in `App.tsx` next to `useAgentHookBridge()`.

- [ ] **Step 3: Docs.** `docs/CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **Apple's own speech recognition on the Mac.** Preferences → Integrations → Voice dictation now has
  a model picker: on a Mac, *Apple (native)* is offered next to Parakeet and Zipformer, needs no
  download, and runs on the device (macOS 26 uses Apple's newest recognizer; earlier macOS uses the
  on-device dictation engine). Pick its language once; a language that needs it can be installed
  right there. Dictation, the Jev voice bar and voice conversation all use the chosen model. Audio
  never goes to Apple's servers — languages without on-device support are simply not offered.
```

`docs/FEATURES.md`: in the Voice dictation / Voice conversation area, a short "Speech models" paragraph: the picker, Apple (native) on Mac (on-device only, one language, install step on macOS 26), Parakeet (multilingual, ~670 MB) and Zipformer (English).

- [ ] **Step 4: CI.** In `.github/workflows/release.yml`, for the macOS matrix entries add before the build step:

```yaml
      - name: Select Xcode 26 (Apple speech recognition)
        if: matrix.platform == 'macos-latest'
        run: |
          XCODE=$(ls -d /Applications/Xcode_26*.app 2>/dev/null | sort -V | tail -1)
          if [ -n "$XCODE" ]; then sudo xcode-select -s "$XCODE"; fi
          swift --version
```

- [ ] **Step 5: Full verification** (paste summary lines in the report): `swift test --package-path src-tauri/swift/AletheSpeech`, `npm test`, `npm run build` (only the 2 pre-existing TS2550), `npx vite build`, `npm run lint` (0 errors), prettier --check on touched files, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` (no new warnings in touched files).

- [ ] **Step 6: Manual checklist for the owner** (do not run the app): on macOS 26 — pick Apple (native), choose pt-BR, install if asked (progress bar), allow the permission prompt, dictate with Cmd+E, talk with voice conversation; switch to Parakeet and back without restarting; deny the permission in System Settings and see the denied message; pick a language that needs install and install it. On macOS 14/15 if available — the language list shows only on-device languages; dictation works. On Windows/Linux — no Apple option, everything as before.

- [ ] **Step 7: Checkpoint** — working tree only, no commit.
