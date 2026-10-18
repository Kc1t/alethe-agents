import AudioToolbox
import AVFoundation
import CoreAudio

extension DictationEngine {
    /// Resolve the persisted capture-device UID on each start; never change the system default.
    static func selectMicrophone(_ uid: String, audio: AVAudioEngine) throws {
        guard !uid.isEmpty else { return }
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                                  mScope: kAudioObjectPropertyScopeGlobal,
                                                  mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
            throw StartError.unavailable
        }
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        let status = devices.withUnsafeMutableBytes {
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!)
        }
        guard status == noErr else { throw StartError.unavailable }
        for device in devices {
            var property = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID,
                                                       mScope: kAudioObjectPropertyScopeGlobal,
                                                       mElement: kAudioObjectPropertyElementMain)
            var value: CFString = "" as CFString
            var bytes = UInt32(MemoryLayout<CFString>.size)
            guard AudioObjectGetPropertyData(device, &property, 0, nil, &bytes, &value) == noErr,
                  value as String == uid else { continue }
            guard let unit = audio.inputNode.audioUnit else { throw StartError.unavailable }
            var selected = device
            guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                       0, &selected, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
                throw StartError.unavailable
            }
            return
        }
        throw StartError.unavailable
    }
}
