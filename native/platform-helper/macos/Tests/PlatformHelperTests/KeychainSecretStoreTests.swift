@preconcurrency import Dispatch
import Foundation
import Testing

@testable import PlatformHelperService

@Suite struct KeychainSecretStoreTests {
    private let rawReference = "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1"

    @Test
    func testSecretReferenceUsesStrictGrammarAndOpaqueAccountDerivation() throws {
        let reference = try SecretReference(rawReference)
        XCTAssertEqual(reference.account, "provider:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:api:v1")
        XCTAssertEqual(reference.rawValue, rawReference)

        for invalid in [
            "forged",
            "aemcp-secret://provider/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/api/v1",
            "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/Api/v1",
            "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api.key/v1",
            "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1api/v1",
            "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v1",
        ] {
            XCTAssertThrowsError(try SecretReference(invalid)) { error in
                XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_REFERENCE")
            }
        }
    }

    @Test
    func testSetUsesCreateThenExactRevisionCASAndReadback() throws {
        let backend = InMemoryKeychainBackend()
        let store = KeychainSecretStore(backend: backend)
        let reference = try SecretReference(rawReference)

        let first = try store.set(reference: reference, value: Data("one".utf8), expectedRevision: nil)
        XCTAssertEqual(first, SecretRecord(reference: reference, value: Data("one".utf8), revision: 1))
        XCTAssertEqual(backend.lastService, "com.junkdoge.ae-mcp")
        XCTAssertEqual(backend.lastAccount, reference.account)

        let second = try store.set(reference: reference, value: Data("two".utf8), expectedRevision: 1)
        XCTAssertEqual(second.revision, 2)
        XCTAssertEqual(try store.get(reference: reference), second)

        XCTAssertThrowsError(
            try store.set(reference: reference, value: Data("three".utf8), expectedRevision: 1)
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_CONFLICT")
        }
        XCTAssertThrowsError(
            try store.set(reference: reference, value: Data("create-again".utf8), expectedRevision: nil)
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_CONFLICT")
        }
        XCTAssertEqual(try store.get(reference: reference), second)
    }

    @Test
    func testDeleteIsIdempotentAndRevisionChecked() throws {
        let store = KeychainSecretStore(backend: InMemoryKeychainBackend())
        let reference = try SecretReference(rawReference)
        _ = try store.set(reference: reference, value: Data("one".utf8), expectedRevision: nil)

        XCTAssertThrowsError(try store.delete(reference: reference, expectedRevision: 2)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_CONFLICT")
        }
        XCTAssertEqual(
            try store.delete(reference: reference, expectedRevision: 1),
            SecretDeleteResult(reference: reference, deleted: true, revision: 1)
        )
        XCTAssertEqual(
            try store.delete(reference: reference, expectedRevision: 1),
            SecretDeleteResult(reference: reference, deleted: false, revision: nil)
        )
        XCTAssertNil(try store.get(reference: reference))
    }

    @Test
    func testSetFailsClosedWhenImmediateReadbackDiffersAndRestoresPreviousBlob() throws {
        let backend = CorruptingReadbackBackend()
        let store = KeychainSecretStore(backend: backend)
        let reference = try SecretReference(rawReference)

        XCTAssertThrowsError(
            try store.set(reference: reference, value: Data("must-not-leak".utf8), expectedRevision: nil)
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_STORE_UNAVAILABLE")
            XCTAssertFalse(String(describing: error).contains("must-not-leak"))
            XCTAssertFalse(String(describing: error).contains(rawReference))
        }
        XCTAssertNil(backend.stored)
    }

    @Test
    func testCredentialBlobContainsOnlySchemaRevisionAndBase64Value() throws {
        let backend = InMemoryKeychainBackend()
        let store = KeychainSecretStore(backend: backend)
        let reference = try SecretReference(rawReference)
        _ = try store.set(reference: reference, value: Data("secret".utf8), expectedRevision: nil)

        let blob = try XCTUnwrap(backend.storedData(service: "com.junkdoge.ae-mcp", account: reference.account))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: blob) as? NSDictionary)
        XCTAssertEqual(Set(object.allKeys.compactMap { $0 as? String }), ["schemaVersion", "revision", "value"])
        XCTAssertEqual(object["schemaVersion"] as? Int, 1)
        XCTAssertEqual(object["revision"] as? Int, 1)
        XCTAssertEqual(object["value"] as? String, Data("secret".utf8).base64EncodedString())
        XCTAssertFalse(String(data: blob, encoding: .utf8)?.contains(rawReference) ?? true)
    }

    @Test
    func testAuthorizedRegistrySharesOneStoreAndSerializesConcurrentCAS() throws {
        let backend = InMemoryKeychainBackend()
        var factoryCount = 0
        let registry = AuthorizedBackendRegistry(secretStoreFactory: {
            factoryCount += 1
            return KeychainSecretStore(backend: backend)
        })
        let firstConnectionStore = registry.secretStore()
        let secondConnectionStore = registry.secretStore()
        XCTAssertEqual(factoryCount, 1)
        #expect((firstConnectionStore as AnyObject) === (secondConnectionStore as AnyObject))

        let reference = try SecretReference(rawReference)
        _ = try firstConnectionStore.set(
            reference: reference,
            value: Data("initial".utf8),
            expectedRevision: nil
        )
        let results = ConcurrentMutationResults()
        let group = DispatchGroup()
        for (store, value) in [
            (firstConnectionStore, "first"),
            (secondConnectionStore, "second"),
        ] {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                do {
                    let record = try store.set(
                        reference: reference,
                        value: Data(value.utf8),
                        expectedRevision: 1
                    )
                    results.append(.success(record.revision))
                } catch {
                    results.append(.failure(error))
                }
            }
        }
        group.wait()

        let snapshot = results.snapshot()
        XCTAssertEqual(snapshot.compactMap { try? $0.get() }, [2])
        XCTAssertEqual(snapshot.compactMap { result -> String? in
            guard case let .failure(error) = result else { return nil }
            return (error as? HelperFailure)?.code
        }, ["SECRET_CONFLICT"])
        XCTAssertEqual(try firstConnectionStore.get(reference: reference)?.revision, 2)
    }

    @Test
    func testMutationFailureRollsBackAndVerifiesBothSetAndDelete() throws {
        let backend = MutatingFailureBackend()
        let store = KeychainSecretStore(backend: backend)
        let reference = try SecretReference(rawReference)
        _ = try store.set(reference: reference, value: Data("original".utf8), expectedRevision: nil)

        backend.failUpdateAfterMutation = true
        XCTAssertThrowsError(
            try store.set(reference: reference, value: Data("replacement".utf8), expectedRevision: 1)
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_STORE_UNAVAILABLE")
        }
        XCTAssertEqual(try store.get(reference: reference)?.value, Data("original".utf8))

        backend.failDeleteAfterMutation = true
        XCTAssertThrowsError(try store.delete(reference: reference, expectedRevision: 1)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_STORE_UNAVAILABLE")
        }
        XCTAssertEqual(try store.get(reference: reference)?.value, Data("original".utf8))
        #expect(backend.rollbackVerificationReadCount >= 2)
    }

    @Test
    func testRollbackFailureReportsExplicitUncertainStateWithoutSecretMaterial() throws {
        let backend = UnrecoverableSetBackend()
        let store = KeychainSecretStore(backend: backend)
        let reference = try SecretReference(rawReference)

        XCTAssertThrowsError(
            try store.set(reference: reference, value: Data("must-not-leak".utf8), expectedRevision: nil)
        ) { error in
            let failure = error as? HelperFailure
            XCTAssertEqual(failure?.code, "SECRET_STORE_UNAVAILABLE")
            XCTAssertEqual(failure?.retryable, false)
            #expect(failure?.safeMessage.contains("state is uncertain") == true)
            XCTAssertFalse(String(describing: error).contains("must-not-leak"))
            XCTAssertFalse(String(describing: error).contains(rawReference))
        }
    }

    @Test
    func testDeleteReadbackMismatchRestoresAndVerifiesThePreviousBlob() throws {
        let backend = CorruptingDeleteBackend()
        let store = KeychainSecretStore(backend: backend)
        let reference = try SecretReference(rawReference)
        _ = try store.set(reference: reference, value: Data("original".utf8), expectedRevision: nil)

        backend.corruptNextDelete = true
        XCTAssertThrowsError(try store.delete(reference: reference, expectedRevision: 1)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_STORE_UNAVAILABLE")
        }
        XCTAssertEqual(try store.get(reference: reference)?.value, Data("original".utf8))
        XCTAssertEqual(backend.rollbackUpdateCount, 1)
        #expect(backend.rollbackVerificationReadCount >= 1)
    }

    @Test
    func testCredentialBlobRejectsUnknownOrMissingKeysAndRevisionOverflow() throws {
        let reference = try SecretReference(rawReference)
        for raw in [
            #"{"schemaVersion":1,"revision":1,"value":"c2VjcmV0","extra":true}"#,
            #"{"schemaVersion":1,"revision":1}"#,
        ] {
            let backend = InMemoryKeychainBackend()
            try backend.add(
                service: KeychainSecretStore.service,
                account: reference.account,
                data: Data(raw.utf8)
            )
            let store = KeychainSecretStore(backend: backend)
            XCTAssertThrowsError(try store.get(reference: reference)) { error in
                XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_STORE_UNAVAILABLE")
            }
        }

        let backend = InMemoryKeychainBackend()
        let maximum = Data(
            #"{"revision":\#(Int.max),"schemaVersion":1,"value":"c2VjcmV0"}"#.utf8
        )
        try backend.add(
            service: KeychainSecretStore.service,
            account: reference.account,
            data: maximum
        )
        let store = KeychainSecretStore(backend: backend)
        XCTAssertThrowsError(
            try store.set(reference: reference, value: Data("next".utf8), expectedRevision: Int.max)
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "SECRET_STORE_UNAVAILABLE")
        }
        XCTAssertEqual(
            backend.storedData(service: KeychainSecretStore.service, account: reference.account),
            maximum
        )
    }
}

private final class ConcurrentMutationResults: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Result<Int, Error>] = []

    func append(_ value: Result<Int, Error>) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func snapshot() -> [Result<Int, Error>] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

private final class CorruptingReadbackBackend: KeychainBackend {
    var stored: Data?
    private var corruptNextRead = false

    func read(service: String, account: String) throws -> Data? {
        if corruptNextRead {
            corruptNextRead = false
            return Data(#"{"schemaVersion":1,"revision":99,"value":"Y29ycnVwdA=="}"#.utf8)
        }
        return stored
    }

    func add(service: String, account: String, data: Data) throws {
        stored = data
        corruptNextRead = true
    }

    func update(service: String, account: String, data: Data) throws {
        stored = data
        corruptNextRead = true
    }

    func delete(service: String, account: String) throws {
        stored = nil
    }
}

private final class MutatingFailureBackend: KeychainBackend {
    private var stored: Data?
    var failUpdateAfterMutation = false
    var failDeleteAfterMutation = false
    private(set) var rollbackVerificationReadCount = 0
    private var countVerificationRead = false

    func read(service: String, account: String) throws -> Data? {
        if countVerificationRead {
            rollbackVerificationReadCount += 1
            countVerificationRead = false
        }
        return stored
    }

    func add(service: String, account: String, data: Data) throws {
        stored = data
    }

    func update(service: String, account: String, data: Data) throws {
        stored = data
        if failUpdateAfterMutation {
            failUpdateAfterMutation = false
            countVerificationRead = true
            throw HelperFailure.secretStoreUnavailable
        }
        countVerificationRead = true
    }

    func delete(service: String, account: String) throws {
        stored = nil
        if failDeleteAfterMutation {
            failDeleteAfterMutation = false
            countVerificationRead = true
            throw HelperFailure.secretStoreUnavailable
        }
        countVerificationRead = true
    }
}

private final class UnrecoverableSetBackend: KeychainBackend {
    private var stored: Data?
    private var shouldCorruptReadback = false

    func read(service: String, account: String) throws -> Data? {
        if shouldCorruptReadback {
            shouldCorruptReadback = false
            return Data(#"{"schemaVersion":1,"revision":99,"value":"Y29ycnVwdA=="}"#.utf8)
        }
        return stored
    }

    func add(service: String, account: String, data: Data) throws {
        stored = data
        shouldCorruptReadback = true
    }

    func update(service: String, account: String, data: Data) throws {
        throw HelperFailure.secretStoreUnavailable
    }

    func delete(service: String, account: String) throws {
        throw HelperFailure.secretStoreUnavailable
    }
}

private final class CorruptingDeleteBackend: KeychainBackend {
    private var stored: Data?
    var corruptNextDelete = false
    private(set) var rollbackUpdateCount = 0
    private(set) var rollbackVerificationReadCount = 0
    private var countVerificationRead = false

    func read(service: String, account: String) throws -> Data? {
        if countVerificationRead {
            rollbackVerificationReadCount += 1
            countVerificationRead = false
        }
        return stored
    }

    func add(service: String, account: String, data: Data) throws {
        stored = data
    }

    func update(service: String, account: String, data: Data) throws {
        stored = data
        rollbackUpdateCount += 1
        countVerificationRead = true
    }

    func delete(service: String, account: String) throws {
        if corruptNextDelete {
            corruptNextDelete = false
            stored = Data("invalid-post-delete-state".utf8)
        } else {
            stored = nil
        }
    }
}
