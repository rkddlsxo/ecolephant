// swift-tools-version:5.9
// AirPods head-motion helper for ecolephant (macOS 14+). See README.md.
import PackageDescription

// macOS asks for motion permission only when the executable carries an Info.plist with
// NSMotionUsageDescription, so the plist is embedded into the binary at link time.
let infoPlist = Context.packageDirectory + "/Support/Info.plist"

let package = Package(
    name: "airpods-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "airpods-helper",
            path: "Sources/airpods-helper",
            linkerSettings: [
                .linkedFramework("CoreMotion"),
                .linkedFramework("Network"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", infoPlist,
                ]),
            ]
        ),
    ]
)
