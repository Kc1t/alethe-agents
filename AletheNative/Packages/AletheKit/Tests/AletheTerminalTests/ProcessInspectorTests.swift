import Darwin
import Foundation
import Testing
@testable import AletheTerminal

// Spawns real processes and sockets: a rare intermittent hang must fail the test, not stall the run.
@Suite(.timeLimit(.minutes(1))) struct ProcessInspectorTests {
    /// A TCP socket listening on a kernel-chosen loopback port; closed by `close()`.
    private func listen() throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = UInt32(INADDR_LOOPBACK).bigEndian
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        try #require(bound == 0)
        try #require(Darwin.listen(fd, 1) == 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        try #require(named == 0)
        return (fd, UInt16(bigEndian: address.sin_port))
    }

    @Test func findsAListeningPort() throws {
        let (fd, port) = try listen()
        defer { close(fd) }
        #expect(ProcessInspector.listeningPorts(of: getpid()).contains(port))
    }

    @Test func aClosedSocketIsNotListed() throws {
        let (fd, port) = try listen()
        close(fd)
        #expect(!ProcessInspector.listeningPorts(of: getpid()).contains(port))
    }

    @Test func aGonePidHasNoPorts() {
        #expect(ProcessInspector.listeningPorts(of: 0x7fff_fff0).isEmpty)
    }

    @Test func listsChildrenWithoutTheRoot() throws {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", "sleep 30 & wait"]
        try shell.run()
        let root = shell.processIdentifier
        defer { ProcessTree.kill(root); shell.waitUntilExit() }

        var children: [ProcessNode] = []
        for _ in 0..<50 where children.isEmpty {
            children = ProcessInspector.children(of: root, parents: ProcessTree.currentParents())
            if children.isEmpty { usleep(100_000) }
        }
        let sleep = try #require(children.first { $0.name == "sleep" })
        #expect(sleep.parentPID == root)
        #expect(sleep.command == "sleep 30")
        #expect(sleep.memoryMB > 0)
        #expect(!children.contains { $0.pid == root })
    }

    @Test func parsesProcArgs() {
        var bytes = withUnsafeBytes(of: Int32(3)) { Array($0) }
        bytes += Array("/usr/bin/node\0\0\0".utf8)
        bytes += Array("node\0server.js\0--port=3000\0PATH=/bin\0".utf8)
        #expect(ProcessInspector.parseCommand(bytes) == "node server.js --port=3000")
    }
}
