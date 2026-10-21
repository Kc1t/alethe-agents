import AletheFoundation
import AletheModel
import AppKit

/// The Dock icon follows `PreferencesDocument.iconTheme` (P5-12, upstream `setIcon`). Only the running
/// app's image changes: rewriting the bundle's icon would break its signature.
@MainActor
enum AppIcon {
    private static var applied: AppIconTheme?

    static func image(for theme: AppIconTheme) -> NSImage? {
        NSImage(named: theme.assetName)
    }

    static func apply(_ theme: AppIconTheme) {
        guard theme != applied else { return }
        if theme == .default {
            // nil restores the bundle's AppIcon, already on Apple's grid and in every resolution.
            NSApp.applicationIconImage = AppIdentity.isDebugBuild
                ? Bundle.main.url(forResource: "AppIconDebug", withExtension: "icns").flatMap { NSImage(contentsOf: $0) }
                : nil
        } else {
            guard let image = image(for: theme) else { return }
            NSApp.applicationIconImage = dockImage(image)
        }
        applied = theme
    }

    /// The theme artwork fills its whole canvas; Apple's icon grid draws the rounded square at
    /// 824/1024 of the canvas with a drop shadow in the margin, so the Dock shows it the same size
    /// as other apps (Scripts/make-app-icon.py does the same for the bundle icon).
    private static func dockImage(_ art: NSImage) -> NSImage {
        let canvas = NSSize(width: 1024, height: 1024)
        return NSImage(size: canvas, flipped: false) { rect in
            let side = rect.width * 824 / 1024
            let frame = NSRect(x: rect.midX - side / 2, y: rect.midY - side / 2, width: side, height: side)
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
            shadow.shadowOffset = NSSize(width: 0, height: -rect.height * 10 / 1024)
            shadow.shadowBlurRadius = rect.width * 24 / 1024
            shadow.set()
            art.draw(in: frame)
            if AppIdentity.isDebugBuild { drawDebugBand(in: frame) }
            return true
        }
    }
}

extension AppIcon {
    fileprivate static func drawDebugBand(in frame: NSRect) {
        let band = NSRect(x: frame.minX, y: frame.minY + frame.height * 0.20, width: frame.width, height: frame.height * 0.20)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: frame, xRadius: frame.width * 0.225, yRadius: frame.width * 0.225).addClip()
        NSColor(red: 0.91, green: 0.27, blue: 0.18, alpha: 1).setFill()
        band.fill()
        let font = NSFont.systemFont(ofSize: band.height * 0.62, weight: .heavy)
        let text = NSAttributedString(string: "DEBUG", attributes: [.font: font, .foregroundColor: NSColor.white])
        let size = text.size()
        text.draw(at: NSPoint(x: band.midX - size.width / 2, y: band.midY - size.height / 2))
        NSGraphicsContext.restoreGraphicsState()
    }
}

extension AppEnvironment {
    /// Applies the chosen icon now and again whenever it changes.
    func followAppIcon() {
        let theme = withObservationTracking {
            preferences?.document.iconTheme ?? .default
        } onChange: { [weak self] in
            Task { @MainActor in self?.followAppIcon() }
        }
        AppIcon.apply(theme)
    }
}
