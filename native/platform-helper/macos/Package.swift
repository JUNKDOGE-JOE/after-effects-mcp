// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PlatformHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ae-mcp-platform-helper", targets: ["PlatformHelperService"]),
    ],
    targets: [
        .executableTarget(
            name: "PlatformHelperService",
            path: "Sources/PlatformHelperService",
            resources: [.copy("Resources")],
            linkerSettings: [
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "PlatformHelperTests",
            dependencies: ["PlatformHelperService"],
            path: "Tests/PlatformHelperTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
