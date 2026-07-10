import Foundation
import Security

struct SecretReference: Hashable {
    let rawValue: String
    let providerIdentifier: String
    let slot: String

    var account: String { "provider:\(providerIdentifier):\(slot):v1" }

    init(_ rawValue: String) throws {
        let pattern = #"^aemcp-secret://provider/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/([a-z][a-z0-9_-]{0,31})/v1$"#
        let expression: NSRegularExpression
        do {
            expression = try NSRegularExpression(pattern: pattern)
        } catch {
            throw HelperFailure.invalidReference
        }
        guard let match = expression.firstMatch(
                in: rawValue,
                range: NSRange(rawValue.startIndex..., in: rawValue)
              ),
              match.range == NSRange(rawValue.startIndex..., in: rawValue),
              let providerRange = Range(match.range(at: 1), in: rawValue),
              let slotRange = Range(match.range(at: 2), in: rawValue)
        else {
            throw HelperFailure.invalidReference
        }
        self.rawValue = rawValue
        providerIdentifier = String(rawValue[providerRange])
        slot = String(rawValue[slotRange])
    }
}

struct SecretRecord: Equatable {
    let reference: SecretReference
    let value: Data
    let revision: Int
}

struct SecretDeleteResult: Equatable {
    let reference: SecretReference
    let deleted: Bool
    let revision: Int?
}

protocol SecretStoring {
    func get(reference: SecretReference) throws -> SecretRecord?
    func set(reference: SecretReference, value: Data, expectedRevision: Int?) throws -> SecretRecord
    func delete(reference: SecretReference, expectedRevision: Int?) throws -> SecretDeleteResult
}

protocol KeychainBackend {
    func read(service: String, account: String) throws -> Data?
    func add(service: String, account: String, data: Data) throws
    func update(service: String, account: String, data: Data) throws
    func delete(service: String, account: String) throws
}

private struct CredentialBlob: Codable, Equatable {
    let schemaVersion: Int
    let revision: Int
    let value: Data
}

final class KeychainSecretStore: SecretStoring {
    static let service = "com.junkdoge.ae-mcp"

    private let backend: KeychainBackend
    private let mutationLock = NSLock()
    private let encoder: JSONEncoder

    init(backend: KeychainBackend = SecurityKeychainBackend()) {
        self.backend = backend
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
    }

    func get(reference: SecretReference) throws -> SecretRecord? {
        try mutationLock.withLock {
            guard let raw = try safeRead(account: reference.account) else { return nil }
            let blob = try decode(raw)
            return SecretRecord(reference: reference, value: blob.value, revision: blob.revision)
        }
    }

    func set(
        reference: SecretReference,
        value: Data,
        expectedRevision: Int?
    ) throws -> SecretRecord {
        try mutationLock.withLock {
            let oldRaw = try safeRead(account: reference.account)
            let oldBlob = try oldRaw.map(decode)
            let nextRevision: Int
            if let oldBlob {
                guard let expectedRevision, expectedRevision == oldBlob.revision else {
                    throw HelperFailure.secretConflict
                }
                guard oldBlob.revision < Int.max else {
                    throw HelperFailure.secretStoreUnavailable
                }
                nextRevision = oldBlob.revision + 1
            } else {
                guard expectedRevision == nil else { throw HelperFailure.secretConflict }
                nextRevision = 1
            }
            let blob = CredentialBlob(schemaVersion: 1, revision: nextRevision, value: value)
            do {
                let encoded = try encoder.encode(blob)
                try mutateAndVerify(
                    account: reference.account,
                    previous: oldRaw,
                    expected: encoded
                ) {
                    if oldRaw == nil {
                        try backend.add(
                            service: Self.service,
                            account: reference.account,
                            data: encoded
                        )
                    } else {
                        try backend.update(
                            service: Self.service,
                            account: reference.account,
                            data: encoded
                        )
                    }
                }
            } catch let failure as HelperFailure {
                throw failure
            } catch {
                throw HelperFailure.secretStoreUnavailable
            }
            return SecretRecord(reference: reference, value: value, revision: nextRevision)
        }
    }

    func delete(
        reference: SecretReference,
        expectedRevision: Int?
    ) throws -> SecretDeleteResult {
        try mutationLock.withLock {
            guard let oldRaw = try safeRead(account: reference.account) else {
                return SecretDeleteResult(reference: reference, deleted: false, revision: nil)
            }
            let oldBlob = try decode(oldRaw)
            if let expectedRevision, expectedRevision != oldBlob.revision {
                throw HelperFailure.secretConflict
            }
            try mutateAndVerify(
                account: reference.account,
                previous: oldRaw,
                expected: nil
            ) {
                try backend.delete(service: Self.service, account: reference.account)
            }
            return SecretDeleteResult(
                reference: reference,
                deleted: true,
                revision: oldBlob.revision
            )
        }
    }

    private func safeRead(account: String) throws -> Data? {
        do {
            return try backend.read(service: Self.service, account: account)
        } catch {
            throw HelperFailure.secretStoreUnavailable
        }
    }

    private func decode(_ data: Data) throws -> CredentialBlob {
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["schemaVersion", "revision", "value"],
                  let schemaVersion = exactInteger(object["schemaVersion"]),
                  schemaVersion == 1,
                  let revision = exactInteger(object["revision"]),
                  revision > 0,
                  let encodedValue = object["value"] as? String,
                  let value = Data(base64Encoded: encodedValue),
                  value.base64EncodedString() == encodedValue
            else {
                throw HelperFailure.secretStoreUnavailable
            }
            return CredentialBlob(schemaVersion: schemaVersion, revision: revision, value: value)
        } catch let failure as HelperFailure {
            throw failure
        } catch {
            throw HelperFailure.secretStoreUnavailable
        }
    }

    private func exactInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              !number.stringValue.contains("."),
              !number.stringValue.contains("e"),
              !number.stringValue.contains("E")
        else {
            return nil
        }
        return Int(number.stringValue)
    }

    private func mutateAndVerify(
        account: String,
        previous: Data?,
        expected: Data?,
        mutation: () throws -> Void
    ) throws {
        do {
            try mutation()
            guard try backend.read(service: Self.service, account: account) == expected else {
                throw HelperFailure.secretStoreUnavailable
            }
        } catch {
            do {
                try restoreAndVerify(account: account, previous: previous)
            } catch {
                throw HelperFailure.secretStoreStateUncertain
            }
            throw HelperFailure.secretStoreUnavailable
        }
    }

    private func restoreAndVerify(account: String, previous: Data?) throws {
        let current = try backend.read(service: Self.service, account: account)
        if let previous {
            if current == nil {
                try backend.add(service: Self.service, account: account, data: previous)
            } else if current != previous {
                try backend.update(service: Self.service, account: account, data: previous)
            }
        } else if current != nil {
            try backend.delete(service: Self.service, account: account)
        }
        guard try backend.read(service: Self.service, account: account) == previous else {
            throw HelperFailure.secretStoreStateUncertain
        }
    }
}

final class InMemoryKeychainBackend: KeychainBackend {
    private var values: [String: Data] = [:]
    private let lock = NSLock()
    private(set) var lastService: String?
    private(set) var lastAccount: String?

    func read(service: String, account: String) throws -> Data? {
        lock.withLock {
            record(service: service, account: account)
            return values[key(service: service, account: account)]
        }
    }

    func add(service: String, account: String, data: Data) throws {
        try lock.withLock {
            record(service: service, account: account)
            let key = key(service: service, account: account)
            guard values[key] == nil else { throw HelperFailure.secretStoreUnavailable }
            values[key] = data
        }
    }

    func update(service: String, account: String, data: Data) throws {
        try lock.withLock {
            record(service: service, account: account)
            let key = key(service: service, account: account)
            guard values[key] != nil else { throw HelperFailure.secretStoreUnavailable }
            values[key] = data
        }
    }

    func delete(service: String, account: String) throws {
        lock.withLock {
            record(service: service, account: account)
            values.removeValue(forKey: key(service: service, account: account))
        }
    }

    func storedData(service: String, account: String) -> Data? {
        lock.withLock { values[key(service: service, account: account)] }
    }

    private func key(service: String, account: String) -> String { "\(service)\u{0}\(account)" }

    private func record(service: String, account: String) {
        lastService = service
        lastAccount = account
    }
}

final class SecurityKeychainBackend: KeychainBackend {
    func read(service: String, account: String) throws -> Data? {
        var item: CFTypeRef?
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw HelperFailure.secretStoreUnavailable
        }
        return data
    }

    func add(service: String, account: String, data: Data) throws {
        var query = baseQuery(service: service, account: account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
            throw HelperFailure.secretStoreUnavailable
        }
    }

    func update(service: String, account: String, data: Data) throws {
        let status = SecItemUpdate(
            baseQuery(service: service, account: account) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        guard status == errSecSuccess else { throw HelperFailure.secretStoreUnavailable }
    }

    func delete(service: String, account: String) throws {
        let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HelperFailure.secretStoreUnavailable
        }
    }

    private func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
