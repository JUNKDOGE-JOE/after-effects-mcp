import Foundation
import Testing

@testable import PlatformHelperService

@Suite struct ProtocolDispatcherTests {
    @Test
    func testUnauthorizedCallerIsRejectedBeforeValidationOrBackendAccess() async throws {
        let validator = CountingValidator()
        let secrets = CountingSecretStore()
        let captures = CountingCaptureBackend()
        let dispatcher = ProtocolDispatcher(
            authorizer: RejectingAuthorizer(),
            validator: validator,
            secrets: secrets,
            captures: captures
        )

        let response = await dispatcher.handle(
            connection: .fixture,
            bytes: Data(#"{"protocolVersion":1,"id":47,"method":"secret.get","params":{"reference":"forged"}}"#.utf8)
        )

        XCTAssertEqual(response.id, 47)
        XCTAssertEqual(response.error?.code, "HELPER_UNAUTHORIZED")
        XCTAssertEqual(response.error?.message, "caller is not authorized; backendAccessCount=0")
        XCTAssertEqual(validator.accessCount, 0)
        XCTAssertEqual(secrets.accessCount, 0)
        XCTAssertEqual(captures.accessCount, 0)
    }

    @Test
    func testUnauthorizedCallerWinsOverMalformedAndOversizedInput() async throws {
        let validator = CountingValidator()
        let dispatcher = ProtocolDispatcher(
            authorizer: RejectingAuthorizer(),
            validator: validator,
            secrets: CountingSecretStore(),
            captures: CountingCaptureBackend()
        )

        for bytes in [Data("not-json".utf8), Data(repeating: 0x61, count: 65_537)] {
            let response = await dispatcher.handle(connection: .fixture, bytes: bytes)
            XCTAssertEqual(response.error?.code, "HELPER_UNAUTHORIZED")
        }
        XCTAssertEqual(validator.accessCount, 0)
    }

    @Test
    func testAuthorizedSecretRoundTripUsesExactProtocolEnvelopes() async throws {
        let store = KeychainSecretStore(backend: InMemoryKeychainBackend())
        let dispatcher = ProtocolDispatcher(
            authorizer: AllowingAuthorizer(),
            secrets: store,
            captures: UnavailableScreenCaptureBackend()
        )
        let reference = "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1"

        let set = await dispatcher.handle(
            connection: .fixture,
            bytes: requestBytes(
                id: 7,
                method: "secret.set",
                params: ["reference": reference, "value": "s3cret", "expectedRevision": NSNull()]
            )
        )
        XCTAssertNil(set.error)
        XCTAssertEqual(try object(set.encodedData()), [
            "protocolVersion": 1,
            "id": 7,
            "ok": true,
            "result": ["reference": reference, "revision": 1],
        ] as NSDictionary)

        let get = await dispatcher.handle(
            connection: .fixture,
            bytes: requestBytes(id: 8, method: "secret.get", params: ["reference": reference])
        )
        XCTAssertNil(get.error)
        XCTAssertEqual(try object(get.encodedData()), [
            "protocolVersion": 1,
            "id": 8,
            "ok": true,
            "result": ["reference": reference, "value": "s3cret", "revision": 1],
        ] as NSDictionary)

        let delete = await dispatcher.handle(
            connection: .fixture,
            bytes: requestBytes(
                id: 9,
                method: "secret.delete",
                params: ["reference": reference, "expectedRevision": 1]
            )
        )
        XCTAssertNil(delete.error)
        XCTAssertEqual(try object(delete.encodedData()), [
            "protocolVersion": 1,
            "id": 9,
            "ok": true,
            "result": ["reference": reference, "deleted": true, "revision": 1],
        ] as NSDictionary)
    }

    @Test
    func testAuthorizedInputIsStrictlyBoundedAndMethodValidatedBeforeBackends() async throws {
        let secrets = CountingSecretStore()
        let captures = CountingCaptureBackend()
        let dispatcher = ProtocolDispatcher(
            authorizer: AllowingAuthorizer(),
            secrets: secrets,
            captures: captures
        )

        let oversized = await dispatcher.handle(
            connection: .fixture,
            bytes: Data(repeating: 0x61, count: 65_537)
        )
        XCTAssertEqual(oversized.error?.code, "MESSAGE_TOO_LARGE")

        let unknown = await dispatcher.handle(
            connection: .fixture,
            bytes: requestBytes(id: 2, method: "secret.list", params: [:])
        )
        XCTAssertEqual(unknown.error?.code, "INVALID_REQUEST")

        let forged = await dispatcher.handle(
            connection: .fixture,
            bytes: requestBytes(id: 3, method: "secret.get", params: ["reference": "forged"])
        )
        XCTAssertEqual(forged.error?.code, "INVALID_REFERENCE")
        XCTAssertEqual(secrets.accessCount, 0)
        XCTAssertEqual(captures.accessCount, 0)
    }

    @Test
    func testCapabilitiesExposeOnlySevenBoundedMethods() async throws {
        let dispatcher = ProtocolDispatcher(
            authorizer: AllowingAuthorizer(),
            secrets: CountingSecretStore(),
            captures: UnavailableScreenCaptureBackend()
        )
        let response = await dispatcher.handle(
            connection: .fixture,
            bytes: requestBytes(id: 4, method: "capabilities", params: [:])
        )
        let result = try XCTUnwrap(try object(response.encodedData())["result"] as? NSDictionary)
        XCTAssertEqual(result["platform"] as? String, "macos-arm64")
        XCTAssertEqual(result["secretBackend"] as? String, "keychain")
        XCTAssertEqual(result["captureBackend"] as? String, "screen-capture-kit")
        XCTAssertEqual(result["authenticatedCaller"] as? Bool, true)
        XCTAssertEqual(result["maxMessageBytes"] as? Int, 65_536)
        XCTAssertEqual(result["methods"] as? [String], [
            "capabilities", "secret.get", "secret.set", "secret.delete",
            "window.find", "window.describe", "window.capture",
        ])
    }

    @Test
    func testUnauthorizedIdentifierRequiresOneValidTopLevelJSONId() {
        let cases: [(String, Int)] = [
            (#"{"nested":{"id":88},"id":47}"#, 47),
            (#"{"text":"\"id\":99","id":48}"#, 48),
            (#"{"nested":{"id":49}}"#, 1),
            (#"{"id":50,"id":51}"#, 1),
            (#"{"id":52} trailing"#, 1),
            (#"{"id":{"id":53}}"#, 1),
            (#"{"\u0069d":54}"#, 54),
            (#"{"id":9223372036854775808}"#, 1),
        ]
        for (raw, expected) in cases {
            XCTAssertEqual(boundedRequestIdentifier(Data(raw.utf8)), expected)
        }
    }
}

private func requestBytes(id: Int, method: String, params: [String: Any]) -> Data {
    try! JSONSerialization.data(withJSONObject: [
        "protocolVersion": 1,
        "id": id,
        "method": method,
        "params": params,
    ], options: [.sortedKeys])
}

private func object(_ data: Data) throws -> NSDictionary {
    try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
}

private struct RejectingAuthorizer: CallerAuthorizing {
    func authorize(connection: ConnectionIdentity) throws -> AuthorizedCaller {
        throw HelperFailure.unauthorized
    }
}

private struct AllowingAuthorizer: CallerAuthorizing {
    func authorize(connection: ConnectionIdentity) throws -> AuthorizedCaller {
        AuthorizedCaller(processIdentifier: 42, afterEffectsMajor: 26)
    }
}

private extension ConnectionIdentity {
    static let fixture = ConnectionIdentity(
        processIdentifier: 42,
        effectiveUserIdentifier: 501,
        auditSessionIdentifier: 77,
        processGeneration: ProcessGeneration(seconds: 100, microseconds: 1)
    )
}

private final class CountingValidator: AuthorizedRequestValidating {
    private(set) var accessCount = 0

    func decodeAuthorizedRequest(_ bytes: Data) throws -> ProtocolRequest {
        accessCount += 1
        throw HelperFailure.invalidRequest
    }
}

private final class CountingSecretStore: SecretStoring {
    private(set) var accessCount = 0

    func get(reference: SecretReference) throws -> SecretRecord? {
        accessCount += 1
        return nil
    }

    func set(reference: SecretReference, value: Data, expectedRevision: Int?) throws -> SecretRecord {
        accessCount += 1
        throw HelperFailure.secretStoreUnavailable
    }

    func delete(reference: SecretReference, expectedRevision: Int?) throws -> SecretDeleteResult {
        accessCount += 1
        throw HelperFailure.secretStoreUnavailable
    }
}

private final class CountingCaptureBackend: ScreenCaptureServing {
    private(set) var accessCount = 0

    func find(target: String?) throws -> [WindowDescription] {
        accessCount += 1
        return []
    }

    func describe(reference: String) throws -> WindowDescription {
        accessCount += 1
        throw HelperFailure.helperUnavailable
    }

    func capture(request: WindowCaptureRequest) throws -> CaptureResult {
        accessCount += 1
        throw HelperFailure.helperUnavailable
    }
}
