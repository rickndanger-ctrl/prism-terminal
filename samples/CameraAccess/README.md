# Prism Terminal iOS source

This is the public-source configuration of the accepted build 24 application.
It contains no developer account, signing profile, device identifier, gateway
credential, or private `Secrets.swift`. The working app's dictation and command
logic are retained; see the repository README for current feature limitations.

## Build

1. Open `CameraAccess.xcodeproj` in Xcode.
2. Select the **CameraAccess** scheme. Let Swift Package Manager resolve the
   pinned Meta DAT 0.5.0 and WebRTC 140.0.0 dependencies.
3. In **Signing & Capabilities**, choose your own development team and replace
   `org.example.PrismTerminal` with a unique bundle identifier. If running the
   app-hosted integration tests, also configure the CameraAccessTests target.
4. Select an iPhone running iOS 17 or later and build/run. Use your own Meta
   developer configuration when testing glasses; production Meta app credentials
   are not supplied.
5. Enter your own authenticated Mac gateway URL and token in the app's Settings.
   Use a trusted HTTPS connection. The gateway is a separate process; building
   the iOS app does not start or configure it.

`PublicDefaults.swift` intentionally provides empty values for optional legacy
Gemini/OpenClaw/WebRTC integrations. The public project compiles with these
defaults; do not copy a private `Secrets.swift` into source control. The primary
Prism Terminal workflow does not require a provider API key in the iOS sources.
Legacy MoA runner fields point only to `example.invalid` until configured.

From the repository root, headless shared-code tests are:

```sh
swift test --package-path packages/CodexLensKit
```

An unsigned compile check, with dependencies available, is:

```sh
xcodebuild -project samples/CameraAccess/CameraAccess.xcodeproj \
  -scheme CameraAccess -configuration Debug \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

That checks compilation, not physical glasses, on-device speech recognition,
background behavior, signing, or installation. No device test is implied by a
successful unsigned build.

Publication verification on November 1, 2026: 410 shared Swift tests passed, and
the unsigned iOS app build succeeded with Xcode 27.0 (27A266a). Existing legacy
deprecation/concurrency warnings remain; this is not a warning-free-build claim.

## Publication differences

- Build number is explicitly 24 in the project rather than a local CLI override.
- Signing teams are empty; app/test bundle IDs are public examples.
- The gateway Keychain service uses the public example namespace.
- Personal runner defaults are replaced with a non-routable example hostname.
- Private secrets are replaced by empty compiled defaults.
- Build caches, developer-user Xcode state, synthetic probe recordings/results,
  and the unused legacy signaling server are omitted. Diagnostic source remains
  debug-only and requires explicit launch arguments; no recordings are bundled.
- Nonessential PNG metadata is removed from the public icon and inherited plant
  image without changing their pixel data. The plant video is the unchanged
  already-public upstream test fixture, not a user recording.
- The shared package differs only in a nonfunctional test comment describing
  the canonical Codex app alias.

The historical `CameraAccess` directory/target names are retained to preserve
project references. The installed display name is **Prism Terminal**.

See [third-party notices](../../THIRD_PARTY_NOTICES.md) before redistributing.
