// swift-tools-version:5.9
import PackageDescription

// CodexLensKit is the headlessly-testable core of the Codex Lens iPhone app:
// the gateway client, the Realtime session state machine, the event-stream
// cursor, and the wire types. It depends only on Foundation, so `swift test`
// verifies it with no device, no UI frameworks, and no live network. The
// SwiftUI shell and live WebRTC/AVFoundation code live in ../CodexLensApp and
// are NOT part of this package (they need Xcode on a device).
let package = Package(
    name: "CodexLensKit",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "CodexLensKit", targets: ["CodexLensKit"]),
    ],
    targets: [
        .target(name: "CodexLensKit"),
        .testTarget(
            name: "CodexLensKitTests",
            dependencies: ["CodexLensKit"]
        ),
    ]
)
