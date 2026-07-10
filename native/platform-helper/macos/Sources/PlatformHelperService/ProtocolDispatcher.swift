import Darwin
import Foundation

let platformHelperProtocolVersion = 1
let platformHelperMaximumMessageBytes = 65_536
let platformHelperMethods = [
    "capabilities",
    "secret.get",
    "secret.set",
    "secret.delete",
    "window.find",
    "window.describe",
    "window.capture",
]

struct ProcessGeneration: Equatable {
    let seconds: UInt64
    let microseconds: UInt64
}

struct ConnectionIdentity: Equatable {
    let processIdentifier: pid_t
    let effectiveUserIdentifier: uid_t
    let auditSessionIdentifier: au_asid_t
    let processGeneration: ProcessGeneration
}

struct AuthorizedCaller: Equatable {
    let processIdentifier: pid_t
    let afterEffectsMajor: Int
}

protocol CallerAuthorizing {
    func authorize(connection: ConnectionIdentity) throws -> AuthorizedCaller
}

struct ProtocolError: Equatable {
    let code: String
    let message: String
    let retryable: Bool
}

struct HelperFailure: Error, Equatable, CustomStringConvertible {
    let code: String
    let safeMessage: String
    let retryable: Bool

    var description: String { "\(code): \(safeMessage)" }

    static let unauthorized = HelperFailure(
        code: "HELPER_UNAUTHORIZED",
        safeMessage: "caller is not authorized; backendAccessCount=0",
        retryable: false
    )
    static let helperUnavailable = HelperFailure(
        code: "HELPER_UNAVAILABLE",
        safeMessage: "platform helper capability is unavailable",
        retryable: true
    )
    static let protocolVersionUnsupported = HelperFailure(
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        safeMessage: "platform helper protocol version is unsupported",
        retryable: false
    )
    static let invalidRequest = HelperFailure(
        code: "INVALID_REQUEST",
        safeMessage: "platform helper request is invalid",
        retryable: false
    )
    static let invalidReference = HelperFailure(
        code: "INVALID_REFERENCE",
        safeMessage: "secret reference is invalid",
        retryable: false
    )
    static let messageTooLarge = HelperFailure(
        code: "MESSAGE_TOO_LARGE",
        safeMessage: "platform helper message exceeds 65536 bytes",
        retryable: false
    )
    static let secretNotFound = HelperFailure(
        code: "SECRET_NOT_FOUND",
        safeMessage: "secret was not found",
        retryable: false
    )
    static let secretConflict = HelperFailure(
        code: "SECRET_CONFLICT",
        safeMessage: "secret revision does not match",
        retryable: false
    )
    static let secretStoreUnavailable = HelperFailure(
        code: "SECRET_STORE_UNAVAILABLE",
        safeMessage: "credential store is unavailable",
        retryable: true
    )
    static let secretStoreStateUncertain = HelperFailure(
        code: "SECRET_STORE_UNAVAILABLE",
        safeMessage: "credential store state is uncertain; manual verification is required",
        retryable: false
    )

    var protocolError: ProtocolError {
        ProtocolError(code: code, message: safeMessage, retryable: retryable)
    }
}

struct ProtocolResponse {
    let id: Int
    let result: Any?
    let error: ProtocolError?

    static func success(id: Int, result: Any) -> ProtocolResponse {
        ProtocolResponse(id: id, result: result, error: nil)
    }

    static func failure(id: Int, _ failure: HelperFailure) -> ProtocolResponse {
        ProtocolResponse(id: max(1, id), result: nil, error: failure.protocolError)
    }

    func encodedData() throws -> Data {
        let object: [String: Any]
        if let error {
            object = [
                "protocolVersion": platformHelperProtocolVersion,
                "id": id,
                "ok": false,
                "error": [
                    "code": error.code,
                    "message": error.message,
                    "retryable": error.retryable,
                ],
            ]
        } else {
            object = [
                "protocolVersion": platformHelperProtocolVersion,
                "id": id,
                "ok": true,
                "result": result ?? NSNull(),
            ]
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

struct ProtocolRequest {
    let id: Int
    let method: String
    let params: [String: Any]
}

protocol AuthorizedRequestValidating {
    func decodeAuthorizedRequest(_ bytes: Data) throws -> ProtocolRequest
}

private struct RequestDecodeFailure: Error {
    let id: Int
    let failure: HelperFailure
}

struct ProtocolRequestValidator: AuthorizedRequestValidating {
    func decodeAuthorizedRequest(_ bytes: Data) throws -> ProtocolRequest {
        guard bytes.count <= platformHelperMaximumMessageBytes else {
            throw RequestDecodeFailure(id: 1, failure: .messageTooLarge)
        }
        let object: [String: Any]
        do {
            guard let decoded = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                throw HelperFailure.invalidRequest
            }
            object = decoded
        } catch let failure as HelperFailure {
            throw RequestDecodeFailure(id: 1, failure: failure)
        } catch {
            throw RequestDecodeFailure(id: 1, failure: .invalidRequest)
        }

        let id = positiveInteger(object["id"]) ?? 1
        do {
            guard exactKeys(object, ["protocolVersion", "id", "method", "params"]),
                  positiveInteger(object["id"]) != nil,
                  let method = object["method"] as? String,
                  platformHelperMethods.contains(method),
                  let params = object["params"] as? [String: Any]
            else {
                throw HelperFailure.invalidRequest
            }
            guard integer(object["protocolVersion"]) == platformHelperProtocolVersion else {
                throw HelperFailure.protocolVersionUnsupported
            }
            try validate(method: method, params: params)
            return ProtocolRequest(id: id, method: method, params: params)
        } catch let failure as HelperFailure {
            throw RequestDecodeFailure(id: id, failure: failure)
        } catch {
            throw RequestDecodeFailure(id: id, failure: .invalidRequest)
        }
    }

    private func validate(method: String, params: [String: Any]) throws {
        switch method {
        case "capabilities":
            guard params.isEmpty else { throw HelperFailure.invalidRequest }
        case "secret.get":
            guard exactKeys(params, ["reference"]), let raw = params["reference"] as? String else {
                throw HelperFailure.invalidRequest
            }
            _ = try SecretReference(raw)
        case "secret.set":
            guard exactKeys(params, ["reference", "value", "expectedRevision"]),
                  let raw = params["reference"] as? String,
                  params["value"] is String,
                  params["expectedRevision"] is NSNull
                    || positiveInteger(params["expectedRevision"]) != nil
            else {
                throw HelperFailure.invalidRequest
            }
            _ = try SecretReference(raw)
        case "secret.delete":
            let keys = Set(params.keys)
            guard keys == ["reference"] || keys == ["reference", "expectedRevision"],
                  let raw = params["reference"] as? String,
                  params["expectedRevision"] == nil
                    || positiveInteger(params["expectedRevision"]) != nil
            else {
                throw HelperFailure.invalidRequest
            }
            _ = try SecretReference(raw)
        case "window.find":
            guard params.isEmpty || exactKeys(params, ["target"]),
                  params["target"] == nil || params["target"] as? String == "after-effects-main"
            else {
                throw HelperFailure.invalidRequest
            }
        case "window.describe":
            guard exactKeys(params, ["reference"]),
                  let reference = params["reference"] as? String,
                  !reference.isEmpty
            else {
                throw HelperFailure.invalidRequest
            }
        case "window.capture":
            let allowed = Set(["reference", "target", "captureId", "method"])
            let keys = Set(params.keys)
            guard keys.isSubset(of: allowed),
                  let captureID = params["captureId"] as? String,
                  !captureID.isEmpty,
                  (params["reference"] != nil || params["target"] != nil),
                  params["reference"] == nil
                    || ((params["reference"] as? String)?.isEmpty == false),
                  params["target"] == nil || params["target"] as? String == "after-effects-main",
                  params["method"] == nil
                    || ["auto", "DesktopCopy", "PrintWindow"].contains(params["method"] as? String)
            else {
                throw HelperFailure.invalidRequest
            }
        default:
            throw HelperFailure.invalidRequest
        }
    }
}

final class ProtocolDispatcher {
    private let authorizer: CallerAuthorizing
    private let validator: AuthorizedRequestValidating
    private let secrets: SecretStoring
    private let captures: ScreenCaptureServing

    init(
        authorizer: CallerAuthorizing,
        validator: AuthorizedRequestValidating = ProtocolRequestValidator(),
        secrets: SecretStoring,
        captures: ScreenCaptureServing
    ) {
        self.authorizer = authorizer
        self.validator = validator
        self.secrets = secrets
        self.captures = captures
    }

    func handle(connection: ConnectionIdentity, bytes: Data) async -> ProtocolResponse {
        do {
            _ = try authorizer.authorize(connection: connection)
        } catch {
            return .failure(id: boundedRequestIdentifier(bytes), .unauthorized)
        }

        let request: ProtocolRequest
        do {
            request = try validator.decodeAuthorizedRequest(bytes)
        } catch let decode as RequestDecodeFailure {
            return .failure(id: decode.id, decode.failure)
        } catch let failure as HelperFailure {
            return .failure(id: 1, failure)
        } catch {
            return .failure(id: 1, .invalidRequest)
        }

        do {
            return try dispatch(request)
        } catch let failure as HelperFailure {
            return .failure(id: request.id, failure)
        } catch {
            return .failure(id: request.id, .helperUnavailable)
        }
    }

    private func dispatch(_ request: ProtocolRequest) throws -> ProtocolResponse {
        switch request.method {
        case "capabilities":
            return .success(id: request.id, result: [
                "protocolVersion": platformHelperProtocolVersion,
                "platform": "macos-arm64",
                "helperVersion": "0.9.1",
                "secretBackend": "keychain",
                "captureBackend": "screen-capture-kit",
                "authenticatedCaller": true,
                "maxMessageBytes": platformHelperMaximumMessageBytes,
                "methods": platformHelperMethods,
            ])
        case "secret.get":
            let reference = try reference(request.params)
            guard let record = try secrets.get(reference: reference) else {
                throw HelperFailure.secretNotFound
            }
            guard let value = String(data: record.value, encoding: .utf8) else {
                throw HelperFailure.secretStoreUnavailable
            }
            return .success(id: request.id, result: [
                "reference": reference.rawValue,
                "value": value,
                "revision": record.revision,
            ])
        case "secret.set":
            let reference = try reference(request.params)
            guard let value = request.params["value"] as? String else {
                throw HelperFailure.invalidRequest
            }
            let record = try secrets.set(
                reference: reference,
                value: Data(value.utf8),
                expectedRevision: optionalRevision(request.params["expectedRevision"])
            )
            return .success(id: request.id, result: [
                "reference": reference.rawValue,
                "revision": record.revision,
            ])
        case "secret.delete":
            let reference = try reference(request.params)
            let deleted = try secrets.delete(
                reference: reference,
                expectedRevision: optionalRevision(request.params["expectedRevision"])
            )
            return .success(id: request.id, result: [
                "reference": reference.rawValue,
                "deleted": deleted.deleted,
                "revision": deleted.revision.map { $0 as Any } ?? NSNull(),
            ])
        case "window.find":
            let windows = try captures.find(target: request.params["target"] as? String)
            return .success(id: request.id, result: windows.map(\.jsonObject))
        case "window.describe":
            guard let reference = request.params["reference"] as? String else {
                throw HelperFailure.invalidRequest
            }
            return .success(id: request.id, result: try captures.describe(reference: reference).jsonObject)
        case "window.capture":
            guard let captureID = request.params["captureId"] as? String else {
                throw HelperFailure.invalidRequest
            }
            let result = try captures.capture(request: WindowCaptureRequest(
                reference: request.params["reference"] as? String,
                target: request.params["target"] as? String,
                captureId: captureID,
                method: request.params["method"] as? String
            ))
            return .success(id: request.id, result: result.jsonObject)
        default:
            throw HelperFailure.invalidRequest
        }
    }

    private func reference(_ params: [String: Any]) throws -> SecretReference {
        guard let raw = params["reference"] as? String else { throw HelperFailure.invalidReference }
        return try SecretReference(raw)
    }

    private func optionalRevision(_ value: Any?) -> Int? {
        value is NSNull ? nil : positiveInteger(value)
    }
}

private func exactKeys(_ object: [String: Any], _ keys: Set<String>) -> Bool {
    Set(object.keys) == keys
}

private func integer(_ value: Any?) -> Int? {
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

private func positiveInteger(_ value: Any?) -> Int? {
    guard let value = integer(value), value > 0 else { return nil }
    return value
}

func boundedRequestIdentifier(_ bytes: Data) -> Int {
    guard bytes.count <= platformHelperMaximumMessageBytes else { return 1 }
    var scanner = BoundedJSONTopLevelIdentifierScanner(bytes: [UInt8](bytes))
    return scanner.scan() ?? 1
}

private struct BoundedJSONTopLevelIdentifierScanner {
    private let bytes: [UInt8]
    private var index = 0
    private var identifierValues: [Range<Int>] = []
    private let maximumDepth = 64

    init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func scan() -> Int? {
        skipWhitespace()
        guard parseObject(depth: 0, collectIdentifiers: true) else { return nil }
        skipWhitespace()
        guard index == bytes.count,
              identifierValues.count == 1,
              let decoded = try? JSONSerialization.jsonObject(
                with: Data(bytes),
                options: []
              ),
              decoded is [String: Any]
        else {
            return nil
        }
        let token = Data(bytes[identifierValues[0]])
        guard let value = try? JSONSerialization.jsonObject(
            with: token,
            options: [.fragmentsAllowed]
        ) else {
            return nil
        }
        return positiveInteger(value)
    }

    private mutating func parseValue(depth: Int) -> Range<Int>? {
        guard depth <= maximumDepth else { return nil }
        skipWhitespace()
        let start = index
        guard let byte = current else { return nil }
        let valid: Bool
        switch byte {
        case 0x7b:
            valid = parseObject(depth: depth, collectIdentifiers: false)
        case 0x5b:
            valid = parseArray(depth: depth)
        case 0x22:
            valid = parseString() != nil
        case 0x74:
            valid = consume("true")
        case 0x66:
            valid = consume("false")
        case 0x6e:
            valid = consume("null")
        case 0x2d, 0x30...0x39:
            valid = parseNumber()
        default:
            valid = false
        }
        return valid ? start..<index : nil
    }

    private mutating func parseObject(depth: Int, collectIdentifiers: Bool) -> Bool {
        guard depth <= maximumDepth, consumeByte(0x7b) else { return false }
        skipWhitespace()
        if consumeByte(0x7d) { return true }
        while true {
            guard let keyRange = parseString(),
                  let key = decodedString(keyRange)
            else {
                return false
            }
            skipWhitespace()
            guard consumeByte(0x3a),
                  let valueRange = parseValue(depth: depth + 1)
            else {
                return false
            }
            if collectIdentifiers, key == "id" {
                identifierValues.append(valueRange)
            }
            skipWhitespace()
            if consumeByte(0x7d) { return true }
            guard consumeByte(0x2c) else { return false }
            skipWhitespace()
        }
    }

    private mutating func parseArray(depth: Int) -> Bool {
        guard depth <= maximumDepth, consumeByte(0x5b) else { return false }
        skipWhitespace()
        if consumeByte(0x5d) { return true }
        while true {
            guard parseValue(depth: depth + 1) != nil else { return false }
            skipWhitespace()
            if consumeByte(0x5d) { return true }
            guard consumeByte(0x2c) else { return false }
            skipWhitespace()
        }
    }

    private mutating func parseString() -> Range<Int>? {
        let start = index
        guard consumeByte(0x22) else { return nil }
        while let byte = current {
            index += 1
            if byte == 0x22 { return start..<index }
            guard byte >= 0x20 else { return nil }
            if byte == 0x5c {
                guard let escaped = current else { return nil }
                index += 1
                if escaped == 0x75 {
                    for _ in 0..<4 {
                        guard let hex = current, isHex(hex) else { return nil }
                        index += 1
                    }
                } else if ![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(escaped) {
                    return nil
                }
            }
        }
        return nil
    }

    private mutating func parseNumber() -> Bool {
        if consumeByte(0x2d), current == nil { return false }
        guard let first = current else { return false }
        if first == 0x30 {
            index += 1
            if let next = current, (0x30...0x39).contains(next) { return false }
        } else if (0x31...0x39).contains(first) {
            index += 1
            while let next = current, (0x30...0x39).contains(next) { index += 1 }
        } else {
            return false
        }
        if consumeByte(0x2e) {
            guard let digit = current, (0x30...0x39).contains(digit) else { return false }
            while let next = current, (0x30...0x39).contains(next) { index += 1 }
        }
        if let exponent = current, exponent == 0x65 || exponent == 0x45 {
            index += 1
            if let sign = current, sign == 0x2b || sign == 0x2d { index += 1 }
            guard let digit = current, (0x30...0x39).contains(digit) else { return false }
            while let next = current, (0x30...0x39).contains(next) { index += 1 }
        }
        return true
    }

    private func decodedString(_ range: Range<Int>) -> String? {
        var wrapped: [UInt8] = [0x5b]
        wrapped.append(contentsOf: bytes[range])
        wrapped.append(0x5d)
        return (try? JSONSerialization.jsonObject(with: Data(wrapped)) as? [String])?.first
    }

    private mutating func consume(_ literal: StaticString) -> Bool {
        let target = Array(String(describing: literal).utf8)
        guard index + target.count <= bytes.count,
              Array(bytes[index..<(index + target.count)]) == target
        else {
            return false
        }
        index += target.count
        return true
    }

    private mutating func consumeByte(_ byte: UInt8) -> Bool {
        guard current == byte else { return false }
        index += 1
        return true
    }

    private mutating func skipWhitespace() {
        while let byte = current, [0x20, 0x09, 0x0a, 0x0d].contains(byte) {
            index += 1
        }
    }

    private var current: UInt8? {
        index < bytes.count ? bytes[index] : nil
    }

    private func isHex(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte)
            || (0x41...0x46).contains(byte)
            || (0x61...0x66).contains(byte)
    }
}
