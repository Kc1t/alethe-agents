import Darwin
import Foundation
import Testing
import AletheIntegrations
@testable import AletheOrchestrator

private let environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]

private func shell(_ script: String) -> Launcher {
    Launcher(kind: "test", program: URL(filePath: "/bin/sh"), arguments: ["-c", script])
}

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "worker-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// The next value; a worker that never answers fails the suite's time limit.
private func next(_ iterator: inout AsyncStream<OrderedJSON>.Iterator) async -> OrderedJSON? {
    await iterator.next()
}

private func gone(_ pid: pid_t) -> Bool {
    Darwin.kill(pid, 0) != 0 && errno == ESRCH
}

private func groupGone(_ pid: pid_t) -> Bool {
    Darwin.kill(-pid, 0) != 0 && errno == ESRCH
}

// Spawns real processes: a hang must fail the test, not stall the run.
@Suite(.timeLimit(.minutes(1))) struct WorkerProcessTests {
    @Test func linesAreJSONValuesAndEOFEndsTheStream() async throws {
        let worker = try WorkerProcess.spawn(
            shell(#"printf '{"a":1}\nnot json\n\n  {"b":[2]}  \n{"c":true}'"#),
            in: URL(filePath: "/tmp"), environment: environment)
        var values: [OrderedJSON] = []
        for await value in worker.lines { values.append(value) }
        #expect(values == [["a": 1], ["b": [2]], ["c": true]], "invalid and blank lines are skipped; a last line without newline counts")
        await worker.terminate()
        #expect(await !worker.isRunning)
    }

    @Test func runsInTheJobFolderInItsOwnGroupWithTheGivenEnvironment() async throws {
        let folder = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let worker = try WorkerProcess.spawn(
            shell(#"printf '{"cwd":"%s","group":"%s","var":"%s"}\n' "$(pwd -P)" "$(ps -o pgid= -p $$ | tr -d ' ')" "$ONLY_HERE""#),
            in: folder, environment: environment.merging(["ONLY_HERE": "yes"]) { $1 })
        var iterator = worker.lines.makeAsyncIterator()
        let line = try #require(await next(&iterator))
        let object = try #require(line.objectValue)
        // `pwd -P` prints the real path (`/private/var/…`); `resolvingSymlinksInPath()` strips `/private`.
        let real = try #require(realpath(folder.path, nil))
        defer { free(real) }
        #expect(object["cwd"]?.stringValue == String(cString: real))
        #expect(object["group"]?.stringValue == String(worker.pid), "the worker leads its own process group")
        #expect(object["var"]?.stringValue == "yes")
        await worker.terminate()
    }

    @Test func aChildIgnoringSIGTERMIsKilledAndReaped() async throws {
        let worker = try WorkerProcess.spawn(
            shell(#"trap '' TERM; sleep 60 & echo '{"ready":true}'; while :; do sleep 1; done"#),
            in: URL(filePath: "/tmp"), environment: environment, grace: .milliseconds(400))
        var iterator = worker.lines.makeAsyncIterator()
        #expect(await next(&iterator) == ["ready": true])
        let started = ContinuousClock.now
        await worker.terminate()
        #expect(ContinuousClock.now - started >= .milliseconds(400), "SIGKILL only after the grace period")
        #expect(await worker.exitStatus != nil, "the leader was reaped")
        #expect(gone(worker.pid), "no zombie is left")
        // The group's other members die right after the leader's SIGKILL; give the kernel a moment to reap them.
        var groupDeadline = 100
        while !groupGone(worker.pid), groupDeadline > 0 {
            try await Task.sleep(for: .milliseconds(50))
            groupDeadline -= 1
        }
        #expect(groupGone(worker.pid), "its background child went with it")
        #expect(await iterator.next() == nil, "stdout ends with the process")
    }

    @Test func terminatingTwiceOrConcurrentlyIsSafe() async throws {
        let worker = try WorkerProcess.spawn(shell("sleep 60"), in: URL(filePath: "/tmp"), environment: environment)
        async let first: Void = worker.terminate()
        async let second: Void = worker.terminate()
        _ = await (first, second)
        await worker.terminate()
        #expect(gone(worker.pid))
    }

    @Test func aCancelledCallerStillEndsTheWorker() async throws {
        let worker = try WorkerProcess.spawn(shell("trap '' TERM; while :; do sleep 1; done"), in: URL(filePath: "/tmp"),
                                             environment: environment, grace: .milliseconds(300))
        let task = Task { await worker.terminate() }
        task.cancel()
        await task.value
        #expect(gone(worker.pid))
        #expect(groupGone(worker.pid))
    }

    @Test func aFullPipeDoesNotBlockAnotherWorker() async throws {
        // Never reads its stdin: its pipe fills and every further write to it blocks.
        let stuck = try WorkerProcess.spawn(shell("sleep 60"), in: URL(filePath: "/tmp"), environment: environment)
        let echo = try WorkerProcess.spawn(
            Launcher(kind: "test", program: URL(filePath: "/bin/cat"), arguments: []),
            in: URL(filePath: "/tmp"), environment: environment)
        let payload = OrderedJSON.string(String(repeating: "x", count: 8 * 1024))
        for index in 0..<64 { stuck.writer.send(["seq": .integer(index), "pad": payload]) }

        var iterator = echo.lines.makeAsyncIterator()
        for index in 0..<3 {
            try await echo.writer.sendAndWait(["seq": .integer(index)])
            #expect(await next(&iterator) == ["seq": .integer(index)], "lines arrive in order, unblocked by the stuck worker")
        }

        await stuck.terminate()
        await #expect(throws: WorkerWriteError.closed) { try await stuck.writer.sendAndWait(["late": true]) }
        await echo.terminate()
        #expect(gone(stuck.pid) && gone(echo.pid))
    }

    @Test func closingStdinGivesTheWorkerEOF() async throws {
        let echo = try WorkerProcess.spawn(
            shell(#"cat >/dev/null; echo '{"eof":true}'"#), in: URL(filePath: "/tmp"), environment: environment)
        echo.writer.send(["x": 1])
        echo.writer.close()
        var iterator = echo.lines.makeAsyncIterator()
        #expect(await next(&iterator) == ["eof": true])
        #expect(echo.writer.isClosed)
        await echo.terminate()
    }

    @Test func aMissingProgramOrFolderIsASpawnError() {
        #expect(throws: WorkerProcessError.self) {
            _ = try WorkerProcess.spawn(Launcher(kind: "test", program: URL(filePath: "/nonexistent/codex"), arguments: []),
                                        in: URL(filePath: "/tmp"), environment: environment)
        }
        #expect(throws: WorkerProcessError.self) {
            _ = try WorkerProcess.spawn(shell("true"), in: URL(filePath: "/nonexistent-folder-\(UUID().uuidString)"),
                                        environment: environment)
        }
    }

    @Test func aLiveWorkerIsRecordedUntilItEnds() async throws {
        let folder = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let registry = WorkerRegistry(profileDirectory: folder)
        let worker = try WorkerProcess.spawn(shell(#"echo '{"up":1}'; sleep 60"#), in: URL(filePath: "/tmp"),
                                             environment: environment, jobID: "job-01", registry: registry)
        var iterator = worker.lines.makeAsyncIterator()
        _ = await next(&iterator)
        let record = try #require(registry.records.first)
        #expect(record.pid == worker.pid && record.groupID == worker.pid && record.jobID == "job-01")
        #expect(record.executables.contains("/bin/sh"))
        #expect(WorkerRegistry.matches(record, live: WorkerProcessTable.process(worker.pid)))
        #expect(WorkerRegistry(profileDirectory: folder).leftovers().map(\.pid) == [worker.pid], "written to disk")
        await worker.terminate()
        #expect(registry.records.isEmpty)
        #expect(WorkerRegistry(profileDirectory: folder).leftovers().isEmpty)
    }

    /// P: spawn to first line.
    @Test func spawnToFirstLineIsQuick() async throws {
        let started = ContinuousClock.now
        let worker = try WorkerProcess.spawn(shell(#"echo '{"hello":1}'; sleep 5"#), in: URL(filePath: "/tmp"),
                                             environment: environment)
        var iterator = worker.lines.makeAsyncIterator()
        #expect(await next(&iterator) == ["hello": 1])
        let elapsed = ContinuousClock.now - started
        #expect(elapsed < .milliseconds(1500), "spawn to first line took \(elapsed)")
        await worker.terminate()
    }
}
