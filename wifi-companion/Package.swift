// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "StackChanWiFiProtocol",
    products: [.library(name: "StackChanWiFiProtocol", targets: ["StackChanWiFiProtocol"])],
    targets: [
        .target(name: "StackChanWiFiProtocol", path: "Sources/Protocol"),
        .testTarget(name: "ProtocolTests", dependencies: ["StackChanWiFiProtocol"], path: "Tests/ProtocolTests"),
    ]
)
