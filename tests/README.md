# Revenant Browser — Test Harness

Smoke-level test scaffolding for the Electron shell. Two layers:

| Layer | Runner | Scope |
|---|---|---|
| E2E | `@playwright/test` in Electron launch mode | App boot, window title, right-rail screen switch, URL bar Enter → nav-updated, back/forward/reload |
| Unit | `vitest` (node env) | Pure logic extracted from `src/main/*.ts` — starting with `normalizeUrl` |

## One-time install

Add the dev dependencies listed in `tests/package-additions.json` to the root `package.json`:

```bash
npm install -D @playwright/test@^1.47.0 playwright@^1.47.0 vitest@^2.1.0 tsx@^4.19.0
npx playwright install chromium
```

> Electron for Playwright ships with the `electron` package already in devDependencies —
> `_electron` under `@playwright/test` reuses that binary.

## Running

```bash
# Build TS first (Electron main must be compiled to dist/)
npm run build:ts

# E2E smoke
npm test

# Unit only
npm run test:unit
```

## What needs mocks to pass fully

These paths exit the hermetic boundary and are *skipped or stubbed* in the smoke suite:

- `speech:transcribe` / `speech:speak` — Python 3.12 venv + Kokoro + Whisper model weights
- `tool:plan` / `tool:execute` — OpenClaw gateway on `127.0.0.1:18789`
- `session:start` — NeuralClaw docker-compose stack
- `app:check-internet` — requires network to `1.1.1.1`

The smoke spec touches only the Electron shell, the preload bridge shape, and `browser:*`
handlers against `https://example.com` (public, low-traffic, stable).
