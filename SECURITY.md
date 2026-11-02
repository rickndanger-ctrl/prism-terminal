# Security and privacy

Prism is experimental software that can operate your Mac. Treat the phone, gateway token, Codex account, and paired computer as a trusted control system.

## Important boundaries

- The gateway listens on `127.0.0.1`, not your public network interface. Keep it there. Use an authenticated private HTTPS connection for the phone; do not port-forward the gateway or publish it through an unauthenticated tunnel.
- All authenticated gateway routes require a bearer token. A valid token can grant broad Mac access. Generate your own token; no shared or default secret is included.
- Codex terminal tasks use full-access execution on the Mac. Natural-language task instructions are **not** an OS sandbox. Run only with an account and files you intend to place under agent control.
- Deterministic typing inserts into a verified focused editable field and does not press Enter or Send. External messages, purchases, account changes, file operations, and other agent tasks still require careful user direction and outcome verification.
- Interrupted commands are not silently replayed. An uncertain receipt means check the Mac before deciding what to do next.
- Do not enable continuous camera sharing without understanding that captured images can become conversation context. Camera indicators, permissions, and explicit stop controls must remain intact.

## Data and credentials

The phone stores its gateway token in Keychain. The Mac uses your own Codex authentication and configured provider credentials. Chat history, screenshots, images, task receipts, and local databases may contain private information; keep those runtime files out of Git.

Speech recognition uses Apple's Speech framework; actual recognition availability and processing depend on the device and configuration. Codex tasks and submitted image/text context can reach the configured model service. Optional speech/provider integrations have their own processing and usage policies. Do not assume the entire assistant is offline merely because some components run locally.

The repository intentionally excludes `.env` files, live authentication files, personal runtime databases, signed phone apps, recordings, model weights, and developer provisioning profiles. Use sample configuration only; never paste real keys into source, screenshots, issues, or pull requests.

## Reporting

Use the repository's private vulnerability-reporting option if it is available. Do not post a working credential or private user data in a public issue. If private reporting is unavailable, open a content-free request for a private reporting channel rather than publishing exploit details or secrets.

Public-source availability and passing tests do not certify security or production readiness. Review permissions and dependencies before running this on a computer with sensitive accounts or documents.
