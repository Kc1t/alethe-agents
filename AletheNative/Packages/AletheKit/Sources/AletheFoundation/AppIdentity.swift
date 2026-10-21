import Foundation

/// Identity of the native app. Distinct from the Tauri app (`com.kc1t.alethe`) so the two
/// never share a data directory.
public enum AppIdentity {
    public static let productionBundleIdentifier = "com.kc1t.alethe.mac"
    public static let bundleIdentifier: String = {
        if let id = Bundle.main.bundleIdentifier, id == productionBundleIdentifier || id == productionBundleIdentifier + ".debug" {
            return id
        }
        return productionBundleIdentifier
    }()
    public static var isDebugBuild: Bool { bundleIdentifier != productionBundleIdentifier }
    public static let productName = "Alethe"
    public static var displayName: String { isDebugBuild ? "Alethe Debug" : productName }

    /// `~/Library/Application Support/<bundle id>` — root of all persisted app data.
    public static func applicationSupportDirectory(fileManager: FileManager = .default) throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base.appending(path: bundleIdentifier, directoryHint: .isDirectory)
    }
}
