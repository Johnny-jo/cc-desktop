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

- **Node.js** + **pnpm**
- **Local CPA** (optional but required for model proxy):
  - Default exe: `D:\gitrep\CC\CPA\cli-proxy-api.exe`
  - Default config: `D:\gitrep\CC\CPA\config.yaml`
  - Default port: `8317`
- CPA **auth token** (same as used with `claude-cpa.ps1` / `.cmd`)

## Commands

- `pnpm install` — install dependencies
- `pnpm typecheck` — type-check all packages
- `pnpm test` — run all tests
- `pnpm build` — build all packages
- `pnpm --filter @claude-desktop/desktop dev` — start Electron + Vite dev

## Run (dev)

1. `pnpm install`
2. Start CPA yourself **or** let the app spawn it via settings paths (`cpaExePath` / `cpaConfigPath`).
3. `pnpm --filter @claude-desktop/desktop dev`
4. In the app, set the CPA token (settings store / `settings:set` IPC; full settings UI is Task 14). Token is encrypted with Electron `safeStorage` when available.
5. Open a project directory as `cwd`.
6. Send a prompt. Streams and tool cards appear in chat; Edit/Write show up in **Changes**.
7. Permission modal: **Allow once** / **Allow for session** / **Deny** for tools that need approval.

### Model & CPA env

On each turn the main process injects into the Claude subprocess:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<cpaPort>`
- `ANTHROPIC_AUTH_TOKEN=<stored token>`
- `ANTHROPIC_MODEL=<selected model>`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

Default models list: `kimi-for-coding`, `k3`, `grok-4.5`. Switch model in the top bar for the **next** turn (in-flight turns are not hot-swapped).

`shutdownCpaOnQuit` defaults to `false` so an externally running CPA is not killed on app exit. Only a CPA **spawned by this app** is stopped when that flag is enabled.

## Packages

- `@claude-desktop/shared` — shared domain models and IPC contracts used by both main and renderer processes.
- `@claude-desktop/desktop` — Electron app (main / preload / React renderer).

## Spec & plan

- Design: `docs/superpowers/specs/2026-08-02-claude-desktop-codex-ui-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-02-claude-desktop-codex-ui.md`
