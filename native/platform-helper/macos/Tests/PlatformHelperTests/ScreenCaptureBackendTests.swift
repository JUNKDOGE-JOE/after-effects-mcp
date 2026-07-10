import Foundation
import Testing

@testable import PlatformHelperService

@Suite struct ScreenCaptureBackendTests {
    @Test
    func testTaskFourProductionCaptureBackendIsExplicitlyUnavailable() throws {
        let backend = UnavailableScreenCaptureBackend()

        XCTAssertThrowsError(try backend.find(target: "after-effects-main")) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAVAILABLE")
        }
        XCTAssertThrowsError(try backend.describe(reference: "ae-window://main/42")) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAVAILABLE")
        }
        XCTAssertThrowsError(try backend.capture(request: WindowCaptureRequest(
            reference: "ae-window://main/42",
            target: nil,
            captureId: "capture-1",
            method: "auto"
        ))) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAVAILABLE")
        }
    }

    @Test
    func testAuthorizedWindowRequestReachesOnlyInjectedBackend() async throws {
        let backend = RecordingUnavailableCaptureBackend()
        let dispatcher = ProtocolDispatcher(
            authorizer: CaptureAllowingAuthorizer(),
            secrets: InMemorySecretStore(),
            captures: backend
        )
        let bytes = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "id": 5,
            "method": "window.find",
            "params": ["target": "after-effects-main"],
        ])

        let response = await dispatcher.handle(connection: .fixture, bytes: bytes)

        XCTAssertEqual(response.error?.code, "HELPER_UNAVAILABLE")
        XCTAssertEqual(backend.accessCount, 1)
    }
}

private struct CaptureAllowingAuthorizer: CallerAuthorizing {
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

private final class RecordingUnavailableCaptureBackend: ScreenCaptureServing {
    private(set) var accessCount = 0

    func find(target: String?) throws -> [WindowDescription] {
        accessCount += 1
        throw HelperFailure.helperUnavailable
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

private final class InMemorySecretStore: SecretStoring {
    func get(reference: SecretReference) throws -> SecretRecord? { nil }

    func set(reference: SecretReference, value: Data, expectedRevision: Int?) throws -> SecretRecord {
        SecretRecord(reference: reference, value: value, revision: 1)
    }

    func delete(reference: SecretReference, expectedRevision: Int?) throws -> SecretDeleteResult {
        SecretDeleteResult(reference: reference, deleted: false, revision: nil)
    }
}
