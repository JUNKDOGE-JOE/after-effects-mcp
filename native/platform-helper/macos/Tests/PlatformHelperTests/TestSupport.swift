import Foundation
import Testing

func XCTAssertEqual<T: Equatable>(
    _ actual: @autoclosure () throws -> T,
    _ expected: @autoclosure () throws -> T,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    do {
        #expect(try actual() == expected(), sourceLocation: sourceLocation)
    } catch {
        Issue.record("assertion threw an error", sourceLocation: sourceLocation)
    }
}

func XCTAssertEqual(
    _ actual: @autoclosure () throws -> NSDictionary,
    _ expected: @autoclosure () throws -> NSDictionary,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    do {
        #expect(try actual().isEqual(expected()), sourceLocation: sourceLocation)
    } catch {
        Issue.record("assertion threw an error", sourceLocation: sourceLocation)
    }
}

func XCTAssertNil<T>(
    _ value: @autoclosure () throws -> T?,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    do {
        #expect(try value() == nil, sourceLocation: sourceLocation)
    } catch {
        Issue.record("assertion threw an error", sourceLocation: sourceLocation)
    }
}

func XCTAssertFalse(
    _ value: @autoclosure () throws -> Bool,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    do {
        #expect(try !value(), sourceLocation: sourceLocation)
    } catch {
        Issue.record("assertion threw an error", sourceLocation: sourceLocation)
    }
}

func XCTAssertThrowsError<T>(
    _ expression: @autoclosure () throws -> T,
    sourceLocation: SourceLocation = #_sourceLocation,
    _ inspect: (Error) -> Void = { _ in }
) {
    do {
        _ = try expression()
        Issue.record("expected expression to throw", sourceLocation: sourceLocation)
    } catch {
        inspect(error)
    }
}

func XCTUnwrap<T>(
    _ value: @autoclosure () throws -> T?,
    sourceLocation: SourceLocation = #_sourceLocation
) throws -> T {
    do {
        guard let unwrapped = try value() else {
            Issue.record("required value was nil", sourceLocation: sourceLocation)
            throw TestSupportFailure.requiredValueWasNil
        }
        return unwrapped
    } catch let failure as TestSupportFailure {
        throw failure
    } catch {
        Issue.record("required value threw an error", sourceLocation: sourceLocation)
        throw error
    }
}

private enum TestSupportFailure: Error {
    case requiredValueWasNil
}
