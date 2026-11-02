# Real-world beta testing

This public snapshot is based on Prism Terminal build 24. It replaces the earlier Codex Lens iPhone implementation as the current application in this repository. Existing GitHub history is preserved; private rollback artifacts and local-only development history are not included. This is not a claim that every historical integration is complete.

## Evidence at publication

- Build 23 fixed disappearing earlier dictation phrases. The tester confirmed two spoken sentences stayed in the composer.
- Build 24 adds finite exact-command aliases so more everyday requests use the existing deterministic Mac executor rather than a model turn.
- The shared Swift suite has 410 passing tests, including 23 exact-command test functions. An independent adversarial parser check ran 3,116 assertions without a failure.
- The signed developer build 24 was installed and launched on a physical iPhone. Public source uses neutral signing configuration: it must be signed with your own team and bundle identifier.
- Build 24 did not change the accepted dictation, microphone, voice, or composer implementation. Automated tests and unchanged source do not replace physical-device acceptance.

## Small first check

1. Connect the app to your own Mac gateway.
2. Dictate `Open the Calculator app`, stop dictation, and press **Send**.
3. Confirm Calculator actually becomes frontmost. A queued request or model acknowledgement is not completion.
4. Try `Close this window` only when the intended window is frontmost.
5. To test typing, first focus a disposable text field. Dictate `Type: hello from Prism`, then Send. Verify insertion and confirm no Enter/Send key was generated.

The app retains explicit Send. Quoted, negated, conditional, compound, and unknown-app requests are not promoted to deterministic shortcuts; they follow the contextual Codex path instead. `Close Calculator` is not the same shortcut as `Close this window`.

## Longer-session gates

Test ordinary use before endurance runs: multiple dictation phrases and pauses, a recognition-request handoff, focused typing, app/window/browser controls, lost network replies, reconnects, and a Mac restart. Confirm previous commands are not replayed and newer composer text is not cleared by older receipts.

Background hands-free voice, 45–60 minute locked-phone operation, battery/thermal behavior, and continuous camera-aware interaction remain unfinished validation areas. Still-image readability depends on lighting, distance, glare, and text size. Do not interpret image capture success as proof that all small text is readable.

Avoid changing several subsystems at once. Keep a private signed rollback build and a source checkpoint; exclude credentials, personal data, and device identifiers from public bug reports. Report the build, exact action, observed result, and timing without posting private dictated content.

## Timing claims

The new exact aliases avoid model routing by construction. No universal end-to-end speedup percentage is claimed. Existing HTTP timing samples include cached receipts and responses that may describe blocked or uncertain actions; they are not a clean benchmark of completed Mac tasks.
