import Darwin
import Foundation
import Synchronization
import Testing
@testable import AletheTerminal

@Suite(.timeLimit(.minutes(1))) struct PaneWorkingDirectoryTests {
    @Test func missingFolderFallsBackWithoutAcceptingARegularFile() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "file")
        try Data().write(to: file)
        #expect(PaneWorkingDirectory.existing(directory.path, home: "/fallback") == directory.path)
        #expect(PaneWorkingDirectory.existing(file.path, home: "/fallback") == "/fallback")
        #expect(PaneWorkingDirectory.existing(directory.appending(path: "missing").path, home: "/fallback") == "/fallback")
        #expect(PaneWorkingDirectory.processDirectory(0) == nil)
    }

    @Test func readsTheRealPTYChildDirectoryAfterShellCD() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let process = try PTYProcess(PTYLaunch(
            executable: "/bin/sh", arguments: ["sh", "-c", "cd \"$TARGET\" && echo ready; read answer"],
            environment: ["PATH": "/usr/bin:/bin", "TARGET": directory.path],
            workingDirectory: "/", size: PTYSize(columns: 80, rows: 24)))
        let observed = Mutex<String?>(nil)
        let code: Int32 = await withCheckedContinuation { continuation in
            process.onOutput = { data in
                if String(decoding: data, as: UTF8.self).contains("ready") {
                    let cwd = PaneWorkingDirectory.processDirectory(process.pid)
                    observed.withLock { $0 = cwd }
                    process.write(Data("done\n".utf8))
                }
            }
            process.onExit = { continuation.resume(returning: $0) }
            process.start()
        }
        #expect(code == 0)
        // The kernel reports the canonical path (/private/var/...); `resolvingSymlinksInPath` strips `/private`.
        let canonical = directory.path.withCString { realpath($0, nil) }.map { pointer in
            defer { free(pointer) }
            return String(cString: pointer)
        }
        #expect(observed.withLock { $0 } == canonical)
    }
}
