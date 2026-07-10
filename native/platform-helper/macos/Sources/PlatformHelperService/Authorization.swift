import Darwin
import Foundation
import Security

enum NativeArchitecture: String, Equatable {
    case arm64
    case x86_64
    case unsupported
}

enum MacCallerPolicy {
    static let afterEffectsBundleIdentifier = "com.adobe.AfterEffects.application"
    static let cepSigningIdentifier = "com.adobe.cep.CEPHtmlEngine"
    static let adobeTeamIdentifier = "JQ525L2MZD"
    static let supportedAfterEffectsMajors = [25, 26]
    static let requiredArchitecture = NativeArchitecture.arm64
    static let maximumAncestryDepth = 32

    static let adobeTrustRequirement =
        #"anchor apple generic and certificate leaf[subject.OU] = "JQ525L2MZD""#

    static let directConnectionRequirement =
        #"anchor apple generic and certificate leaf[subject.OU] = "JQ525L2MZD" and identifier "com.adobe.cep.CEPHtmlEngine""#
}

struct SignedProcessIdentity: Equatable {
    let processIdentifier: pid_t
    let parentProcessIdentifier: pid_t
    let signingIdentifier: String
    let teamIdentifier: String
    let bundleVersionMajor: Int?
    let architecture: NativeArchitecture
    let signatureValid: Bool
}

struct CallerEvidence: Equatable {
    let processIdentifier: pid_t
    let effectiveUserIdentifier: uid_t
    let auditSessionIdentifier: au_asid_t
    let generationBefore: ProcessGeneration
    let generationAfter: ProcessGeneration
    let caller: SignedProcessIdentity
    let ancestry: [SignedProcessIdentity]
}

protocol CallerIdentityInspecting {
    func inspect(connection: ConnectionIdentity) throws -> CallerEvidence
}

struct MacCallerAuthorizer: CallerAuthorizing {
    private let inspector: CallerIdentityInspecting
    private let currentUserIdentifier: uid_t

    init(
        inspector: CallerIdentityInspecting = SecurityFrameworkCallerInspector(),
        currentUserIdentifier: uid_t = getuid()
    ) {
        self.inspector = inspector
        self.currentUserIdentifier = currentUserIdentifier
    }

    func authorize(connection: ConnectionIdentity) throws -> AuthorizedCaller {
        guard connection.processIdentifier > 1,
              connection.effectiveUserIdentifier == currentUserIdentifier,
              connection.auditSessionIdentifier > 0
        else {
            throw HelperFailure.unauthorized
        }

        let evidence: CallerEvidence
        do {
            evidence = try inspector.inspect(connection: connection)
        } catch {
            throw HelperFailure.unauthorized
        }
        guard evidence.processIdentifier == connection.processIdentifier,
              evidence.effectiveUserIdentifier == connection.effectiveUserIdentifier,
              evidence.auditSessionIdentifier == connection.auditSessionIdentifier,
              evidence.generationBefore == connection.processGeneration,
              evidence.generationAfter == connection.processGeneration,
              trustedAdobeProcess(evidence.caller),
              evidence.caller.signingIdentifier == MacCallerPolicy.cepSigningIdentifier
        else {
            throw HelperFailure.unauthorized
        }

        guard let aeIndex = evidence.ancestry.firstIndex(where: {
            $0.signingIdentifier == MacCallerPolicy.afterEffectsBundleIdentifier
        }) else {
            throw HelperFailure.unauthorized
        }
        let pathToAfterEffects = evidence.ancestry[...aeIndex]
        guard pathToAfterEffects.allSatisfy(trustedAdobeProcess),
              let major = pathToAfterEffects.last?.bundleVersionMajor,
              MacCallerPolicy.supportedAfterEffectsMajors.contains(major)
        else {
            throw HelperFailure.unauthorized
        }
        return AuthorizedCaller(
            processIdentifier: connection.processIdentifier,
            afterEffectsMajor: major
        )
    }

    private func trustedAdobeProcess(_ process: SignedProcessIdentity) -> Bool {
        process.signatureValid
            && process.teamIdentifier == MacCallerPolicy.adobeTeamIdentifier
            && process.architecture == MacCallerPolicy.requiredArchitecture
    }
}

protocol ProcessSnapshotReading {
    func snapshot(processIdentifier: pid_t) throws -> ProcessSnapshot
}

protocol SignedProcessInspecting {
    func inspect(snapshot: ProcessSnapshot) throws -> SignedProcessIdentity
}

struct SecurityFrameworkCallerInspector: CallerIdentityInspecting {
    private let snapshotReader: ProcessSnapshotReading
    private let signedProcessInspector: SignedProcessInspecting

    init(
        snapshotReader: ProcessSnapshotReading = ProcessInspection(),
        signedProcessInspector: SignedProcessInspecting = SecurityFrameworkSignedProcessInspector()
    ) {
        self.snapshotReader = snapshotReader
        self.signedProcessInspector = signedProcessInspector
    }

    func inspect(connection: ConnectionIdentity) throws -> CallerEvidence {
        let (initial, final, caller) = try stableSignedIdentity(
            processIdentifier: connection.processIdentifier
        )
        guard initial.generation == connection.processGeneration,
              final.generation == connection.processGeneration,
              initial.userIdentifier == connection.effectiveUserIdentifier,
              connection.auditSessionIdentifier > 0
        else {
            throw HelperFailure.unauthorized
        }

        var ancestry: [SignedProcessIdentity] = []
        var validatedSnapshots = [initial]
        var seen = Set<pid_t>([connection.processIdentifier])
        var parent = initial.parentProcessIdentifier
        while parent > 1 && ancestry.count < MacCallerPolicy.maximumAncestryDepth {
            guard seen.insert(parent).inserted else { throw HelperFailure.unauthorized }
            let (snapshot, _, identity) = try stableSignedIdentity(processIdentifier: parent)
            guard snapshot.userIdentifier == connection.effectiveUserIdentifier else {
                throw HelperFailure.unauthorized
            }
            validatedSnapshots.append(snapshot)
            ancestry.append(identity)
            if identity.signingIdentifier == MacCallerPolicy.afterEffectsBundleIdentifier {
                break
            }
            parent = snapshot.parentProcessIdentifier
        }

        var finalSnapshots: [ProcessSnapshot] = []
        for expected in validatedSnapshots {
            let revalidated = try snapshotReader.snapshot(
                processIdentifier: expected.processIdentifier
            )
            guard revalidated == expected else { throw HelperFailure.unauthorized }
            finalSnapshots.append(revalidated)
        }
        guard let revalidatedCaller = finalSnapshots.first else {
            throw HelperFailure.unauthorized
        }

        return CallerEvidence(
            processIdentifier: connection.processIdentifier,
            effectiveUserIdentifier: initial.userIdentifier,
            auditSessionIdentifier: connection.auditSessionIdentifier,
            generationBefore: initial.generation,
            generationAfter: revalidatedCaller.generation,
            caller: caller,
            ancestry: ancestry
        )
    }

    private func stableSignedIdentity(
        processIdentifier: pid_t
    ) throws -> (ProcessSnapshot, ProcessSnapshot, SignedProcessIdentity) {
        let before = try snapshotReader.snapshot(processIdentifier: processIdentifier)
        guard before.processIdentifier == processIdentifier else {
            throw HelperFailure.unauthorized
        }
        let identity = try signedProcessInspector.inspect(snapshot: before)
        let after = try snapshotReader.snapshot(processIdentifier: processIdentifier)
        guard before == after,
              identity.processIdentifier == before.processIdentifier,
              identity.parentProcessIdentifier == before.parentProcessIdentifier,
              identity.architecture == before.architecture
        else {
            throw HelperFailure.unauthorized
        }
        return (before, after, identity)
    }
}

struct SecurityFrameworkSignedProcessInspector: SignedProcessInspecting {
    func inspect(snapshot: ProcessSnapshot) throws -> SignedProcessIdentity {
        var dynamicCode: SecCode?
        let attributes = [
            kSecGuestAttributePid as String: NSNumber(value: snapshot.processIdentifier),
        ] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(
            nil,
            attributes,
            SecCSFlags(rawValue: 0),
            &dynamicCode
        ) == errSecSuccess, let dynamicCode else {
            throw HelperFailure.unauthorized
        }

        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(
            MacCallerPolicy.adobeTrustRequirement as CFString,
            SecCSFlags(rawValue: 0),
            &requirement
        ) == errSecSuccess, let requirement else {
            throw HelperFailure.unauthorized
        }
        let signatureValid = SecCodeCheckValidity(
            dynamicCode,
            SecCSFlags(rawValue: 1 << 4),
            requirement
        ) == errSecSuccess

        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(
            dynamicCode,
            SecCSFlags(rawValue: 0),
            &staticCode
        ) == errSecSuccess, let staticCode else {
            throw HelperFailure.unauthorized
        }
        var signingInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: (1 << 1) | (1 << 4)),
            &signingInformation
        ) == errSecSuccess,
              let information = signingInformation as? [String: Any],
              let signingIdentifier = information[kSecCodeInfoIdentifier as String] as? String,
              let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String
        else {
            throw HelperFailure.unauthorized
        }
        let plist = information[kSecCodeInfoPList as String] as? [String: Any]
        return SignedProcessIdentity(
            processIdentifier: snapshot.processIdentifier,
            parentProcessIdentifier: snapshot.parentProcessIdentifier,
            signingIdentifier: signingIdentifier,
            teamIdentifier: teamIdentifier,
            bundleVersionMajor: bundleVersionMajor(plist),
            architecture: snapshot.architecture,
            signatureValid: signatureValid
        )
    }

    private func bundleVersionMajor(_ plist: [String: Any]?) -> Int? {
        for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
            guard let version = plist?[key] as? String,
                  let first = version.split(separator: ".", maxSplits: 1).first,
                  let major = Int(first)
            else {
                continue
            }
            return major
        }
        return nil
    }
}

struct ProcessSnapshot: Equatable {
    let processIdentifier: pid_t
    let parentProcessIdentifier: pid_t
    let userIdentifier: uid_t
    let generation: ProcessGeneration
    let architecture: NativeArchitecture
}

struct ProcessInspection: ProcessSnapshotReading {
    func snapshot(processIdentifier: pid_t) throws -> ProcessSnapshot {
        var identifiers: [Int32] = [
            CTL_KERN,
            KERN_PROC,
            KERN_PROC_PID,
            processIdentifier,
        ]
        var info = kinfo_proc()
        var byteCount = MemoryLayout<kinfo_proc>.size
        guard sysctl(
            &identifiers,
            u_int(identifiers.count),
            &info,
            &byteCount,
            nil,
            0
        ) == 0,
              byteCount == MemoryLayout<kinfo_proc>.size,
              info.kp_proc.p_pid == processIdentifier,
              info.kp_proc.p_un.__p_starttime.tv_sec >= 0,
              info.kp_proc.p_un.__p_starttime.tv_usec >= 0
        else {
            throw HelperFailure.unauthorized
        }
#if arch(arm64)
        let architecture: NativeArchitecture = (info.kp_proc.p_flag & P_TRANSLATED) == 0
            ? .arm64
            : .x86_64
#else
        let architecture = NativeArchitecture.unsupported
#endif
        return ProcessSnapshot(
            processIdentifier: processIdentifier,
            parentProcessIdentifier: info.kp_eproc.e_ppid,
            userIdentifier: info.kp_eproc.e_ucred.cr_uid,
            generation: ProcessGeneration(
                seconds: UInt64(info.kp_proc.p_un.__p_starttime.tv_sec),
                microseconds: UInt64(info.kp_proc.p_un.__p_starttime.tv_usec)
            ),
            architecture: architecture
        )
    }
}
