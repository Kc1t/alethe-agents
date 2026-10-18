import Darwin
import Foundation

/// Fallback for shells without OSC 7 integration. Never reads another app's focused terminal.
public enum PaneWorkingDirectory {
    public static func processDirectory(_ pid: pid_t) -> String? {
        guard pid > 0 else { return nil }
        var info = proc_vnodepathinfo()
        let length = Int32(MemoryLayout<proc_vnodepathinfo>.stride)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, length) == length else { return nil }
        return withUnsafeBytes(of: &info.pvi_cdir.vip_path) { bytes in
            let path = String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
            return path.isEmpty ? nil : path
        }
    }

    /// A missing saved folder must not make the next PTY spawn fail.
    public static func existing(_ saved: String?, home: String = NSHomeDirectory()) -> String {
        var directory: ObjCBool = false
        if let saved, !saved.isEmpty,
           FileManager.default.fileExists(atPath: saved, isDirectory: &directory), directory.boolValue {
            return saved
        }
        return home
    }
}
