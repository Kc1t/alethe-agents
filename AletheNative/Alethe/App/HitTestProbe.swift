import AletheFoundation
import AppKit

/// Diagnostic for "the title bar does not react": `defaults write <bundle id> debug.hitTestProbe -bool true`. A few
/// seconds after launch it asks the window which view would receive a click along the top bar and logs the answer
/// to `<app support>/logs/hittest.log`. It never sends a click.
@MainActor
enum HitTestProbe {
    static func scheduleIfEnabled() {
        guard UserDefaults.standard.bool(forKey: "debug.hitTestProbe") else { return }
        Task {
            try? await Task.sleep(for: .seconds(5))
            report()
        }
    }

    private static func chain(_ start: NSView?) -> String {
        var names: [String] = []
        var view = start
        while let current = view, names.count < 7 {
            names.append(String(describing: type(of: current)))
            view = current.superview
        }
        return names.joined(separator: " < ")
    }

    private static func report() {
        var lines = ["\(Date()) hit-test probe, bundle \(AppIdentity.bundleIdentifier)"]
        for window in NSApp.windows where window.isVisible && window.contentView != nil {
            guard let content = window.contentView, let frameView = content.superview else { continue }
            lines.append("window \(type(of: window)) '\(window.title)' frame=\(window.frame) key=\(window.isKeyWindow) fullScreen=\(window.styleMask.contains(.fullScreen)) fullSize=\(window.styleMask.contains(.fullSizeContentView)) toolbar=\(window.toolbar == nil ? "nil" : "set") titlebarTransparent=\(window.titlebarAppearsTransparent) contentLayoutRect=\(window.contentLayoutRect)")
            for depth in [8, 20, 34] as [CGFloat] {
                for x in stride(from: 20 as CGFloat, to: min(window.frame.width, 900), by: 70) {
                    let point = NSPoint(x: x, y: window.frame.height - depth)
                    let hit = frameView.hitTest(point)
                    lines.append("  y=top-\(Int(depth)) x=\(Int(x)) movesWindow=\(hit?.mouseDownCanMoveWindow ?? false): \(chain(hit))")
                }
            }
        }
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/\(AppIdentity.bundleIdentifier)/logs/hittest.log")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url)
    }
}
