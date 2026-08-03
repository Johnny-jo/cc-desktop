# 上下文窗口占用与 80% 告警 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有 turn/session usage 之上，展示「当前上下文 / 模型窗口」占用进度条，并在 ≥80% 时于每个会话弹一次可关闭横幅。

**架构：** 纯函数放在 `packages/shared`（used/limit/ratio 解析可单测）；CPA `/v1/models` 扩展为带 `contextLimit` 的目录并缓存在 `CpaSupervisor`；`SessionManager` 在每轮 `result` 时写入 `SessionSummary.contextUsage` 并落盘；Renderer 在 `ChatPanel` 画 meter + 内存 dismiss 横幅。

**技术栈：** TypeScript · Vitest · Electron main/renderer · React · 现有 `@claude-desktop/shared` IPC/session 路径

**规格：** `docs/superpowers/specs/2026-08-03-context-window-usage-design.md`

**实现根目录：** `D:\gitrep\claude-desktop`

---

## 文件结构

```
packages/shared/src/
  models.ts                 # + ContextUsage, ContextLimitSource, ModelInfo；AppSettings 新字段
  context-usage.ts          # 新建：used/limit/ratio 纯函数 + 内置表
  context-usage.test.ts     # 新建
  index.ts                  # re-export context-usage

apps/desktop/electron/main/
  cpa-supervisor.ts         # listModelCatalog + 缓存；listModels 可基于 catalog
  cpa-supervisor.test.ts    # 解析 context 字段
  session-manager.ts        # result 时写 contextUsage
  session-archive.ts        # index 读写 contextUsage
  settings-store.ts         # DEFAULTS + load 新字段
  settings-store.test.ts    # 默认 200k / 覆盖持久化
  ipc-handlers.ts           # cpaSyncModels 走 catalog 缓存

apps/desktop/src/
  lib/format-usage.ts       # + formatContextUsageLine / level
  components/ChatPanel.tsx  # meter + banner + dismiss
  components/SettingsDrawer.tsx  # defaultContextLimit 输入
  styles.css                # meter / banner 样式
```

不改 IPC channel 名；`SessionSummary` 多字段即可随 `session:updated` / `session:list` 下发。

---

### 任务 1：Shared 类型 + 纯函数 `context-usage`

**文件：**
- 修改：`packages/shared/src/models.ts`
- 创建：`packages/shared/src/context-usage.ts`
- 创建：`packages/shared/src/context-usage.test.ts`
- 修改：`packages/shared/src/index.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/shared/src/context-usage.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  computeContextUsage,
  extractUsedTokens,
  resolveContextLimit,
  parseModelContextLimit,
} from "./context-usage";
import type { TurnUsage } from "./models";

describe("extractUsedTokens", () => {
  it("prefers inputTokens", () => {
    expect(
      extractUsedTokens({
        inputTokens: 1000,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
      }),
    ).toBe(1000);
  });

  it("falls back to cache sum when input missing", () => {
    expect(
      extractUsedTokens({
        cacheReadTokens: 80,
        cacheCreationTokens: 20,
      }),
    ).toBe(100);
  });

  it("returns undefined when no usable fields", () => {
    expect(extractUsedTokens({ durationMs: 12 })).toBeUndefined();
    expect(extractUsedTokens(undefined)).toBeUndefined();
  });
});

describe("resolveContextLimit", () => {
  it("priority: override > cpa > builtin > default", () => {
    const settings = {
      defaultContextLimit: 200_000,
      modelContextLimits: { "deepseek-v4-flash": 64_000 },
    };
    const catalog = [
      { id: "deepseek-v4-flash", contextLimit: 128_000 },
      { id: "mystery-model" },
    ];

    expect(
      resolveContextLimit("deepseek-v4-flash", settings, catalog),
    ).toEqual({ limitTokens: 64_000, source: "override" });

    expect(
      resolveContextLimit(
        "deepseek-v4-flash",
        { ...settings, modelContextLimits: {} },
        catalog,
      ),
    ).toEqual({ limitTokens: 128_000, source: "cpa" });

    expect(
      resolveContextLimit("claude-opus-5", settings, []),
    ).toEqual({ limitTokens: 200_000, source: "builtin" });

    expect(
      resolveContextLimit("totally-unknown-xyz", settings, []),
    ).toEqual({ limitTokens: 200_000, source: "default" });
  });
});

describe("parseModelContextLimit", () => {
  it("reads common field names", () => {
    expect(parseModelContextLimit({ context_length: 131072 })).toBe(131072);
    expect(parseModelContextLimit({ max_model_len: 32000 })).toBe(32000);
    expect(parseModelContextLimit({ context_window: 200000 })).toBe(200000);
    // max_tokens only if >= 1024
    expect(parseModelContextLimit({ max_tokens: 4096 })).toBe(4096);
    expect(parseModelContextLimit({ max_tokens: 512 })).toBeUndefined();
    expect(parseModelContextLimit({ metadata: { context_length: 99999 } })).toBe(
      99999,
    );
  });
});

describe("computeContextUsage", () => {
  it("builds ratio and drops when used unknown", () => {
    const turn: TurnUsage = { inputTokens: 160_000 };
    const u = computeContextUsage({
      turn,
      modelId: "kimi-for-coding",
      settings: { defaultContextLimit: 200_000, modelContextLimits: {} },
      catalog: [],
      now: 1_700_000_000_000,
    });
    expect(u).toMatchObject({
      usedTokens: 160_000,
      limitTokens: 128_000, // builtin kimi
      source: "builtin",
      modelId: "kimi-for-coding",
      updatedAt: 1_700_000_000_000,
    });
    expect(u!.ratio).toBeCloseTo(160_000 / 128_000);

    expect(
      computeContextUsage({
        turn: { durationMs: 1 },
        modelId: "x",
        settings: { defaultContextLimit: 200_000, modelContextLimits: {} },
        catalog: [],
        now: 1,
      }),
    ).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/shared test
```

预期：FAIL（模块/导出不存在）

- [ ] **步骤 3：扩展 `models.ts` 类型**

在 `packages/shared/src/models.ts` 的 `TurnUsage` / `SessionUsage` 附近增加：

```ts
export type ContextLimitSource = "cpa" | "builtin" | "override" | "default";

export type ContextUsage = {
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  source: ContextLimitSource;
  modelId: string;
  updatedAt: number;
};

export type ModelInfo = {
  id: string;
  contextLimit?: number;
};
```

`SessionSummary` 增加：

```ts
  /** Latest context-window occupancy (not billing totals) */
  contextUsage?: ContextUsage;
```

`AppSettings` 增加：

```ts
  /** Fallback window when model unknown (tokens) */
  defaultContextLimit: number;
  /** Per-model id overrides */
  modelContextLimits: Record<string, number>;
```

`PublicSettings` 继承 `AppSettings` 字段，无需特殊处理。

- [ ] **步骤 4：实现 `context-usage.ts`**

创建 `packages/shared/src/context-usage.ts`：

```ts
import type {
  ContextLimitSource,
  ContextUsage,
  ModelInfo,
  TurnUsage,
} from "./models";

export type ContextLimitSettings = {
  defaultContextLimit: number;
  modelContextLimits: Record<string, number>;
};

/** Prefer input_tokens; else sum of cache fields. */
export function extractUsedTokens(turn?: TurnUsage): number | undefined {
  if (!turn) return undefined;
  if (turn.inputTokens != null && Number.isFinite(turn.inputTokens) && turn.inputTokens >= 0) {
    return turn.inputTokens;
  }
  const cacheRead = turn.cacheReadTokens;
  const cacheCreation = turn.cacheCreationTokens;
  const hasCache =
    (cacheRead != null && Number.isFinite(cacheRead)) ||
    (cacheCreation != null && Number.isFinite(cacheCreation));
  if (!hasCache) return undefined;
  const sum = (cacheRead ?? 0) + (cacheCreation ?? 0);
  return sum >= 0 && Number.isFinite(sum) ? sum : undefined;
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
}

/** Pull context window from a CPA / OpenAI-style model object. */
export function parseModelContextLimit(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const direct =
    positiveInt(o.context_length) ??
    positiveInt(o.context_window) ??
    positiveInt(o.max_model_len) ??
    positiveInt(o.contextLength) ??
    positiveInt(o.contextWindow);
  if (direct != null) return direct;

  const maxTok = positiveInt(o.max_tokens) ?? positiveInt(o.maxTokens);
  if (maxTok != null && maxTok >= 1024) return maxTok;

  for (const nestKey of ["meta", "metadata", "info"]) {
    const nested = o[nestKey];
    if (nested && typeof nested === "object") {
      const n = parseModelContextLimit(nested);
      if (n != null) return n;
    }
  }
  return undefined;
}

/** Builtin table — first matching rule wins (case-insensitive substring). */
const BUILTIN_RULES: Array<{ match: RegExp; limit: number }> = [
  { match: /claude|opus|sonnet|haiku|fable/i, limit: 200_000 },
  { match: /gemini/i, limit: 1_000_000 },
  { match: /gpt-4|gpt-5|\bo1\b|\bo3\b|codex/i, limit: 128_000 },
  { match: /kimi|k3|moonshot/i, limit: 128_000 },
  { match: /deepseek/i, limit: 128_000 },
  { match: /grok/i, limit: 128_000 },
];

export function builtinContextLimit(modelId: string): number | undefined {
  for (const rule of BUILTIN_RULES) {
    if (rule.match.test(modelId)) return rule.limit;
  }
  return undefined;
}

export function resolveContextLimit(
  modelId: string,
  settings: ContextLimitSettings,
  catalog: ModelInfo[],
): { limitTokens: number; source: ContextLimitSource } {
  const override = settings.modelContextLimits?.[modelId];
  if (override != null && Number.isFinite(override) && override > 0) {
    return { limitTokens: Math.floor(override), source: "override" };
  }

  const fromCpa = catalog.find((m) => m.id === modelId)?.contextLimit;
  if (fromCpa != null && fromCpa > 0) {
    return { limitTokens: Math.floor(fromCpa), source: "cpa" };
  }

  const built = builtinContextLimit(modelId);
  if (built != null) {
    return { limitTokens: built, source: "builtin" };
  }

  const def =
    settings.defaultContextLimit > 0
      ? Math.floor(settings.defaultContextLimit)
      : 200_000;
  return { limitTokens: def, source: "default" };
}

export function computeContextUsage(args: {
  turn?: TurnUsage;
  modelId: string;
  settings: ContextLimitSettings;
  catalog: ModelInfo[];
  now?: number;
}): ContextUsage | undefined {
  const used = extractUsedTokens(args.turn);
  if (used == null) return undefined;
  const { limitTokens, source } = resolveContextLimit(
    args.modelId,
    args.settings,
    args.catalog,
  );
  if (limitTokens <= 0) return undefined;
  return {
    usedTokens: used,
    limitTokens,
    ratio: used / limitTokens,
    source,
    modelId: args.modelId,
    updatedAt: args.now ?? Date.now(),
  };
}
```

- [ ] **步骤 5：导出**

`packages/shared/src/index.ts`：

```ts
export * from "./models";
export * from "./ipc";
export * from "./diff";
export * from "./permission-rules";
export * from "./context-usage";
```

- [ ] **步骤 6：运行测试验证通过**

```bash
pnpm --filter @claude-desktop/shared test
pnpm --filter @claude-desktop/shared typecheck
```

预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/context-usage.ts packages/shared/src/context-usage.test.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): context window usage helpers and types

Add ContextUsage/ModelInfo, settings limit fields, and pure
functions for used-token extraction and CPA/builtin/default limits.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 2：Settings 默认值与持久化

**文件：**
- 修改：`apps/desktop/electron/main/settings-store.ts`
- 修改：`apps/desktop/electron/main/settings-store.test.ts`
- 修改：`apps/desktop/electron/main/cpa-supervisor.test.ts`（`baseSettings` 补字段）

- [ ] **步骤 1：编写失败的测试**

在 `settings-store.test.ts` 追加：

```ts
  it("defaults context limit to 200k and persists overrides", () => {
    const store = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    expect(store.get().defaultContextLimit).toBe(200_000);
    expect(store.get().modelContextLimits).toEqual({});

    store.update({
      defaultContextLimit: 256_000,
      modelContextLimits: { "deepseek-v4-flash": 64_000 },
    });
    const again = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    expect(again.get().defaultContextLimit).toBe(256_000);
    expect(again.get().modelContextLimits["deepseek-v4-flash"]).toBe(64_000);
    expect(again.getPublic().defaultContextLimit).toBe(256_000);
  });
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/desktop test -- settings-store
```

预期：FAIL（字段缺失 / 非 200k）

- [ ] **步骤 3：改 DEFAULTS 与 load/get**

`settings-store.ts` 的 `DEFAULTS` 增加：

```ts
  defaultContextLimit: 200_000,
  modelContextLimits: {},
```

`get()` 深拷贝 `modelContextLimits`：

```ts
  get(): AppSettings {
    return {
      ...this.settings,
      models: [...this.settings.models],
      modelContextLimits: { ...this.settings.modelContextLimits },
    };
  }
```

`update` 中若 `publicPatch.modelContextLimits` 存在则拷贝：

```ts
    if (publicPatch.modelContextLimits) {
      publicPatch.modelContextLimits = { ...publicPatch.modelContextLimits };
    }
```

`load()` 合并时规范化：

```ts
      const limits =
        rest.modelContextLimits && typeof rest.modelContextLimits === "object"
          ? Object.fromEntries(
              Object.entries(rest.modelContextLimits as Record<string, unknown>)
                .map(([k, v]) => [k, Number(v)] as const)
                .filter(([, v]) => Number.isFinite(v) && v > 0),
            )
          : { ...DEFAULTS.modelContextLimits };
      const defaultContextLimit =
        typeof rest.defaultContextLimit === "number" &&
        Number.isFinite(rest.defaultContextLimit) &&
        rest.defaultContextLimit > 0
          ? Math.floor(rest.defaultContextLimit)
          : DEFAULTS.defaultContextLimit;

      this.settings = {
        ...DEFAULTS,
        ...rest,
        models: rest.models ? [...rest.models] : [...DEFAULTS.models],
        defaultContextLimit,
        modelContextLimits: limits,
      };
```

（保持与现有 load 结构一致，避免覆盖 token 逻辑。）

- [ ] **步骤 4：修测试 fixture `baseSettings`**

所有构造 `AppSettings` 的测试对象补上：

```ts
  defaultContextLimit: 200_000,
  modelContextLimits: {},
```

至少：`cpa-supervisor.test.ts` 的 `baseSettings`、`session-manager.test.ts` 若有 settings stub。

- [ ] **步骤 5：运行测试**

```bash
pnpm --filter @claude-desktop/desktop test -- settings-store
pnpm --filter @claude-desktop/desktop typecheck
```

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/electron/main/settings-store.ts apps/desktop/electron/main/settings-store.test.ts apps/desktop/electron/main/cpa-supervisor.test.ts apps/desktop/electron/main/session-manager.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): persist defaultContextLimit and model overrides

Default window 200k; round-trip modelContextLimits in settings.json.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 3：CPA 模型目录（带 contextLimit）

**文件：**
- 修改：`apps/desktop/electron/main/cpa-supervisor.ts`
- 修改：`apps/desktop/electron/main/cpa-supervisor.test.ts`
- 修改：`apps/desktop/electron/main/ipc-handlers.ts`

- [ ] **步骤 1：编写失败的测试**

在 `cpa-supervisor.test.ts` 追加（mock `globalThis.fetch`）：

```ts
  it("listModelCatalog parses context fields and caches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "provider/deepseek-v4-flash", context_length: 65536 },
          { id: "deepseek-v4-flash", max_model_len: 128000 },
          { id: "no-limit-model" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });

    const catalog = await cpa.listModelCatalog();
    expect(catalog.some((m) => m.id === "deepseek-v4-flash")).toBe(true);
    const flash = catalog.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.contextLimit).toBe(128000);
    expect(cpa.getModelCatalog().length).toBeGreaterThan(0);

    // listModels still returns string ids
    const ids = await cpa.listModels();
    expect(ids).toContain("deepseek-v4-flash");

    vi.unstubAllGlobals();
  });
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/desktop test -- cpa-supervisor
```

预期：FAIL（无 `listModelCatalog`）

- [ ] **步骤 3：实现 catalog**

在 `cpa-supervisor.ts`：

```ts
import type { AppSettings, CpaStatus, ModelInfo } from "@claude-desktop/shared";
import { parseModelContextLimit } from "@claude-desktop/shared";
```

类内增加：

```ts
  private modelCatalog: ModelInfo[] = [];

  getModelCatalog(): ModelInfo[] {
    return this.modelCatalog.map((m) => ({ ...m }));
  }
```

实现 `listModelCatalog`：

```ts
  async listModelCatalog(): Promise<ModelInfo[]> {
    const settings = this.getSettings();
    const token = this.getToken();
    if (!token) throw new Error("CPA token is not set");
    const url = `http://127.0.0.1:${settings.cpaPort}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `CPA /v1/models failed: ${res.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as { data?: unknown[] };
    const rawItems = Array.isArray(json.data) ? json.data : [];

    // Map id -> best ModelInfo (prefer entry that has contextLimit)
    const byId = new Map<string, ModelInfo>();
    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || !id) continue;
      const contextLimit = parseModelContextLimit(item);
      const next: ModelInfo = {
        id,
        ...(contextLimit != null ? { contextLimit } : {}),
      };
      const prev = byId.get(id);
      if (!prev) byId.set(id, next);
      else if (next.contextLimit != null && prev.contextLimit == null) {
        byId.set(id, next);
      } else if (
        next.contextLimit != null &&
        prev.contextLimit != null &&
        next.contextLimit > prev.contextLimit
      ) {
        byId.set(id, next);
      }
    }

    const ids = preferUnprefixedModels([...byId.keys()]);
    const catalog: ModelInfo[] = ids.map((id) => {
      // Prefer unprefixed row; fall back to any prefixed sibling's limit
      const direct = byId.get(id);
      if (direct?.contextLimit != null) return { id, contextLimit: direct.contextLimit };
      // search prefixed keys ending with /id or equal
      for (const [k, v] of byId) {
        if (k === id || k.endsWith(`/${id}`)) {
          if (v.contextLimit != null) return { id, contextLimit: v.contextLimit };
        }
      }
      return { id, ...(direct?.contextLimit != null ? { contextLimit: direct.contextLimit } : {}) };
    });

    this.modelCatalog = catalog;
    return this.getModelCatalog();
  }

  async listModels(): Promise<string[]> {
    const catalog = await this.listModelCatalog();
    return catalog.map((m) => m.id);
  }
```

注意：保留 `preferUnprefixedModels` 现有行为；若实现时与上列合并逻辑冲突，以「最终 catalog 的 id 列表 === 旧 listModels 结果」为准。

- [ ] **步骤 4：sync IPC 刷新缓存**

`ipc-handlers.ts` 的 `cpaSyncModels`：

```ts
  ipcMain.handle(IPC.cpaSyncModels, async () => {
    await ctx.cpa.ensureReady();
    const catalog = await ctx.cpa.listModelCatalog();
    const models = catalog.map((m) => m.id);
    if (models.length === 0) {
      throw new Error("CPA returned an empty model list");
    }
    const current = ctx.settings.get();
    const defaultModel = models.includes(current.defaultModel)
      ? current.defaultModel
      : models[0];
    ctx.settings.update({ models, defaultModel });
    return { models, defaultModel };
  });
```

- [ ] **步骤 5：测试**

```bash
pnpm --filter @claude-desktop/desktop test -- cpa-supervisor
```

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/electron/main/cpa-supervisor.ts apps/desktop/electron/main/cpa-supervisor.test.ts apps/desktop/electron/main/ipc-handlers.ts
git commit -m "$(cat <<'EOF'
feat(desktop): CPA model catalog with context limits

Parse context_length/max_model_len from /v1/models, cache ModelInfo,
and keep listModels as id projection.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 4：SessionManager 写入 `contextUsage` + 归档

**文件：**
- 修改：`apps/desktop/electron/main/session-manager.ts`
- 修改：`apps/desktop/electron/main/session-manager.test.ts`（若有 result/usage 用例则扩展）
- 修改：`apps/desktop/electron/main/session-archive.ts`

- [ ] **步骤 1：归档读写 contextUsage**

在 `session-archive.ts` 的 `loadIndex` map 中，usage 块后增加：

```ts
        ...(s.contextUsage &&
        typeof s.contextUsage === "object" &&
        Number(s.contextUsage.usedTokens) >= 0 &&
        Number(s.contextUsage.limitTokens) > 0
          ? {
              contextUsage: {
                usedTokens: Number(s.contextUsage.usedTokens) || 0,
                limitTokens: Number(s.contextUsage.limitTokens) || 0,
                ratio: Number(s.contextUsage.ratio) || 0,
                source:
                  s.contextUsage.source === "cpa" ||
                  s.contextUsage.source === "builtin" ||
                  s.contextUsage.source === "override" ||
                  s.contextUsage.source === "default"
                    ? s.contextUsage.source
                    : "default",
                modelId: String(s.contextUsage.modelId ?? ""),
                updatedAt: Number(s.contextUsage.updatedAt) || Date.now(),
              },
            }
          : {}),
```

`saveIndex` 的 map 中：

```ts
          ...(s.contextUsage ? { contextUsage: s.contextUsage } : {}),
```

- [ ] **步骤 2：result 时计算 contextUsage**

`session-manager.ts` 顶部 import：

```ts
import { computeContextUsage } from "@claude-desktop/shared";
```

在 `event.type === "result"` 分支（约 474–484 行），`model` 参数已在 `consumeQuery(sessionId, stream, model)` 中：

```ts
          if (event.type === "result") {
            const settings = this.deps.settings.get();
            const catalog = this.deps.cpa.getModelCatalog();
            const contextUsage =
              computeContextUsage({
                turn: event.usage,
                modelId: model || settings.defaultModel,
                settings: {
                  defaultContextLimit: settings.defaultContextLimit,
                  modelContextLimits: settings.modelContextLimits,
                },
                catalog,
              }) ?? entry.summary.contextUsage; // keep previous if this turn has no tokens

            entry.summary = {
              ...entry.summary,
              status: event.ok ? "idle" : "error",
              updatedAt: Date.now(),
              usage: accumulateUsage(entry.summary.usage, event.usage),
              ...(contextUsage ? { contextUsage } : {}),
            };
            entry.turnActive = false;
            this.emitSession({ ...entry.summary });
            this.persistSummary(entry);
          }
```

从 archive 恢复 session 时，`StoredSession` 已含 `contextUsage` 则带入 `summary`（与 `usage` 相同模式，检查 load 分支是否 spread 整个 stored 字段——`session-manager` restore 处若只拷 `usage`，补上 `contextUsage`）。

找到 restore 类似：

```ts
            ...(stored.usage ? { usage: stored.usage } : {}),
```

旁加：

```ts
            ...(stored.contextUsage ? { contextUsage: stored.contextUsage } : {}),
```

- [ ] **步骤 3：单元测试（可选但推荐）**

若 `session-manager.test.ts` 有 mock query 发 result 的路径，断言 `emitSession` 收到的 summary 含 `contextUsage.usedTokens`。若难接，至少保证 archive 往返有测：可在 archive 旁加小测试文件，或在现有 manager 测里只测 `accumulateUsage` 旁导出的逻辑已在 shared 覆盖——**最低要求：archive 手写 round-trip 或 typecheck 通过 + 手动 dev 验证**。

推荐在 `session-archive` 同目录快速测（若无测试文件，可跳过独立测，依赖 shared 单测 + typecheck）：

手动验证清单写在任务 6。

- [ ] **步骤 4：typecheck + 相关测试**

```bash
pnpm --filter @claude-desktop/desktop typecheck
pnpm --filter @claude-desktop/desktop test -- session
```

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/electron/main/session-manager.ts apps/desktop/electron/main/session-archive.ts apps/desktop/electron/main/session-manager.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): attach contextUsage on turn result

Compute window occupancy from latest input tokens vs model limit
and persist on session summary/index.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 5：Renderer — meter、横幅、Settings

**文件：**
- 修改：`apps/desktop/src/lib/format-usage.ts`
- 修改：`apps/desktop/src/components/ChatPanel.tsx`
- 修改：`apps/desktop/src/components/SettingsDrawer.tsx`
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：格式化与告警档**

`format-usage.ts` 追加：

```ts
import type { ContextUsage, SessionUsage, TurnUsage } from "@claude-desktop/shared";

export type ContextLevel = "ok" | "warn" | "danger";

export function contextLevel(ratio: number): ContextLevel {
  if (ratio >= 0.95) return "danger";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

export function formatContextPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return "—";
  const pct = ratio * 100;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export function formatContextUsageLine(u: ContextUsage): string {
  return `${formatContextPercent(u.ratio)} · ${formatTokens(u.usedTokens)}/${formatTokens(u.limitTokens)}`;
}

export function contextMeterTitle(u: ContextUsage): string {
  return [
    u.modelId,
    `source=${u.source}`,
    `${u.usedTokens} / ${u.limitTokens}`,
    `ratio=${u.ratio.toFixed(3)}`,
  ].join(" · ");
}
```

- [ ] **步骤 2：ChatPanel UI**

`ChatPanel.tsx`：

```tsx
import React, { useEffect, useState } from "react";
import type { PermissionMode } from "@claude-desktop/shared";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { setPermissionMode, useAppStore } from "../state/store";
import {
  contextLevel,
  contextMeterTitle,
  formatContextPercent,
  formatContextUsageLine,
  formatSessionUsageLine,
  formatTokens,
} from "../lib/format-usage";

// ... PERMISSION_MODES 不变

export function ChatPanel({ changesOpen, onToggleChanges, onOpenSettings }: ChatPanelProps) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const itemsBySession = useAppStore((s) => s.itemsBySession);
  const sessions = useAppStore((s) => s.sessions);
  const running = useAppStore((s) => s.running);
  const settings = useAppStore((s) => s.settings);

  // sessionId -> dismissed for this app lifetime
  const [bannerDismissed, setBannerDismissed] = useState<Record<string, true>>({});

  const items = activeSessionId ? (itemsBySession[activeSessionId] ?? []) : [];
  const active = sessions.find((s) => s.id === activeSessionId);
  const sessionUsageLine = formatSessionUsageLine(active?.usage);
  const ctx = active?.contextUsage;
  const level = ctx ? contextLevel(ctx.ratio) : "ok";
  const showBanner =
    Boolean(activeSessionId) &&
    Boolean(ctx) &&
    ctx!.ratio >= 0.8 &&
    !bannerDismissed[activeSessionId!];

  const fillPct = ctx
    ? Math.max(0, Math.min(100, ctx.ratio * 100))
    : 0;

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <div className="chat-header-left">
          <span className="chat-title">
            {active ? active.title : "New chat"}
          </span>
          {running ? <span className="badge running">running</span> : null}
          {sessionUsageLine ? (
            <span className="session-usage" title="Session totals">
              {sessionUsageLine}
            </span>
          ) : null}
          {ctx ? (
            <span
              className={`context-meter context-meter-${level}`}
              title={contextMeterTitle(ctx)}
            >
              <span className="context-meter-bar" aria-hidden>
                <span
                  className="context-meter-fill"
                  style={{ width: `${fillPct}%` }}
                />
              </span>
              <span className="context-meter-label">
                {formatContextUsageLine(ctx)}
              </span>
            </span>
          ) : null}
        </div>
        {/* chat-header-right 保持不变 */}
        ...
      </header>

      {showBanner && ctx ? (
        <div className={`context-banner context-banner-${level}`} role="status">
          <div className="context-banner-text">
            上下文已用 <strong>{formatContextPercent(ctx.ratio)}</strong>
            （{formatTokens(ctx.usedTokens)} / {formatTokens(ctx.limitTokens)}）。
            接近窗口上限，建议新开对话或压缩历史。
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (!activeSessionId) return;
              setBannerDismissed((prev) => ({ ...prev, [activeSessionId]: true }));
            }}
          >
            知道了
          </button>
        </div>
      ) : null}

      <div className="chat-body">
        ...
      </div>
    </div>
  );
}
```

实现时保留原有 header-right / MessageList / Composer 结构，只插入 meter 与 banner。删除未用的 `useEffect` import 若未使用。

- [ ] **步骤 3：Settings 全局默认窗口**

`SettingsDrawer.tsx`：

`FormState` 增加 `defaultContextLimit: string`。

`fromSettings`：

```ts
    defaultContextLimit: String(s?.defaultContextLimit ?? 200_000),
```

`onSave` 校验：

```ts
    const defaultContextLimit = Number(form.defaultContextLimit);
    if (
      !Number.isFinite(defaultContextLimit) ||
      defaultContextLimit < 1024 ||
      defaultContextLimit > 10_000_000
    ) {
      setLocalError("Default context limit must be between 1024 and 10000000");
      return;
    }
```

patch：

```ts
      defaultContextLimit: Math.floor(defaultContextLimit),
```

表单字段（Default model 附近）：

```tsx
          <label className="settings-field">
            Default context limit (tokens)
            <input
              type="number"
              min={1024}
              step={1024}
              value={form.defaultContextLimit}
              onChange={(e) => setField("defaultContextLimit", e.target.value)}
            />
          </label>
          <p className="settings-hint">
            Used when CPA/builtin has no window for the model. Default 200000.
          </p>
```

- [ ] **步骤 4：CSS**

`styles.css` 追加：

```css
.context-meter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-faint);
  max-width: 220px;
}

.context-meter-bar {
  display: inline-block;
  width: 48px;
  height: 4px;
  border-radius: 999px;
  background: var(--bg-active);
  overflow: hidden;
  flex-shrink: 0;
}

.context-meter-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--text-muted);
}

.context-meter-warn {
  color: var(--warn);
}
.context-meter-warn .context-meter-fill {
  background: var(--warn);
}

.context-meter-danger {
  color: var(--danger);
}
.context-meter-danger .context-meter-fill {
  background: var(--danger);
}

.context-meter-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 var(--space-4);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  font-size: 12px;
  color: var(--text);
}

.context-banner-warn {
  border-color: rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.08);
}

.context-banner-danger {
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.1);
}

.context-banner-text {
  min-width: 0;
  line-height: 1.4;
}
```

- [ ] **步骤 5：typecheck**

```bash
pnpm --filter @claude-desktop/desktop typecheck
```

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/lib/format-usage.ts apps/desktop/src/components/ChatPanel.tsx apps/desktop/src/components/SettingsDrawer.tsx apps/desktop/src/styles.css
git commit -m "$(cat <<'EOF'
feat(desktop): context meter and once-per-session 80% banner

Show used/limit progress by session, warn at 80%/95%, dismiss
banner per session in memory; settings for default 200k limit.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 6：全量验证

**文件：** 无新文件（或按需修测试 fixture）

- [ ] **步骤 1：全仓测试与类型**

```bash
pnpm test
pnpm typecheck
```

预期：全部 PASS

- [ ] **步骤 2：真机冒烟（开发者）**

```bash
pnpm dev
```

1. Settings → 确认 Default context limit 为 200000；可 Sync models  
2. 新会话跑一轮能返回 usage 的模型  
3. 标题旁出现 `xx% · used/limit`；hover 见 source  
4. 临时把 default 调到很小（如 1000）再跑一轮 → 应 ≥80%，出横幅  
5. 点「知道了」→ 同会话再跑仍 ≥80% 不重弹；进度条仍在  
6. 新会话 → 可再弹  
7. 重启 app：旧 session 的 meter 仍在（归档）；横幅可再出现（dismiss 不落盘）

- [ ] **步骤 3：若有失败则修并补测**

修完再 `pnpm test && pnpm typecheck`。

- [ ] **步骤 4：最终 commit（仅当有修复时）**

```bash
git add -A
git status
# 若有业务文件变更：
git commit -m "$(cat <<'EOF'
fix(desktop): polish context usage edge cases

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

不要提交 `.tmp/`、`problem/`。

---

## 规格覆盖自检

| 规格章节 | 任务 |
|---|---|
| §3.1 usedTokens | 任务 1 `extractUsedTokens` |
| §3.2–3.3 limit 优先级 + 内置表 | 任务 1 `resolveContextLimit` |
| §3.4–3.5 ratio / 阈值色 | 任务 1 + 任务 5 |
| §4.1–4.2 类型与 Settings | 任务 1 + 2 + 5 |
| §4.3 归档 | 任务 4 |
| §4.4 CPA catalog | 任务 3 |
| §5.1 meter | 任务 5 |
| §5.2 横幅每会话一次 | 任务 5 |
| §6 数据流 | 任务 3–5 |
| §8 测试 | 任务 1–3、6 |
| §9 YAGNI | 未做阻断发送/压缩/tokenizer |

## 类型名一致性

- `ContextUsage` / `ContextLimitSource` / `ModelInfo`
- `defaultContextLimit` / `modelContextLimits`
- `listModelCatalog` / `getModelCatalog`
- `computeContextUsage` / `extractUsedTokens` / `resolveContextLimit` / `parseModelContextLimit`
