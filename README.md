# claude-desktop

An Electron desktop client for Claude Code: Codex-style chat / tool cards / Diff UI, driven by `@anthropic-ai/claude-agent-sdk`, with light local CPA (CLIProxyAPI) integration for model routing.

## Structure

```
.
├── apps/
│   └── desktop/          # Electron main + renderer
├── packages/
│   └── shared/           # cross-process types & IPC contracts
├── docs/
│   └── superpowers/      # design specs & implementation plans
└── .superpowers/         # task briefs & reports
```

## Prerequisites

- **Node.js 20+** and **pnpm** (`packageManager`: pnpm@9.15.0)
- **Claude Code CLI** available on `PATH` (Agent SDK spawns the `claude` subprocess)
- **Optional but recommended — local CPA** for model routing:
  - Default exe: `D:\gitrep\CC\CPA\cli-proxy-api.exe`
  - Default config: `D:\gitrep\CC\CPA\config.yaml`
  - Default port: `8317`
  - CPA **auth token** (same as used with `claude-cpa.ps1` / `.cmd`)
- CPA `host` should be **`127.0.0.1`** (do not bind all interfaces)

## Commands

```bash
pnpm install      # install dependencies
pnpm dev          # start Electron + Vite (desktop app)
pnpm test         # run all package tests
pnpm typecheck    # type-check all packages
pnpm build        # build shared + desktop (electron-vite)
pnpm --filter @claude-desktop/desktop dist:dir   # Windows unpacked dir package
```

## First-time setup

1. `pnpm install`
2. Start CPA yourself **or** let the app spawn it (Settings → CPA exe / config paths).
3. `pnpm dev`
4. **Settings** (top bar):
   - Set **Auth token** (encrypted with Electron `safeStorage` when available; main process only)
   - Confirm CPA paths, port, models, default model
5. **Open folder** → pick a project directory as agent `cwd`
6. Send a prompt. Streams and tool cards appear in chat; Edit/Write show in **Changes**
7. Permission modal: **Allow once** / **Allow for session** / **Deny**

### Model & CPA env

On each turn the main process injects into the Claude subprocess:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<cpaPort>`
- `ANTHROPIC_AUTH_TOKEN=<stored token>`
- `ANTHROPIC_MODEL=<selected model>`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

Default models: `kimi-for-coding`, `k3`, `grok-4.5`. Switch model in the top bar for the **next** turn (in-flight turns are not hot-swapped).

`shutdownCpaOnQuit` defaults to `false` so an externally running CPA is not killed on quit. Only a CPA **spawned by this app** is stopped when that flag is enabled.

## Security

- **Token stays in the main process.** Preload exposes a whitelist API; renderer never receives raw auth tokens (`PublicSettings.hasToken` only).
- Prefer CPA bound to **`127.0.0.1`** only.
- Do not log tokens or Authorization headers.
- Default permission mode is `default` (ask); no global `bypassPermissions` in MVP.
- Product positioning: **self-hosted local proxy + user-supplied credentials** — no account sharing.

## Packaging (Windows)

```bash
pnpm --filter @claude-desktop/desktop build
pnpm --filter @claude-desktop/desktop dist:dir
```

Produces an **unpacked directory** under `apps/desktop/release/win-unpacked/` (installer can be added later). Config: `apps/desktop/electron-builder.yml`.

## Packages

- `@claude-desktop/shared` — domain models and IPC contracts for main + renderer
- `@claude-desktop/desktop` — Electron app (main / preload / React renderer)

## Spec & plan

- Design: `docs/superpowers/specs/2026-08-02-claude-desktop-codex-ui-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-02-claude-desktop-codex-ui.md`
