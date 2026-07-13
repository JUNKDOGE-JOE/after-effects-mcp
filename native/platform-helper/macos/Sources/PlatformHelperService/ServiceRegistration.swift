import Dispatch
import Foundation

@objc(AEMCPPlatformHelperXPC)
protocol PlatformHelperXPCProtocol {
    @objc(requestJSON:withReply:)
    func requestJSON(
        _ request: NSData,
        withReply reply: @escaping (NSData?, NSError?) -> Void
    )
}

private struct PinnedConnectionAuthorizer: CallerAuthorizing {
    let identity: ConnectionIdentity
    let caller: AuthorizedCaller

    func authorize(connection: ConnectionIdentity) throws -> AuthorizedCaller {
        guard connection == identity else { throw HelperFailure.unauthorized }
        return caller
    }
}

final class AuthorizedBackendRegistry {
    private let lock = NSLock()
    private let secretStoreFactory: () -> SecretStoring
    private var retainedSecretStore: SecretStoring?

    init(secretStoreFactory: @escaping () -> SecretStoring = { KeychainSecretStore() }) {
        self.secretStoreFactory = secretStoreFactory
    }

    func secretStore() -> SecretStoring {
        lock.lock()
        defer { lock.unlock() }
        if let retainedSecretStore { return retainedSecretStore }
        let created = secretStoreFactory()
        retainedSecretStore = created
        return created
    }
}

private final class AuthorizedPlatformHelperExport: NSObject, PlatformHelperXPCProtocol {
    private let identity: ConnectionIdentity
    private let dispatcher: ProtocolDispatcher

    init(identity: ConnectionIdentity, caller: AuthorizedCaller, secrets: SecretStoring) {
        self.identity = identity
        dispatcher = ProtocolDispatcher(
            authorizer: PinnedConnectionAuthorizer(identity: identity, caller: caller),
            secrets: secrets,
            captures: UnavailableScreenCaptureBackend()
        )
        super.init()
    }

    func requestJSON(
        _ request: NSData,
        withReply reply: @escaping (NSData?, NSError?) -> Void
    ) {
        let bytes = request as Data
        Task {
            let response = await dispatcher.handle(connection: identity, bytes: bytes)
            do {
                let encoded = try response.encodedData()
                guard encoded.count <= platformHelperMaximumMessageBytes else {
                    reply(nil, serviceError("response exceeds the protocol limit"))
                    return
                }
                reply(encoded as NSData, nil)
            } catch {
                reply(nil, serviceError("response encoding failed"))
            }
        }
    }
}

private final class RejectionOnlyPlatformHelperExport: NSObject, PlatformHelperXPCProtocol {
    func requestJSON(
        _ request: NSData,
        withReply reply: @escaping (NSData?, NSError?) -> Void
    ) {
        let bytes = request as Data
        let response = ProtocolResponse.failure(
            id: boundedRequestIdentifier(bytes),
            .unauthorized
        )
        do {
            reply(try response.encodedData() as NSData, nil)
        } catch {
            reply(nil, serviceError("rejection encoding failed"))
        }
    }
}

final class PlatformHelperListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let authorizer: CallerAuthorizing
    private let backendRegistry: AuthorizedBackendRegistry

    init(
        authorizer: CallerAuthorizing = MacCallerAuthorizer(),
        backendRegistry: AuthorizedBackendRegistry = AuthorizedBackendRegistry()
    ) {
        self.authorizer = authorizer
        self.backendRegistry = backendRegistry
    }

    func listener(
        _ listener: NSXPCListener,
        shouldAcceptNewConnection connection: NSXPCConnection
    ) -> Bool {
        let exportedObject: PlatformHelperXPCProtocol
        do {
            let identity = try connectionIdentity(connection)
            let caller = try authorizer.authorize(connection: identity)

            // This public macOS 13+ API gives the authorized branch an OS-enforced
            // direct-peer requirement in addition to the generation/ancestry checks.
            connection.setCodeSigningRequirement(MacCallerPolicy.directConnectionRequirement)
            exportedObject = AuthorizedPlatformHelperExport(
                identity: identity,
                caller: caller,
                secrets: backendRegistry.secretStore()
            )
        } catch {
            // Rejected peers receive only a bounded rejection envelope. No request
            // validator, Keychain object, or capture backend exists on this branch.
            exportedObject = RejectionOnlyPlatformHelperExport()
        }

        connection.exportedInterface = NSXPCInterface(with: PlatformHelperXPCProtocol.self)
        connection.exportedObject = exportedObject
        connection.activate()
        return true
    }

    private func connectionIdentity(_ connection: NSXPCConnection) throws -> ConnectionIdentity {
        let processIdentifier = connection.processIdentifier
        let snapshot = try ProcessInspection().snapshot(processIdentifier: processIdentifier)
        guard snapshot.userIdentifier == connection.effectiveUserIdentifier else {
            throw HelperFailure.unauthorized
        }
        return ConnectionIdentity(
            processIdentifier: processIdentifier,
            effectiveUserIdentifier: connection.effectiveUserIdentifier,
            auditSessionIdentifier: connection.auditSessionIdentifier,
            processGeneration: snapshot.generation
        )
    }
}

enum PlatformHelperServiceMain {
    static let machServiceName = "com.junkdoge.ae-mcp.platform-helper"
    private static var retainedDelegate: PlatformHelperListenerDelegate?

    static func run() -> Never {
        let listener = NSXPCListener(machServiceName: machServiceName)
        let delegate = PlatformHelperListenerDelegate()
        retainedDelegate = delegate
        listener.delegate = delegate
        listener.activate()
        dispatchMain()
    }
}

private func serviceError(_ description: String) -> NSError {
    NSError(
        domain: "com.junkdoge.ae-mcp.platform-helper",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: description]
    )
}
