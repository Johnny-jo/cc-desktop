# 上下文窗口占用与 80% 告警

**日期：** 2026-08-03  
**状态：** 已获用户批准（待实现计划）  
**范围：** 基于现有 turn/session usage，增加「相对模型上下文窗口」的占用计算、标题旁进度条、≥80% 横幅告警  
**前置：** `a0e711f` 已提供 per-turn `TurnUsage`、session 累计 `SessionUsage`、聊天 header 账单行

---

## 1. 背景与目标

用户已能看到每轮耗时/token 与会话累计账单。需要再加：

1. **当前上下文占用**（相对模型窗口上限的比例）
2. **≥80% 告警**（进度条变色 + 聊天区横幅）

与账单统计分离：`SessionUsage` 继续表示「会话累计费用/时长」；新字段表示「窗口瞬时占用」。

### 1.1 已确认决策

| 项 | 决策 |
|---|---|
| 分子（used） | 最近一轮 `input_tokens`（见 §3.1） |
| 分母（limit） | **CPA `/v1/models` 优先** → 内置表 → Settings 覆盖/全局默认 |
| 全局默认窗口 | **200_000** |
| UI | 标题旁进度条 + 数字；≥80% 聊天区横幅 |
| 横幅 | **每个会话超过 80% 只弹一次**（关闭后本会话不再弹；新会话重置） |
| 发送 | **不阻断** |

---

## 2. 概念区分

| 概念 | 含义 | 用途 |
|---|---|---|
| **TurnUsage** | 单轮 SDK result 的 token/耗时/费用 | 消息下方 chip |
| **SessionUsage** | 会话内各轮累加 | 标题旁账单行 |
| **ContextUsage**（新） | 最近一轮上下文 used / 模型 limit | 进度条 + 80% 告警 |

---

## 3. 计算规则

### 3.1 usedTokens（分子）

在收到 SDK `result` 且能解析出 usage 时更新：

1. **优先** `usage.inputTokens`（来自 `input_tokens` / `inputTokens`）
2. 若缺失，且存在 cache 字段：  
   `cacheReadTokens + cacheCreationTokens`（缺失项按 0）
3. 若仍无法得到有效非负有限数：**不更新** used（保留上一轮 ContextUsage；若无历史则不显示 meter）
4. **不加** `outputTokens`，**不用** 会话累计 `SessionUsage`

说明：部分上游把 cache 计入 `input_tokens`，部分分列。MVP 以 `input_tokens` 为权威，避免重复累加导致虚高。

### 3.2 limitTokens（分母）— 解析优先级

对**当前选用模型 id**（与下一轮/本轮注入的 `ANTHROPIC_MODEL` 一致，通常为 settings `defaultModel`；若会话日后绑定模型则用会话模型）：

1. **Settings 覆盖**  
   `modelContextLimits[modelId]`（精确 id；可选后续再做前缀匹配，MVP 精确匹配即可）
2. **CPA 模型目录缓存**  
   最近一次成功的 `/v1/models` 解析结果中该 id 的 context 字段
3. **内置表**  
   按模型 id 子串/前缀匹配（大小写不敏感），见 §3.3
4. **全局默认**  
   `defaultContextLimit`，默认 **200_000**（Settings 可改）

解析结果带 `source: "override" | "cpa" | "builtin" | "default"`，供 hover 展示。

### 3.3 内置表（MVP）

保守、可扩展的默认（token 数）：

| 匹配（id 包含，不区分大小写） | limit |
|---|---|
| `claude` / `opus` / `sonnet` / `haiku` / `fable` | 200_000 |
| `gpt-4` / `gpt-5` / `o1` / `o3` / `codex` | 128_000 |
| `gemini` | 1_000_000 |
| `kimi` / `k3` / `moonshot` | 128_000 |
| `deepseek` | 128_000 |
| `grok` | 128_000 |
| 其它 | 走全局默认 200_000 |

表可在代码常量中维护；Settings 覆盖优先于表。

### 3.4 ratio

```
ratio = usedTokens / limitTokens   // limitTokens > 0
```

- 展示百分比：`Math.min(ratio, 9.99)` 格式化为整数或一位小数均可；**允许 >100%** 显示为 `112%`（不封顶为 100%，避免掩盖真实超窗）
- 进度条填充宽度：视觉上 cap 在 100% 满格，颜色走危险态

### 3.5 阈值

| 区间 | 视觉 |
|---|---|
| `ratio < 0.80` | muted / 正常 |
| `0.80 ≤ ratio < 0.95` | warn（黄） |
| `ratio ≥ 0.95` | danger（红） |

横幅触发：**首次** `ratio ≥ 0.80` 时展示（见 §5.2）。

---

## 4. 数据模型与持久化

### 4.1 Shared 类型（`packages/shared`）

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
  /** 从 CPA 解析到的窗口；未知则省略 */
  contextLimit?: number;
};
```

`SessionSummary` 增加可选：

```ts
contextUsage?: ContextUsage;
```

`TurnUsage` / `SessionUsage` **语义不变**。

### 4.2 Settings

在 `AppSettings` / `PublicSettings` 增加（均可进渲染进程，无密钥）：

```ts
/** 未知模型或表未命中时的窗口上限 */
defaultContextLimit: number; // default 200_000

/** 按模型 id 覆盖窗口上限 */
modelContextLimits: Record<string, number>; // default {}
```

MVP UI：Settings 中至少可改 **全局默认 200k**；单模型覆盖可用 JSON/简单列表或后续再做——若首版 UI 只暴露全局默认，单模型覆盖仍保留在 store 供后续，**解析逻辑必须支持** `modelContextLimits`。

推荐首版 Settings UI：

- 数字输入：`Default context limit (tokens)`，默认 200000
- （可选）只读说明：单模型覆盖可后续加；或简单 textarea `modelId=limit` 每行一条

### 4.3 会话归档

`sessions/index.json` 中每个 session 条目可带 `contextUsage`（与 `usage` 并列）。加载时校验数字有限且 `limitTokens > 0`，否则丢弃该字段。

### 4.4 CPA 模型目录

扩展 `CpaSupervisor.listModels()`（或新增 `listModelCatalog(): Promise<ModelInfo[]>`）：

- 请求仍为 `GET http://127.0.0.1:<port>/v1/models`
- 对每个 `data[]` 元素解析 id + context，字段候选（先到先用，正整数）：
  - `context_length`
  - `context_window`
  - `max_model_len`
  - `max_tokens`（仅当值 ≥ 1024 时采用，避免把 max_output 误当窗口）
  - 嵌套：`meta.context_length` / `metadata.context_length` 等常见形态可一并尝试
- 保留现有「优先无前缀别名」逻辑；**同一逻辑模型多条记录时**，优先带 context 的条目，或合并时保留已有 contextLimit
- 主进程内存缓存 `ModelInfo[]`；同步模型列表到 settings 时一并刷新缓存
- 无 token / CPA 未就绪：缓存为空，走内置表/默认

---

## 5. UI

### 5.1 标题旁 Context meter（`ChatPanel` header）

在现有 `session-usage` 账单行旁或下方，增加 **context meter**（有 `contextUsage` 时才显示）：

```
[████████░░] 76% · 98k/200k
```

- 细进度条 + 百分比 + `used/limit`（`formatTokens` 复用）
- 颜色按 §3.5
- `title`/tooltip：`modelId · source · used · limit · updatedAt`

与账单行并存，不互相替换。

### 5.2 横幅（≥80%，每会话一次）

当 `contextUsage.ratio ≥ 0.80` 且该会话尚未标记「已提示」：

- 在聊天区顶部（header 下、MessageList 上）显示可关闭横幅，例如：

  > 上下文已用 **82%**（98k / 200k）。接近窗口上限，建议新开对话或压缩历史。

- 关闭或点击确认后：将该 `sessionId` 记入「已提示」集合，**本会话不再展示**（即使后续 ratio 升到 95%+ 也不再弹；进度条颜色仍更新）
- **新会话**（新 id）重置，可再弹一次
- 应用重启后：若 session 仍有 `contextUsage.ratio ≥ 0.80`，是否再弹一次？  
  **决策：重启后可再弹一次**（「已提示」仅存渲染进程内存，不落盘）。若用户反感，后续再持久化 dismiss。

不阻断 Composer 发送。

### 5.3 无数据

- 无 `contextUsage`：不显示 meter、不显示横幅
- 仅有账单 usage、无 token：保持现有账单行

---

## 6. 数据流

```
启动 / Settings 同步模型
  → CPA listModelCatalog → 主进程 modelCatalog 缓存
  → settings.models 更新（现有行为）

每轮 SDK result
  → extractTurnUsage（现有）
  → accumulateUsage → SessionUsage（现有）
  → resolveContextLimit(modelId, settings, catalog)
  → computeContextUsage(used, limit, source, modelId)
  → SessionSummary.contextUsage = …
  → 落盘 index + 推送 renderer

Renderer ChatPanel
  → meter from active.contextUsage
  → banner if ratio≥0.8 && !dismissedThisSession[sessionId]
```

纯函数建议放 `packages/shared` 或 main 内可测模块：

- `resolveContextLimit(...)`
- `computeContextUsage(...)`
- `parseModelCatalog(json)`

---

## 7. IPC / 兼容

- 现有 `result` 事件可继续只带 `usage`；`contextUsage` 挂在 **session summary** 更新路径上（与 `usage` 累加同一处更新 summary 并广播）
- 若现有「sessions 列表/更新」已推 `SessionSummary`，无需新 channel
- 旧客户端无 `contextUsage` 字段：忽略即可

---

## 8. 测试

| 用例 | 期望 |
|---|---|
| 仅有 `input_tokens` | used = input |
| 无 input、有 cache 字段 | used = cache 之和 |
| 全无 token | 不写 contextUsage |
| limit 优先级 override > cpa > builtin > default | 命中正确 source |
| 默认 200k | 未知模型 ratio 用 200k |
| ratio 0.79 / 0.80 / 0.95 | 颜色档位 |
| 横幅 dismiss 后同会话再 result 仍 ≥80% | 不重弹 |
| 新 sessionId | 可再弹 |
| CPA JSON 多种 context 字段名 | 解析到 limit |
| 归档读写 contextUsage | 往返一致 |

---

## 9. 明确不做（YAGNI）

- 不阻断发送、不自动压缩 transcript
- 不引入本地 tokenizer / 不估算未发送草稿
- 不把 output 计入 used（除非后续产品改口径）
- 不把 SessionUsage 累计当窗口占用
- 不做多阈值自定义（固定 80% / 95% 档）
- 不做跨会话全局「永不提醒」

---

## 10. 实现落点（参考）

| 区域 | 文件（预期） |
|---|---|
| 类型 | `packages/shared/src/models.ts` |
| 解析/计算 | `packages/shared` 或 `electron/main/context-usage.ts` + 测试 |
| CPA | `cpa-supervisor.ts`（catalog） |
| 会话更新 | `session-manager.ts` result 分支 |
| 归档 | `session-archive.ts` |
| Settings | `settings-store.ts` + SettingsDrawer |
| UI | `ChatPanel.tsx`、`format-usage.ts`、`styles.css` |
| 状态 | 渲染侧 dismiss Set（store 或组件 state） |

---

## 11. 成功标准

1. 新开对话多轮后，标题旁可见 `xx% · used/limit`，与当前模型窗口一致（CPA 有字段时 source=cpa）
2. 人为/真实使 used/limit ≥80% 时出现横幅；关闭后同会话不再出现；进度条仍可变黄/红
3. 无 token 的模型/轮次不崩溃、不假装 0%
4. 现有 turn chip 与 session 账单行行为不变
5. `pnpm test` / `pnpm typecheck` 通过
