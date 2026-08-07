# Per-model Context Limits Settings 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Settings 内嵌「多模型上下文长度」表格，支持查看 Effective（含来源）并为每个已知模型设置/清空 override；保存后下一 turn 的 context meter 使用新 limit。

**架构：** 抽出纯函数构建 `modelContextLimits` 保存补丁（保留孤儿 key）。Main 通过新 IPC 只读暴露 CPA `ModelInfo[]` catalog。SettingsDrawer 用 `settings.models ∪ catalog` 渲染表格，draft 本地预览 Effective，Save 时校验并 `saveSettings`。不改 `resolveContextLimit` 优先级，不即时重算当前会话 meter。

**技术栈：** TypeScript、Vitest、React、Electron IPC、`@claude-desktop/shared` 的 `resolveContextLimit` / `ModelInfo`

**规格：** `docs/superpowers/specs/2026-08-07-context-limits-and-file-formats-design.md`（一期部分）

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/shared/src/model-context-limits.ts` | **新建** — `buildModelContextLimitsPatch` 纯函数 + 校验常量 |
| `packages/shared/src/model-context-limits.test.ts` | **新建** — 补丁/校验单测 |
| `packages/shared/src/index.ts` | 导出新模块 |
| `packages/shared/src/ipc.ts` | 增加 `IPC.cpaModelCatalog` + `IpcInvokeMap` 类型 |
| `apps/desktop/electron/main/ipc-handlers.ts` | handle `getModelCatalog` → `cpa.getModelCatalog()` |
| `apps/desktop/electron/preload/index.ts` | `getModelCatalog()` API |
| `apps/desktop/src/components/SettingsDrawer.tsx` | 表格 UI、draft map、拉 catalog、Save 用纯函数 |
| `apps/desktop/src/styles.css` | 表格 / Effective 徽章样式 |

**不修改：** `context-usage.ts` 优先级逻辑、session-manager 的 meter 写入时机、文件附件相关代码。

---

### 任务 1：纯函数 `buildModelContextLimitsPatch` + 单测

**文件：**
- 创建：`packages/shared/src/model-context-limits.ts`
- 创建：`packages/shared/src/model-context-limits.test.ts`
- 修改：`packages/shared/src/index.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/shared/src/model-context-limits.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
  parseContextLimitInput,
} from "./model-context-limits";

describe("parseContextLimitInput", () => {
  it("treats empty as clear", () => {
    expect(parseContextLimitInput("")).toEqual({ kind: "clear" });
    expect(parseContextLimitInput("   ")).toEqual({ kind: "clear" });
  });

  it("accepts integers in range", () => {
    expect(parseContextLimitInput("256000")).toEqual({
      kind: "value",
      value: 256000,
    });
    expect(parseContextLimitInput("1024.9")).toEqual({
      kind: "value",
      value: 1024,
    });
  });

  it("rejects out of range and non-numeric", () => {
    expect(parseContextLimitInput("abc").kind).toBe("error");
    expect(parseContextLimitInput(String(CONTEXT_LIMIT_MIN - 1)).kind).toBe(
      "error",
    );
    expect(parseContextLimitInput(String(CONTEXT_LIMIT_MAX + 1)).kind).toBe(
      "error",
    );
  });
});

describe("buildModelContextLimitsPatch", () => {
  it("sets override for visible model", () => {
    const res = buildModelContextLimitsPatch({
      existing: {},
      visibleIds: ["k3", "grok-4.5"],
      draft: { k3: "256000", "grok-4.5": "" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.modelContextLimits).toEqual({ k3: 256000 });
    }
  });

  it("clears override for visible model and keeps orphan keys", () => {
    const res = buildModelContextLimitsPatch({
      existing: { k3: 256000, "old-model": 64000 },
      visibleIds: ["k3"],
      draft: { k3: "" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.modelContextLimits).toEqual({ "old-model": 64000 });
    }
  });

  it("returns error without mutating when one row invalid", () => {
    const res = buildModelContextLimitsPatch({
      existing: { k3: 100000 },
      visibleIds: ["k3", "grok-4.5"],
      draft: { k3: "200000", "grok-4.5": "nope" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/grok-4.5/i);
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/shared test -- src/model-context-limits.test.ts
```

预期：FAIL（模块不存在或导出缺失）

- [ ] **步骤 3：编写最少实现**

创建 `packages/shared/src/model-context-limits.ts`：

```ts
export const CONTEXT_LIMIT_MIN = 1024;
export const CONTEXT_LIMIT_MAX = 10_000_000;

export type ParseContextLimitResult =
  | { kind: "clear" }
  | { kind: "value"; value: number }
  | { kind: "error"; message: string };

export function parseContextLimitInput(raw: string): ParseContextLimitResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "clear" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { kind: "error", message: "must be a number" };
  }
  const value = Math.floor(n);
  if (value < CONTEXT_LIMIT_MIN || value > CONTEXT_LIMIT_MAX) {
    return {
      kind: "error",
      message: `must be between ${CONTEXT_LIMIT_MIN} and ${CONTEXT_LIMIT_MAX}`,
    };
  }
  return { kind: "value", value };
}

export type BuildModelContextLimitsResult =
  | { ok: true; modelContextLimits: Record<string, number> }
  | { ok: false; error: string };

/**
 * Merge user draft overrides for visible model rows into existing map.
 * - Starts from a copy of `existing` (preserves orphan keys not in visibleIds)
 * - For each visible id: clear deletes key; value sets floor(int); error aborts
 */
export function buildModelContextLimitsPatch(args: {
  existing: Record<string, number>;
  visibleIds: string[];
  draft: Record<string, string>;
}): BuildModelContextLimitsResult {
  const next: Record<string, number> = { ...args.existing };
  for (const id of args.visibleIds) {
    const raw = args.draft[id] ?? "";
    const parsed = parseContextLimitInput(raw);
    if (parsed.kind === "error") {
      return {
        ok: false,
        error: `Model "${id}" context limit ${parsed.message}`,
      };
    }
    if (parsed.kind === "clear") {
      delete next[id];
    } else {
      next[id] = parsed.value;
    }
  }
  return { ok: true, modelContextLimits: next };
}
```

在 `packages/shared/src/index.ts` 追加：

```ts
export * from "./model-context-limits";
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter @claude-desktop/shared test -- src/model-context-limits.test.ts
pnpm --filter @claude-desktop/shared typecheck
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/shared/src/model-context-limits.ts packages/shared/src/model-context-limits.test.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): buildModelContextLimitsPatch for settings overrides

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 2：暴露 `getModelCatalog` IPC

**文件：**
- 修改：`packages/shared/src/ipc.ts`
- 修改：`apps/desktop/electron/main/ipc-handlers.ts`
- 修改：`apps/desktop/electron/preload/index.ts`

- [ ] **步骤 1：扩展 IPC 契约**

在 `packages/shared/src/ipc.ts`：

1. 顶部 type import 增加 `ModelInfo`（从 `./models` 已 re-export 的路径——当前从 `./models` 的 import 列表加入 `ModelInfo`）。

2. `IPC` 对象中 `cpaSyncModels` 旁增加：

```ts
  /** Read-only cached CPA model catalog (ids + contextLimit) */
  cpaModelCatalog: "cpa:model-catalog",
```

3. `IpcInvokeMap` 增加：

```ts
  [IPC.cpaModelCatalog]: {
    args: [];
    result: ModelInfo[];
  };
```

- [ ] **步骤 2：Main handler**

在 `apps/desktop/electron/main/ipc-handlers.ts` 的 `IPC.cpaSyncModels` handler 之后增加：

```ts
  ipcMain.handle(IPC.cpaModelCatalog, async () => {
    return ctx.cpa.getModelCatalog();
  });
```

注意：只读缓存，**不要**在这里强制 `listModelCatalog()` 网络请求（Sync 按钮已负责刷新）。若缓存为空返回 `[]`。

- [ ] **步骤 3：Preload**

在 `apps/desktop/electron/preload/index.ts` 的 `syncCpaModels` 旁增加：

```ts
  getModelCatalog: () =>
    ipcRenderer.invoke(IPC.cpaModelCatalog) as Promise<
      import("@claude-desktop/shared").ModelInfo[]
    >,
```

（或在文件顶部已有类型 import 时用 `ModelInfo[]`。）

- [ ] **步骤 4：Typecheck**

```bash
pnpm typecheck
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/shared/src/ipc.ts apps/desktop/electron/main/ipc-handlers.ts apps/desktop/electron/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): expose CPA model catalog via IPC

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 3：SettingsDrawer — form draft + 保存逻辑

**文件：**
- 修改：`apps/desktop/src/components/SettingsDrawer.tsx`

- [ ] **步骤 1：替换 FormState 与 fromSettings**

删除 `modelContextLimit: string`。改为：

```ts
import type { AppSettings, ModelInfo, PublicSettings } from "@claude-desktop/shared";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
  resolveContextLimit,
} from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api"; // 若项目用 getDesktop；否则沿用现有 store helpers

type FormState = {
  cpaExePath: string;
  cpaConfigPath: string;
  cpaPort: string;
  token: string;
  modelsCsv: string;
  defaultModel: string;
  shutdownCpaOnQuit: boolean;
  defaultContextLimit: string;
  /** modelId → override 字符串；缺省或 "" = auto */
  modelContextLimitDraft: Record<string, string>;
};

function fromSettings(s: PublicSettings | null): FormState {
  const draft: Record<string, string> = {};
  for (const [k, v] of Object.entries(s?.modelContextLimits ?? {})) {
    draft[k] = String(v);
  }
  return {
    cpaExePath: s?.cpaExePath ?? "",
    cpaConfigPath: s?.cpaConfigPath ?? "",
    cpaPort: String(s?.cpaPort ?? 8317),
    token: "",
    modelsCsv: (s?.models ?? []).join(", "),
    defaultModel: s?.defaultModel ?? "",
    shutdownCpaOnQuit: s?.shutdownCpaOnQuit ?? false,
    defaultContextLimit: String(s?.defaultContextLimit ?? 200_000),
    modelContextLimitDraft: draft,
  };
}
```

- [ ] **步骤 2：Catalog state + 可见 modelIds**

组件内：

```ts
const [catalog, setCatalog] = useState<ModelInfo[]>([]);

async function refreshCatalog() {
  try {
    const desktop = getDesktop(); // 与 Composer 一致；若无则 window.desktop
    const list = await desktop.getModelCatalog();
    setCatalog(Array.isArray(list) ? list : []);
  } catch {
    setCatalog([]);
  }
}

useEffect(() => {
  if (!open) return;
  setForm(fromSettings(settings));
  void refreshCatalog();
}, [open, settings]);

function visibleModelIds(modelsCsv: string, cat: ModelInfo[]): string[] {
  const fromCsv = modelsCsv
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const set = new Set<string>([...fromCsv, ...cat.map((m) => m.id)]);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
```

Sync models 成功后：在现有 `setForm(fromSettings(latest))` 之后调用 `void refreshCatalog()`。

- [ ] **步骤 3：重写 onSave 中 modelContextLimits 段**

替换当前「单模型 merge」逻辑为：

```ts
const defaultContextLimit = Number(form.defaultContextLimit);
if (
  !Number.isFinite(defaultContextLimit) ||
  defaultContextLimit < CONTEXT_LIMIT_MIN ||
  defaultContextLimit > CONTEXT_LIMIT_MAX
) {
  setLocalError(
    `Default context limit must be between ${CONTEXT_LIMIT_MIN} and ${CONTEXT_LIMIT_MAX}`,
  );
  return;
}

const visibleIds = visibleModelIds(form.modelsCsv, catalog);
const patchLimits = buildModelContextLimitsPatch({
  existing: settings?.modelContextLimits ?? {},
  visibleIds,
  draft: form.modelContextLimitDraft,
});
if (!patchLimits.ok) {
  setLocalError(patchLimits.error);
  return;
}

const patch: Partial<AppSettings> & { token?: string } = {
  // …existing fields…
  defaultContextLimit: Math.floor(defaultContextLimit),
  modelContextLimits: patchLimits.modelContextLimits,
};
```

- [ ] **步骤 4：Typecheck**

```bash
pnpm --filter @claude-desktop/desktop typecheck
```

预期：PASS（UI 表格尚未渲染，但单字段已删除、保存逻辑已换）

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/components/SettingsDrawer.tsx
git commit -m "$(cat <<'EOF'
refactor(desktop): settings draft map for per-model context limits

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 4：SettingsDrawer — 渲染表格 + CSS

**文件：**
- 修改：`apps/desktop/src/components/SettingsDrawer.tsx`
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：删除「Current model context limit」单输入**

去掉 label `Current model context limit (tokens)` 整块。

- [ ] **步骤 2：在 Default context limit 提示后插入表格**

```tsx
{(() => {
  const ids = visibleModelIds(form.modelsCsv, catalog);
  const defaultLimit = Number(form.defaultContextLimit);
  const draftAsNumbers: Record<string, number> = {};
  for (const [k, v] of Object.entries(form.modelContextLimitDraft)) {
    const p = v.trim();
    if (!p) continue;
    const n = Number(p);
    if (Number.isFinite(n) && n >= CONTEXT_LIMIT_MIN && n <= CONTEXT_LIMIT_MAX) {
      draftAsNumbers[k] = Math.floor(n);
    }
  }
  const limitSettings = {
    defaultContextLimit:
      Number.isFinite(defaultLimit) && defaultLimit > 0
        ? Math.floor(defaultLimit)
        : 200_000,
    modelContextLimits: {
      ...(settings?.modelContextLimits ?? {}),
      ...draftAsNumbers,
      // 对 draft 清空的可见 id：Effective 预览时不要沿用 existing
    },
  };
  // 预览时：可见 id 若 draft 为空，应从 preview map 删除该 key
  for (const id of ids) {
    const raw = (form.modelContextLimitDraft[id] ?? "").trim();
    if (!raw) delete limitSettings.modelContextLimits[id];
  }

  return (
    <div className="settings-context-limits">
      <div className="settings-context-limits-title">
        Per-model context limits
      </div>
      <p className="settings-hint">
        Empty override = CPA / builtin / default. Changes apply on the next turn.
      </p>
      <div className="settings-context-limits-table-wrap">
        <table className="settings-context-limits-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Effective</th>
              <th>Override</th>
            </tr>
          </thead>
          <tbody>
            {ids.length === 0 ? (
              <tr>
                <td colSpan={3} className="settings-hint">
                  No models — edit Models list or Sync from CPA
                </td>
              </tr>
            ) : (
              ids.map((id) => {
                const { limitTokens, source } = resolveContextLimit(
                  id,
                  limitSettings,
                  catalog,
                );
                return (
                  <tr key={id}>
                    <td className="settings-context-limits-model">{id}</td>
                    <td>
                      <span className="settings-context-limits-effective">
                        {limitTokens}
                      </span>{" "}
                      <span
                        className={`settings-context-limits-source source-${source}`}
                      >
                        {source}
                      </span>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={CONTEXT_LIMIT_MIN}
                        step={1024}
                        placeholder="auto"
                        value={form.modelContextLimitDraft[id] ?? ""}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            modelContextLimitDraft: {
                              ...prev.modelContextLimitDraft,
                              [id]: e.target.value,
                            },
                          }))
                        }
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
})()}
```

若 IIFE 过重，可抽组件内 helper 函数 `renderContextLimitsTable()`，逻辑相同。

**Effective 预览注意：** 对可见 id，draft 空 = 预览时**不**带该 override；draft 有效数字 = 覆盖 existing。实现上以步骤中 `delete` 循环为准。

- [ ] **步骤 3：CSS**

在 `apps/desktop/src/styles.css` 的 settings 区块末尾追加：

```css
.settings-context-limits {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0 4px;
}

.settings-context-limits-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #a8b0bd);
}

.settings-context-limits-table-wrap {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border, #2a3140);
  border-radius: 8px;
}

.settings-context-limits-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.settings-context-limits-table th,
.settings-context-limits-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border, #2a3140);
  vertical-align: middle;
}

.settings-context-limits-table th {
  position: sticky;
  top: 0;
  background: var(--bg-elevated, #1a1f2a);
  color: var(--text-secondary, #a8b0bd);
  font-weight: 500;
}

.settings-context-limits-model {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-context-limits-table input {
  width: 100%;
  min-width: 5rem;
  box-sizing: border-box;
  background: var(--bg-input, #12161e);
  border: 1px solid var(--border, #2a3140);
  border-radius: 6px;
  color: inherit;
  padding: 4px 6px;
}

.settings-context-limits-source {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.85;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
}

.settings-context-limits-source.source-override {
  color: #7dd3fc;
}

.settings-context-limits-source.source-cpa {
  color: #86efac;
}

.settings-context-limits-source.source-builtin {
  color: #fcd34d;
}

.settings-context-limits-source.source-default {
  color: #a8b0bd;
}
```

（颜色变量名若与项目不一致，对齐现有 `styles.css` 中 settings 已用变量。）

- [ ] **步骤 4：Typecheck + 全量 test**

```bash
pnpm typecheck
pnpm test
```

预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/components/SettingsDrawer.tsx apps/desktop/src/styles.css
git commit -m "$(cat <<'EOF'
feat(desktop): per-model context limits table in Settings

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### 任务 5：手动验收清单

- [ ] **步骤 1：启动应用**

```bash
pnpm --filter @claude-desktop/desktop dev
```

- [ ] **步骤 2：按清单验收**

| # | 操作 | 期望 |
|---|------|------|
| 1 | 打开 Settings | 见 Default context limit + Per-model 表 |
| 2 | Sync models from CPA（CPA ready 时） | 行数增加；部分 Effective source=`cpa` |
| 3 | 给 `k3`（或当前默认模型）填 `256000` → Save | Saved；重开 Settings draft 仍为 256000 |
| 4 | 同模型 Override 清空 → Save | key 删除；Effective 变为 cpa/builtin/default |
| 5 | 填非法值 `99` → Save | 顶栏错误，不写盘 |
| 6 | 新开会话跑一轮 | meter 分母为新 limit（若该模型有 override） |
| 7 | 仅改全局 default，无 override 的未知模型 | 回落 default |

- [ ] **步骤 3：若手动发现小问题，修完后 typecheck/test 再 commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "$(cat <<'EOF'
fix(desktop): context limits settings polish from manual QA

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

（无问题时跳过此 commit。）

---

## 自检（对照规格）

| 规格要求 | 任务 |
|----------|------|
| Settings 内嵌表格 | 任务 4 |
| models ∪ catalog 行 | 任务 2+3+4 |
| 不可手填任意 id | 任务 4（无添加行 UI） |
| Effective + source | 任务 4 + `resolveContextLimit` |
| 整数 tokens 展示 | 任务 4 |
| 保存校验范围 | 任务 1+3 |
| 孤儿 key 保留 | 任务 1 测试 + 任务 3 Save |
| 删除单模型输入框 | 任务 3+4 |
| getModelCatalog IPC | 任务 2 |
| 下一 turn 生效（不即时重算 session） | 无代码改 session-manager（有意） |
| 不改优先级语义 | 不改 context-usage.ts |

**范围外（规格二/三期）：** 文件格式、预览、VS Code 外链 — 本计划不包含。

---

## 完成定义

- [x] 计划文档完整  
- [ ] `pnpm typecheck` 与 `pnpm test` 全绿  
- [ ] Settings 表格可设/清空 override  
- [ ] catalog 可读，cpa source 可显示（CPA 已 sync 后）  
- [ ] 手动验收表通过  
