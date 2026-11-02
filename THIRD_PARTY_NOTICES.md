# Third-party attribution and licensing

Public source availability does not replace any upstream license or grant a
blanket license to every component. This document preserves provenance; it does
not change the terms of any dependency or original work.

## iOS application ancestry

The iOS application under `samples/CameraAccess/` is a modified derivative of
[VisionClaw](https://github.com/sseanliu/VisionClaw), itself based on the
[Meta Wearables Device Access Toolkit CameraAccess sample](https://github.com/facebook/meta-wearables-dat-ios).
Existing Meta copyright and license-reference headers remain in the source.
Prism Terminal adds its own command/dictation interface, shared Swift package,
Mac-gateway client, recovery logic, and app branding; these modifications are not
represented as upstream Meta or VisionClaw features.

The inherited VisionClaw license file refers to Meta Wearables Developer Terms,
not MIT. Its exact inherited files are retained here:

- [VisionClaw LICENSE](third_party/visionclaw/LICENSE)
- [VisionClaw NOTICE](third_party/visionclaw/NOTICE)

VisionClaw's published citation credits Xiaoan Liu, DaeHo Lee, Eric J. Gonzalez,
Mar Gonzalez-Franco, and Ryo Suzuki, *VisionClaw: Always-On AI Agents through
Smart Glasses*, arXiv:2604.03486 (2026).

## Pinned iOS dependencies

| Component | Pinned version | Preserved license/notice |
| --- | --- | --- |
| Meta Wearables DAT iOS | 0.5.0, revision `2ea30fa228359315baf71c404aec821472e994c1` | [LICENSE](third_party/meta-wearables-dat-ios/LICENSE), [NOTICE](third_party/meta-wearables-dat-ios/NOTICE) |
| stasel/WebRTC Swift package | 140.0.0, revision `86dbb5cb57e4da009b859a6245b1c10d610f215a` | [LICENSE.md](third_party/webrtc/LICENSE.md), including Google WebRTC attribution |

The versions and revisions are also recorded in
`samples/CameraAccess/CameraAccess.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
SDK/framework binaries are not vendored in this repository. Xcode resolves them
from their upstream packages. Their respective licenses and service/developer
terms continue to apply.

Meta's developer terms and acceptable-use policy are linked in the retained
LICENSE files. Access to the current developer terms may require a Meta account.
Maintainers and downstream distributors must review the applicable terms; this
publication does not claim to have established additional redistribution rights.

## Scope

The upstream sample artwork and plant test fixtures retain their upstream
provenance. The active Prism Terminal app icon is a project-specific replacement;
the unused inherited JPEG app-icon candidate is not included. Nonessential PNG
metadata has been removed from the public icon and plant image; their pixel data
is unchanged. The plant video matches the public VisionClaw upstream fixture.

The Mac gateway's npm dependencies are recorded separately in its package
manifest and lockfile. Their upstream licenses apply independently. Any future
binary/app distribution should also retain the notices supplied by resolved
dependencies.
