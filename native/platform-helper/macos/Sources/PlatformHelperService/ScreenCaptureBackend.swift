import Foundation

struct WindowFrame: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var jsonObject: [String: Any] {
        ["x": x, "y": y, "width": width, "height": height]
    }
}

struct WindowDescription: Equatable {
    let reference: String
    let processIdentifier: Int
    let title: String
    let frame: WindowFrame
    let scale: Double
    let capturable: Bool

    var jsonObject: [String: Any] {
        [
            "reference": reference,
            "application": "after-effects",
            "ownerBundleId": MacCallerPolicy.afterEffectsBundleIdentifier,
            "ownerTeamId": MacCallerPolicy.adobeTeamIdentifier,
            "processId": processIdentifier,
            "title": title,
            "frame": frame.jsonObject,
            "scale": scale,
            "capturable": capturable,
        ]
    }
}

struct WindowCaptureRequest: Equatable {
    let reference: String?
    let target: String?
    let captureId: String
    let method: String?
}

struct CaptureResult: Equatable {
    let captureId: String
    let reference: String
    let spoolPath: String
    let width: Int
    let height: Int
    let scale: Double
    let sha256: String

    var jsonObject: [String: Any] {
        [
            "captureId": captureId,
            "reference": reference,
            "spoolPath": spoolPath,
            "width": width,
            "height": height,
            "scale": scale,
            "method": "ScreenCaptureKit",
            "sha256": sha256,
        ]
    }
}

protocol ScreenCaptureServing {
    func find(target: String?) throws -> [WindowDescription]
    func describe(reference: String) throws -> WindowDescription
    func capture(request: WindowCaptureRequest) throws -> CaptureResult
}

struct UnavailableScreenCaptureBackend: ScreenCaptureServing {
    func find(target: String?) throws -> [WindowDescription] {
        throw HelperFailure.helperUnavailable
    }

    func describe(reference: String) throws -> WindowDescription {
        throw HelperFailure.helperUnavailable
    }

    func capture(request: WindowCaptureRequest) throws -> CaptureResult {
        throw HelperFailure.helperUnavailable
    }
}
