import Dispatch
import Foundation

private enum StdioBrokerFailure: Error {
    case invalidFrame
    case xpcFailure
}

final class StdioFrameBroker {
    typealias Request = (Data) throws -> Data

    private let maxMessageBytes: Int
    private let request: Request
    private var buffered = Data()

    init(
        maxMessageBytes: Int = platformHelperMaximumMessageBytes,
        request: @escaping Request
    ) {
        self.maxMessageBytes = maxMessageBytes
        self.request = request
    }

    func accept(_ chunk: Data) throws -> Data {
        guard !chunk.isEmpty else { return Data() }
        buffered.append(chunk)
        var output = Data()
        while let newline = buffered.firstIndex(of: 0x0a) {
            var frame = buffered[..<newline]
            buffered.removeSubrange(...newline)
            if frame.last == 0x0d { frame = frame.dropLast() }
            guard !frame.isEmpty, frame.count <= maxMessageBytes else {
                throw StdioBrokerFailure.invalidFrame
            }
            let response = try request(Data(frame))
            guard !response.isEmpty,
                  response.count <= maxMessageBytes,
                  !response.contains(0x0a),
                  !response.contains(0x0d)
            else {
                throw StdioBrokerFailure.invalidFrame
            }
            output.append(response)
            output.append(0x0a)
        }
        guard buffered.count <= maxMessageBytes else {
            throw StdioBrokerFailure.invalidFrame
        }
        return output
    }

    func finish() throws {
        guard buffered.isEmpty else { throw StdioBrokerFailure.invalidFrame }
    }
}

private final class StdioXPCClient {
    private let connection: NSXPCConnection

    init() {
        connection = NSXPCConnection(
            machServiceName: PlatformHelperServiceMain.machServiceName,
            options: []
        )
        connection.remoteObjectInterface =
            NSXPCInterface(with: PlatformHelperXPCProtocol.self)
        connection.resume()
    }

    deinit {
        connection.invalidate()
    }

    func request(_ bytes: Data) throws -> Data {
        let semaphore = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var response: Data?
        var failed = false

        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in
            lock.lock()
            failed = true
            lock.unlock()
            semaphore.signal()
        }
        guard let service = proxy as? PlatformHelperXPCProtocol else {
            throw StdioBrokerFailure.xpcFailure
        }
        service.requestJSON(bytes as NSData) { reply, error in
            lock.lock()
            if let reply, error == nil {
                response = reply as Data
            } else {
                failed = true
            }
            lock.unlock()
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + .seconds(10)) == .success else {
            connection.invalidate()
            throw StdioBrokerFailure.xpcFailure
        }
        lock.lock()
        defer { lock.unlock() }
        guard !failed, let response else { throw StdioBrokerFailure.xpcFailure }
        return response
    }
}

enum PlatformHelperStdioBroker {
    static func run(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput
    ) -> Int32 {
        let client = StdioXPCClient()
        let broker = StdioFrameBroker(request: client.request)
        do {
            while true {
                let chunk = input.availableData
                if chunk.isEmpty {
                    try broker.finish()
                    return 0
                }
                let responses = try broker.accept(chunk)
                if !responses.isEmpty {
                    try output.write(contentsOf: responses)
                }
            }
        } catch {
            return 70
        }
    }
}
