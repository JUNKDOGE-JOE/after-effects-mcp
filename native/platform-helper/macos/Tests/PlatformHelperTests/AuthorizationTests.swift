import Darwin
import Testing

@testable import PlatformHelperService

@Suite struct AuthorizationTests {
    @Test
    func testAcceptsOnlyAdobeSignedNativeCepDescendantOfSupportedAfterEffects() throws {
        let inspector = FixedCallerInspector(evidence: .valid)
        let authorizer = MacCallerAuthorizer(
            inspector: inspector,
            currentUserIdentifier: 501
        )

        let caller = try authorizer.authorize(connection: .fixture)

        XCTAssertEqual(caller.processIdentifier, 1002)
        XCTAssertEqual(caller.afterEffectsMajor, 26)
        XCTAssertEqual(inspector.accessCount, 1)
    }

    @Test
    func testRejectsEveryIdentityBoundaryIndependently() throws {
        let invalid: [CallerEvidence] = [
            .valid.replacing(processIdentifier: 1003),
            .valid.replacing(effectiveUserIdentifier: 502),
            .valid.replacing(auditSessionIdentifier: 78),
            .valid.replacing(generationBefore: ProcessGeneration(seconds: 99, microseconds: 1)),
            .valid.replacing(generationAfter: ProcessGeneration(seconds: 101, microseconds: 1)),
            .valid.replacing(callerSigningIdentifier: "com.example.attacker"),
            .valid.replacing(callerTeamIdentifier: "ATTACKER01"),
            .valid.replacing(callerSignatureValid: false),
            .valid.replacing(callerArchitecture: .x86_64),
            .valid.replacing(ancestry: []),
            .valid.replacing(afterEffectsBundleIdentifier: "com.example.fake-ae"),
            .valid.replacing(afterEffectsTeamIdentifier: "ATTACKER01"),
            .valid.replacing(afterEffectsSignatureValid: false),
            .valid.replacing(afterEffectsArchitecture: .x86_64),
            .valid.replacing(afterEffectsMajor: 24),
            .valid.replacing(afterEffectsMajor: 27),
        ]

        for evidence in invalid {
            let authorizer = MacCallerAuthorizer(
                inspector: FixedCallerInspector(evidence: evidence),
                currentUserIdentifier: 501
            )
            XCTAssertThrowsError(try authorizer.authorize(connection: .fixture)) { error in
                XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAUTHORIZED")
            }
        }
    }

    @Test
    func testDirectAfterEffectsCallerIsRejectedEvenWhenSignedAndSupported() throws {
        let directAfterEffects = CallerEvidence.valid.replacing(
            callerSigningIdentifier: "com.adobe.AfterEffects.application",
            callerBundleVersionMajor: 26,
            ancestry: []
        )
        let authorizer = MacCallerAuthorizer(
            inspector: FixedCallerInspector(evidence: directAfterEffects),
            currentUserIdentifier: 501
        )

        XCTAssertThrowsError(try authorizer.authorize(connection: .fixture)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAUTHORIZED")
        }
        XCTAssertFalse(MacCallerPolicy.directConnectionRequirement.contains(
            "identifier \"com.adobe.AfterEffects.application\""
        ))
    }

    @Test
    func testPolicyConstantsMatchProductionIdentifiersAndVersions() {
        XCTAssertEqual(MacCallerPolicy.afterEffectsBundleIdentifier, "com.adobe.AfterEffects.application")
        XCTAssertEqual(MacCallerPolicy.cepSigningIdentifier, "com.adobe.cep.CEPHtmlEngine")
        XCTAssertEqual(MacCallerPolicy.adobeTeamIdentifier, "JQ525L2MZD")
        XCTAssertEqual(MacCallerPolicy.supportedAfterEffectsMajors, [25, 26])
        XCTAssertEqual(MacCallerPolicy.requiredArchitecture, .arm64)
    }

    @Test
    func testInspectorRejectsAnyAncestorSnapshotSwapAroundSecurityInspection() throws {
        let caller = ProcessSnapshot(
            processIdentifier: 1002,
            parentProcessIdentifier: 1001,
            userIdentifier: 501,
            generation: ProcessGeneration(seconds: 100, microseconds: 1),
            architecture: .arm64
        )
        let ancestor = ProcessSnapshot(
            processIdentifier: 1001,
            parentProcessIdentifier: 1,
            userIdentifier: 501,
            generation: ProcessGeneration(seconds: 90, microseconds: 2),
            architecture: .arm64
        )
        let swappedAncestors = [
            ProcessSnapshot(
                processIdentifier: 999,
                parentProcessIdentifier: 1,
                userIdentifier: 501,
                generation: ancestor.generation,
                architecture: .arm64
            ),
            ProcessSnapshot(
                processIdentifier: 1001,
                parentProcessIdentifier: 777,
                userIdentifier: 501,
                generation: ancestor.generation,
                architecture: .arm64
            ),
            ProcessSnapshot(
                processIdentifier: 1001,
                parentProcessIdentifier: 1,
                userIdentifier: 502,
                generation: ancestor.generation,
                architecture: .arm64
            ),
            ProcessSnapshot(
                processIdentifier: 1001,
                parentProcessIdentifier: 1,
                userIdentifier: 501,
                generation: ProcessGeneration(seconds: 91, microseconds: 2),
                architecture: .arm64
            ),
            ProcessSnapshot(
                processIdentifier: 1001,
                parentProcessIdentifier: 1,
                userIdentifier: 501,
                generation: ancestor.generation,
                architecture: .x86_64
            ),
        ]

        for swapped in swappedAncestors {
            let reader = SequencedProcessSnapshotReader(sequences: [
                1002: [caller, caller],
                1001: [ancestor, swapped],
            ])
            let inspector = SecurityFrameworkCallerInspector(
                snapshotReader: reader,
                signedProcessInspector: FixtureSignedProcessInspector()
            )
            XCTAssertThrowsError(try inspector.inspect(connection: .fixture)) { error in
                XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAUTHORIZED")
            }
        }
    }

    @Test
    func testInspectorRevalidatesTheWholeChainAfterEveryLocalSecurityCheck() throws {
        let caller = ProcessSnapshot(
            processIdentifier: 1002,
            parentProcessIdentifier: 1001,
            userIdentifier: 501,
            generation: ProcessGeneration(seconds: 100, microseconds: 1),
            architecture: .arm64
        )
        let reparentedCaller = ProcessSnapshot(
            processIdentifier: 1002,
            parentProcessIdentifier: 1,
            userIdentifier: 501,
            generation: caller.generation,
            architecture: .arm64
        )
        let ancestor = ProcessSnapshot(
            processIdentifier: 1001,
            parentProcessIdentifier: 1,
            userIdentifier: 501,
            generation: ProcessGeneration(seconds: 90, microseconds: 2),
            architecture: .arm64
        )
        let inspector = SecurityFrameworkCallerInspector(
            snapshotReader: SequencedProcessSnapshotReader(sequences: [
                1002: [caller, caller, reparentedCaller],
                1001: [ancestor, ancestor, ancestor],
            ]),
            signedProcessInspector: FixtureSignedProcessInspector()
        )

        XCTAssertThrowsError(try inspector.inspect(connection: .fixture)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "HELPER_UNAUTHORIZED")
        }
    }
}

private final class FixedCallerInspector: CallerIdentityInspecting {
    let evidence: CallerEvidence
    private(set) var accessCount = 0

    init(evidence: CallerEvidence) {
        self.evidence = evidence
    }

    func inspect(connection: ConnectionIdentity) throws -> CallerEvidence {
        accessCount += 1
        return evidence
    }
}

private final class SequencedProcessSnapshotReader: ProcessSnapshotReading {
    private var sequences: [pid_t: [ProcessSnapshot]]

    init(sequences: [pid_t: [ProcessSnapshot]]) {
        self.sequences = sequences
    }

    func snapshot(processIdentifier: pid_t) throws -> ProcessSnapshot {
        guard var sequence = sequences[processIdentifier], !sequence.isEmpty else {
            throw HelperFailure.unauthorized
        }
        let next = sequence.removeFirst()
        sequences[processIdentifier] = sequence
        return next
    }
}

private struct FixtureSignedProcessInspector: SignedProcessInspecting {
    func inspect(snapshot: ProcessSnapshot) throws -> SignedProcessIdentity {
        SignedProcessIdentity(
            processIdentifier: snapshot.processIdentifier,
            parentProcessIdentifier: snapshot.parentProcessIdentifier,
            signingIdentifier: snapshot.processIdentifier == 1002
                ? MacCallerPolicy.cepSigningIdentifier
                : MacCallerPolicy.afterEffectsBundleIdentifier,
            teamIdentifier: MacCallerPolicy.adobeTeamIdentifier,
            bundleVersionMajor: snapshot.processIdentifier == 1002 ? nil : 26,
            architecture: snapshot.architecture,
            signatureValid: true
        )
    }
}

private extension CallerEvidence {
    static let valid = CallerEvidence(
        processIdentifier: 1002,
        effectiveUserIdentifier: 501,
        auditSessionIdentifier: 77,
        generationBefore: ProcessGeneration(seconds: 100, microseconds: 1),
        generationAfter: ProcessGeneration(seconds: 100, microseconds: 1),
        caller: SignedProcessIdentity(
            processIdentifier: 1002,
            parentProcessIdentifier: 1001,
            signingIdentifier: "com.adobe.cep.CEPHtmlEngine",
            teamIdentifier: "JQ525L2MZD",
            bundleVersionMajor: nil,
            architecture: .arm64,
            signatureValid: true
        ),
        ancestry: [
            SignedProcessIdentity(
                processIdentifier: 1001,
                parentProcessIdentifier: 1,
                signingIdentifier: "com.adobe.AfterEffects.application",
                teamIdentifier: "JQ525L2MZD",
                bundleVersionMajor: 26,
                architecture: .arm64,
                signatureValid: true
            ),
        ]
    )

    func replacing(
        processIdentifier: pid_t? = nil,
        effectiveUserIdentifier: uid_t? = nil,
        auditSessionIdentifier: au_asid_t? = nil,
        generationBefore: ProcessGeneration? = nil,
        generationAfter: ProcessGeneration? = nil,
        callerSigningIdentifier: String? = nil,
        callerBundleVersionMajor: Int? = nil,
        callerTeamIdentifier: String? = nil,
        callerSignatureValid: Bool? = nil,
        callerArchitecture: NativeArchitecture? = nil,
        ancestry: [SignedProcessIdentity]? = nil,
        afterEffectsBundleIdentifier: String? = nil,
        afterEffectsTeamIdentifier: String? = nil,
        afterEffectsSignatureValid: Bool? = nil,
        afterEffectsArchitecture: NativeArchitecture? = nil,
        afterEffectsMajor: Int? = nil
    ) -> CallerEvidence {
        var nextCaller = caller
        nextCaller = SignedProcessIdentity(
            processIdentifier: nextCaller.processIdentifier,
            parentProcessIdentifier: nextCaller.parentProcessIdentifier,
            signingIdentifier: callerSigningIdentifier ?? nextCaller.signingIdentifier,
            teamIdentifier: callerTeamIdentifier ?? nextCaller.teamIdentifier,
            bundleVersionMajor: callerBundleVersionMajor ?? nextCaller.bundleVersionMajor,
            architecture: callerArchitecture ?? nextCaller.architecture,
            signatureValid: callerSignatureValid ?? nextCaller.signatureValid
        )
        var nextAncestry = ancestry ?? self.ancestry
        if !nextAncestry.isEmpty {
            let ae = nextAncestry[0]
            nextAncestry[0] = SignedProcessIdentity(
                processIdentifier: ae.processIdentifier,
                parentProcessIdentifier: ae.parentProcessIdentifier,
                signingIdentifier: afterEffectsBundleIdentifier ?? ae.signingIdentifier,
                teamIdentifier: afterEffectsTeamIdentifier ?? ae.teamIdentifier,
                bundleVersionMajor: afterEffectsMajor ?? ae.bundleVersionMajor,
                architecture: afterEffectsArchitecture ?? ae.architecture,
                signatureValid: afterEffectsSignatureValid ?? ae.signatureValid
            )
        }
        return CallerEvidence(
            processIdentifier: processIdentifier ?? self.processIdentifier,
            effectiveUserIdentifier: effectiveUserIdentifier ?? self.effectiveUserIdentifier,
            auditSessionIdentifier: auditSessionIdentifier ?? self.auditSessionIdentifier,
            generationBefore: generationBefore ?? self.generationBefore,
            generationAfter: generationAfter ?? self.generationAfter,
            caller: nextCaller,
            ancestry: nextAncestry
        )
    }
}

private extension ConnectionIdentity {
    static let fixture = ConnectionIdentity(
        processIdentifier: 1002,
        effectiveUserIdentifier: 501,
        auditSessionIdentifier: 77,
        processGeneration: ProcessGeneration(seconds: 100, microseconds: 1)
    )
}
