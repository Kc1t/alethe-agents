import Foundation

/// Personalization of the frame drawn around the focused pane: on/off and how opaque it is.
/// Stored in the app's defaults (a native-only look setting, not part of the shared preferences JSON).
enum PaneFocusBorder {
    static let enabledKey = "pane.focusBorder.enabled"
    static let opacityKey = "pane.focusBorder.opacity"

    static var enabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    /// 0.1...1; 1 is the look the web ships.
    static var opacity: Double {
        min(1, max(0.1, UserDefaults.standard.object(forKey: opacityKey) as? Double ?? 1))
    }
}
