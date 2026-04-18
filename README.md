# Revenant Browser

> A browser that haunts the network.

Sovereign, local-first, ternary-principled desktop shell with AI-assisted tool routing. Hexagonal-vortex aesthetic. Built to run offline-first and hand off to cloud providers only by explicit operator consent.

## Status

**v0.1 — shell-only.** Electron-hosted UI over the final Revenant Browser design. Speech (Whisper + Kokoro) and OpenClaw tool routing are wired but require local infrastructure (see below). Full Chromium-fork is a Phase 2 migration.

## What's inside

| Layer | Module | Purpose |
|---|---|---|
| Shell | `src/main/index.ts` | Electron main process, window + tray lifecycle |
| Bridge | `src/main/preload.ts` | `window.revenant.*` context bridge |
| AI Speech | `src/main/speech-service.ts` + `python/lelu_speech_worker.py` | Whisper transcribe + Kokoro TTS via persistent Python 3.12 worker |
| Tool routing | `src/main/openclaw-client.ts` | OpenAI-compatible `/v1/chat/completions` dispatch through the OpenClaw gateway |
| Governance | `src/main/companion-store.ts` | Trusted-operator permission tiers (`observe / draft / workspace-mutate / system-mutate / external-act`) with queued approvals |
| Runtime health | `src/main/runtime-supervisor.ts` | NeuralClaw stack loopback health checks |
| UI | `src/renderer/index.html` | Polished design: Start, Browsing + Threat Radar, Tab Graph, Split View, AI Copilot, Resource Governor + Vaults, ⌘K command palette |

## Runtime dependencies

- **Node** 20+ (Electron 33)
- **Python** 3.12 — for speech worker (venv scaffolded at `python/.venv/`)
- **NeuralClaw** stack — OpenClaw gateway on `127.0.0.1:18789`. Required for tool routing; optional for shell-only exploration.
- **Ollama** — local LLM backend. `anbu-commander:v1` recommended as default model.

## Build

```bash
npm install
npm run build:ts
npm start
```

For the speech worker:
```bash
cd python
py -3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

## Aesthetic

- Dark-mode chrome; light mode as a toggle
- Red hot accent (hexagonal vortex hourglass)
- Space Grotesk (display) + JetBrains Mono (UI)
- Rail tabs (left side)
- Subtle scanlines (dark mode only)

Logo: a hexagonal vortex of nested rings. The geometry is the DNA.

## License

MIT — see `LICENSE`.
