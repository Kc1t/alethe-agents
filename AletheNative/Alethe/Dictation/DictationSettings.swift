import AletheDesign
import AVFoundation
import Observation
import Speech
import SwiftUI

/// Local preferences do not change the shared workspace schema.
@Observable @MainActor
final class DictationSettings {
    var enabled = UserDefaults.standard.object(forKey: "dictation.enabled") as? Bool ?? false {
        didSet { UserDefaults.standard.set(enabled, forKey: "dictation.enabled") }
    }
    var hold = UserDefaults.standard.bool(forKey: "dictation.hold") {
        didSet { UserDefaults.standard.set(hold, forKey: "dictation.hold") }
    }
    var microphone = UserDefaults.standard.string(forKey: "dictation.microphone") ?? "" {
        didSet { UserDefaults.standard.set(microphone, forKey: "dictation.microphone") }
    }
    var language = UserDefaults.standard.string(forKey: "dictation.language") ?? "" {
        didSet { UserDefaults.standard.set(language, forKey: "dictation.language") }
    }
    var locales: [Locale] = []
    var microphones: [AVCaptureDevice] = []
    var installed = false
    var busy = false
    var progress: Double?
    var error: String?

    func refresh(locale: Locale) async {
        microphones = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified).devices
        locales = await SpeechTranscriber.supportedLocales.sorted { $0.identifier < $1.identifier }
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: selectedLocale(fallback: locale)) else {
            installed = false
            return
        }
        installed = await AssetInventory.status(forModules: [SpeechTranscriber(locale: supported, preset: .transcription)]) == .installed
    }

    func selectedLocale(fallback: Locale) -> Locale { language.isEmpty ? fallback : Locale(identifier: language) }

    func download(locale: Locale) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false; progress = nil }
        do {
            guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: selectedLocale(fallback: locale)) else {
                throw DictationEngine.StartError.languageUnsupported
            }
            let module = SpeechTranscriber(locale: supported, preset: .transcription)
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                let poll = Task { @MainActor in
                    while !Task.isCancelled {
                        progress = request.progress.fractionCompleted
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                }
                defer { poll.cancel() }
                try await request.downloadAndInstall()
            }
            await refresh(locale: locale)
        } catch { self.error = String(localized: "dictation.unavailable") }
    }
}

struct DictationSettingsSections: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.metrics) private var metrics
    @Bindable var settings: DictationSettings

    var body: some View {
        Section {
            AletheDictationSegments(selection: $settings.enabled, options: [true, false]) {
                Text($0 ? "dictation.settings.on" : "dictation.settings.off")
            }
            .accessibilityIdentifier("dictation.settings.enabled")
            .onChange(of: settings.enabled) { _, enabled in
                if !enabled { environment.dictation.cancelSession() }
            }
        } header: { Text("settings.web.reference.prefs.dictation") }
          footer: { Text("dictation.settings.description") }
        Section {
            AletheDictationSegments(selection: $settings.hold, options: [false, true]) {
                Text($0 ? "dictation.settings.hold" : "dictation.settings.toggle")
            }.disabled(!settings.enabled).accessibilityIdentifier("dictation.settings.mode")
        } header: { Text("dictation.settings.mode") }
          footer: { Text("dictation.settings.modeDescription") }
        Section {
            InterfaceSelect(selection: $settings.microphone, options: [""] + settings.microphones.map(\.uniqueID)) { id in
                if id.isEmpty { Text("dictation.settings.systemMicrophone") }
                else { Text(verbatim: settings.microphones.first { $0.uniqueID == id }?.localizedName ?? id) }
            }
            .frame(maxWidth: metrics.size(360))
            .disabled(!settings.enabled || environment.dictation.machine.isActive)
            .accessibilityIdentifier("dictation.settings.microphone")
        } header: { Text("dictation.settings.microphone") }
          footer: { Text("dictation.settings.microphoneDescription") }
        Section {
            VStack(alignment: .leading, spacing: metrics.size(12)) {
                InterfaceSelect(selection: $settings.language, options: [""] + settings.locales.map(\.identifier)) { id in
                    if id.isEmpty { Text("dictation.settings.interfaceLanguage") }
                    else { Text(verbatim: Locale.current.localizedString(forIdentifier: id) ?? id) }
                }.frame(maxWidth: metrics.size(360)).accessibilityIdentifier("dictation.settings.language")
                Text(settings.installed ? "dictation.settings.ready" : "dictation.settings.missing")
                if let progress = settings.progress { ProgressView(value: progress) }
                Button("dictation.settings.download") { Task { await settings.download(locale: environment.dictationLocale) } }
                    .disabled(settings.installed || settings.busy || environment.dictation.machine.isActive)
                    .accessibilityIdentifier("dictation.settings.download")
                if let error = settings.error { Text(verbatim: error) }
            }.disabled(settings.busy)
            .task { await settings.refresh(locale: environment.dictationLocale) }
            .task(id: settings.language) { await settings.refresh(locale: environment.dictationLocale) }
        } header: { Text("dictation.settings.model") }
          footer: { Text("dictation.settings.appleModels") }
    }
}
