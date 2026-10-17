import Foundation
import Security
import Darwin

/// Serialized discovery also coalesces concurrent polls. Failed/denied reads are remembered until reconnect.
final class UsageCredentialCache: @unchecked Sendable {
    struct Credential {
        var token: String
        var expiresAt: Date?
    }
    private let lock = NSLock()
    private var entries: [String: Credential] = [:]
    private var attempted: Set<String> = []
    private var rejected: [String: Set<String>] = [:]

    func token(key: String, allowInteraction: Bool = true, now: Date = Date(),
               local: () -> Credential?, secret: () -> Credential?) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if let value = local(), value.expiresAt.map({ $0 > now }) ?? true { return value.token }
        if let value = entries[key] {
            if value.expiresAt.map({ $0 > now }) ?? true { return value.token }
            entries[key] = nil
            attempted.remove(key)
        }
        guard allowInteraction, !attempted.contains(key) else { return nil }
        attempted.insert(key)
        guard let value = secret(), value.expiresAt.map({ $0 > now }) ?? true else { return nil }
        entries[key] = value
        return value.token
    }

    /// Refresh each rejected token only once, even if the CLI has not replaced it yet.
    @discardableResult
    func reject(key: String, token: String, status: Int) -> Bool {
        guard status == 401 || status == 403 else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard rejected[key, default: []].insert(token).inserted else { return false }
        if entries[key]?.token == token { entries[key] = nil; attempted.remove(key) }
        return true
    }

    func reconnect() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
        attempted.removeAll()
        rejected.removeAll()
    }
}

/// Uses Apple's stable signing identity rather than a changing development app signature.
struct UsageKeychainReader {
    var toolExists: () -> Bool = { FileManager.default.isExecutableFile(atPath: "/usr/bin/security") }
    var run: ([String]) -> Data? = Self.runSecurity
    var fallback: (String, String?, Bool) -> Data? = Self.readSecurityFramework

    func read(service: String, account: String? = nil) -> Data? {
        guard toolExists() else { return fallback(service, account, true) }
        var arguments = ["find-generic-password", "-s", service]
        if let account { arguments += ["-a", account] }
        return run(arguments + ["-w"])
    }

    func contains(service: String, account: String? = nil) -> Bool {
        guard toolExists() else { return Self.containsSecurityFramework(service: service, account: account) }
        var arguments = ["find-generic-password", "-s", service]
        if let account { arguments += ["-a", account] }
        // Attributes only: never request -w or -g during sign-in discovery.
        return run(arguments) != nil
    }

    private static func runSecurity(_ arguments: [String]) -> Data? {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/security")
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        guard (try? process.run()) != nil else { return nil }
        let watchdog = DispatchWorkItem {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: watchdog)
        defer { watchdog.cancel() }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return data
    }

    private static func query(service: String, account: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }

    private static func readSecurityFramework(service: String, account: String?, allowInteraction: Bool) -> Data? {
        var query = query(service: service, account: account)
        query[kSecReturnData as String] = true
        if !allowInteraction { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip }
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private static func containsSecurityFramework(service: String, account: String?) -> Bool {
        var query = query(service: service, account: account)
        query[kSecReturnAttributes as String] = true
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        var result: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess
    }
}
