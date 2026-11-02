# Public-source verification

Date: 2026-11-01. Baseline: Prism Terminal build 24. This is a beta source publication, not an App Store release or a signed app download.

## Scope

The current iOS app/shared package and Mac gateway were assembled in an isolated publication checkout. The previously installed phone build, working development trees, live gateway, credentials, personal runtime data, and private rollback packages were not replaced by this publication.

The existing public GitHub repository and its history are retained. The new default-branch snapshot presents Prism as the current app; the old developer iOS project is not the installation target in this snapshot.

## Verification record

- Shared Swift package: **410 tests passed** in the public copy.
- Public iOS application: unsigned Xcode device build passed with example signing configuration and no private Secrets.swift. This does not imply signing, installation, or physical test acceptance of the public-copy bundle.
- Legacy app-hosted CameraAccessTests were not executed as part of this publication. They are separate from the 410 shared-package tests.
- Gateway TypeScript typecheck and ESLint: passed.
- Gateway/shared tests: **107 test files / 1,200 tests passed**, using four test workers.
- Script tests: **3 passed**. Optional local-voice protocol tests: **6 passed** (no speech model inference or paid API).
- Production gateway build and startup-script syntax checks: passed.

## Publication-only changes

- Neutral development-team/bundle settings, explicit build 24, empty compiled defaults for inherited optional providers, and non-routable example runner addresses.
- Portable gateway startup/launch-agent scripts; no developer-specific home paths or mandatory OpenAI API key for the core terminal route.
- Optional terminal-model configuration, with the prior default retained; choose a model available to your own Codex account.
- Compatible gateway dependency updates and a covered request-subscription cleanup correction. These changes are **not installed in the already-running developer gateway**.
- Optional local voice/CLEF source retained without model weights, environments, private host configuration, or an automatically enabled background service.

## Dependency audit

The incoming dependency set reported 22 findings (8 high, 14 moderate). Compatible, non-forced updates reduced that to **11 moderate development-dependency findings**, with **zero production findings** and no high/critical findings in the resulting lockfile at the time of the check. The remaining advisories are in the ESLint/minimatch development-tool chain. They were not suppressed or forced across incompatible major versions.

An audit is a point-in-time dependency report, not a security certification. Recheck with `npm audit` and `npm audit --omit=dev`; see [SECURITY.md](../SECURITY.md).

## Privacy and provenance

Only selected source, tests, examples, required artwork, and upstream notices are included. No private API keys, live tokens, authentication files, personal databases, signed applications, provisioning profiles, developer user-state, model weights, recordings, or personal screenshots are intended for this snapshot. Synthetic credential strings in tests are fixtures, not real account credentials.

Publication PNG ancillary metadata was removed from the app icon and upstream plant image while verifying unchanged compressed image data, decoded pixel data, and retained color chunks. The sole included video is the upstream plant decoder-test fixture, not a user recording.

Original third-party notices are retained. The inherited Meta developer terms are not represented as a blanket MIT license or a new redistribution grant. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Remaining acceptance gates

Core live dictation was accepted on the private build-23 baseline; build 24's expanded exact routing still needs ordinary real-world use. Phone background endurance, always-on voice, continuous camera interaction, all app-specific computer controls, and consequential third-party integrations remain separate gates. See [REAL-WORLD-TESTING.md](REAL-WORLD-TESTING.md).
