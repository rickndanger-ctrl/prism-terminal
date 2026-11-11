# Prism Terminal build 25

## Connection recovery

The persistent Mac worker previously retained credentials loaded at startup even after the main Codex account signed in again. Prism now detects credential-file metadata changes, refreshes only an idle worker, and resumes the existing thread. It checks before new commands and checks idle sessions every 15 seconds. Completed authentication failures also trigger a bounded recovery attempt.

Running commands and uncertain outcomes block recycling. Durable receipt IDs prevent automatic command replay. Revoked or otherwise invalid credentials can still require a browser sign-in on the Mac; this feature does not bypass authentication. Credentials are not logged, and token rotation is not forced inside the isolated worker's copied credential home.

## History restoration

An authenticated, session-specific snapshot restores the latest 100 display items in one response. The event stream then resumes after that snapshot's cursor, without replaying historical speech callbacks. Earlier history remains stored on the Mac. The view opens at the bottom.

This changes display loading, not model context: an existing thread retains its conversation, while New session creates a separate Codex thread. Histories from different sessions are not merged.

Update the gateway before installing this phone build: the phone requires the new snapshot endpoint.

## Verification

- Deployed runtime returned a successful synthetic no-tool Codex reply through the private HTTPS gateway.
- Physical phone inventory confirmed build 25; client requests used the snapshot and a nonzero event cursor.
- The user confirmed reopening at the bottom with no long scroll.
- Eight protected dictation, voice, and composer source files matched the accepted baseline. The terminal view changed only for the intended history display behavior.
- Real-world recovery at the next actual account change and extended background endurance remain unverified. Local automated tests do not substitute for those checks.

Public signing defaults, configurable model selection, and prior dependency hardening are preserved. Local credentials, runtime databases, private logs, and rollback app packages are not included.
