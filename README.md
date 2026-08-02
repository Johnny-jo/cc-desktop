# claude-desktop

An Electron desktop client for Claude Code.

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

## Commands

- `pnpm install` — install dependencies
- `pnpm typecheck` — type-check all packages
- `pnpm test` — run all tests
- `pnpm build` — build all packages

## Packages

- `@claude-desktop/shared` — shared domain models and IPC contracts used by both main and renderer processes.
