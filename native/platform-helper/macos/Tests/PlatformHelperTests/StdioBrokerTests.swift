import Foundation
import Testing

@testable import PlatformHelperService

@Suite struct StdioBrokerTests {
    @Test
    func testFramesPartialAndConcurrentInputIntoOrderedXpcRequests() throws {
        var requests: [String] = []
        let broker = StdioFrameBroker { request in
            let text = String(decoding: request, as: UTF8.self)
            requests.append(text)
            return Data(("reply-" + text).utf8)
        }

        XCTAssertEqual(try broker.accept(Data("one\npar".utf8)), Data("reply-one\n".utf8))
        XCTAssertEqual(
            try broker.accept(Data("tial\ntwo\n".utf8)),
            Data("reply-partial\nreply-two\n".utf8)
        )
        try broker.finish()
        XCTAssertEqual(requests, ["one", "partial", "two"])
    }

    @Test
    func testRejectsEmptyOversizedAndIncompleteFrames() throws {
        let broker = StdioFrameBroker(maxMessageBytes: 4) { request in request }

        XCTAssertThrowsError(try broker.accept(Data("\n".utf8)))
        XCTAssertThrowsError(try broker.accept(Data("12345".utf8)))

        let incomplete = StdioFrameBroker(maxMessageBytes: 4) { request in request }
        _ = try incomplete.accept(Data("123".utf8))
        XCTAssertThrowsError(try incomplete.finish())
    }

    @Test
    func testRejectsOversizedXpcResponse() throws {
        let broker = StdioFrameBroker(maxMessageBytes: 4) { _ in Data("12345".utf8) }

        XCTAssertThrowsError(try broker.accept(Data("one\n".utf8)))
    }
}
