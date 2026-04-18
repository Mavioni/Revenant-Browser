<!--
  Merge the block below into the top-level README.md, just before the "## License" section.
  This file exists so the coordinator can copy-paste in one shot without having to diff
  against my edits to the real README.
-->

## Testing

Smoke-level coverage lives under `tests/`.

| Layer | Runner | Command |
|---|---|---|
| Unit (pure logic) | `vitest` | `npm run test:unit` |
| E2E (Electron shell) | `@playwright/test` + `_electron` | `npm test` |

Install the test dev-deps (one-time):

```bash
npm install -D @playwright/test playwright vitest tsx
npx playwright install chromium
```

Run the full smoke pass:

```bash
npm run build:ts        # compile main process
npm test                # Playwright boots the packaged app
npm run test:unit       # pure util coverage (normalizeUrl, ...)
```

The smoke suite intentionally **does not** exercise:

- OpenClaw tool routing (needs gateway on `127.0.0.1:18789`)
- Speech pipeline (needs Python 3.12 venv + Whisper/Kokoro weights)
- `session:start` (needs NeuralClaw docker stack)
- `app:check-internet` (hits `1.1.1.1`)

Those paths get their own dedicated integration layer once the local infra is reproducible
in CI — see `tests/README.md` for the scoping rationale.
