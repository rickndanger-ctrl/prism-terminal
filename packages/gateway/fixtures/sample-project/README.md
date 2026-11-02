# Broken Sample Repository

This self-contained fixture is the **ONLY allowlisted edit target** for Codex
Lens. Codex may edit files inside this directory and nowhere else.

The bug is intentional: `src/calculator.js` implements addition incorrectly.
The test suite contains one passing baseline test and one test that must fail
until Codex fixes that bug.

## Run standalone

This fixture has no dependencies, so installation is optional. From this
directory, run:

```sh
npm install
npm test
```

The unmodified fixture must report two tests total: one passing and one
failing. Its test file deliberately does not use a `.test.js` suffix, which
keeps the intentional failure out of the root Vitest run and `npm run verify`.
