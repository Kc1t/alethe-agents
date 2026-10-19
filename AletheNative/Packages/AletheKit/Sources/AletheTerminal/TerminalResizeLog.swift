import Foundation
import GhosttyTerminal

/// Opt-in diagnostics for terminal sizing: `defaults write com.kc1t.alethe.mac debug.terminalResize -bool YES`
/// writes the Ghostty metrics and every PTY winsize to ~/Library/Logs/Alethe-terminal-resize.log.
enum TerminalResizeLog {
    private static let path = NSString(string: "~/Library/Logs/Alethe-terminal-resize.log").expandingTildeInPath
    private static let queue = DispatchQueue(label: "alethe.terminal.resizelog")
    private static let enabled: Bool = UserDefaults.standard.bool(forKey: "debug.terminalResize")

    static func enableIfRequested() {
        guard enabled else { return }
        TerminalDebugLog.isEnabled = true
        TerminalDebugLog.categories = .metrics
        TerminalDebugLog.sink = { write($0) }
    }

    static func write(_ line: String) {
        guard enabled else { return }
        let stamp = String(format: "%.3f", Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 100000))
        queue.async {
            guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
            if let handle = FileHandle(forWritingAtPath: path) {
                handle.seekToEndOfFile(); handle.write(data); try? handle.close()
            } else {
                FileManager.default.createFile(atPath: path, contents: data)
            }
        }
    }
}
