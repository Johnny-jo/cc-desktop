# 上下文长度设置与多格式文件路线图

**日期：** 2026-08-07  
**状态：** 设计已获用户批准（待用户审查书面规格 → 实现计划）  
**范围：**  
1. **一期（本规格可实现部分）**：Settings 内嵌「多模型上下文长度」列表  
2. **二期 / 三期（路线图）**：多格式附件发送、分类预览 / 外链打开  
**前置：**  
- `packages/shared/src/context-usage.ts` 已提供 `resolveContextLimit` / `computeContextUsage`  
- Settings 已有 `defaultContextLimit`、`modelContextLimits`  
- WIP Settings 仅「当前默认模型」单输入框 override（将被表格取代）  
- 附件：文本扩展名集 + 图片 + PDF（`attachments.ts` / `attachment-reader.ts`）

---

## 1. 背景与目标

用户需要：

1. **自由配置上下文长度**——不仅全局默认，还要能按模型看到/改 override  
2. **规划开放多种文件格式**，并按类型决定：发给模型怎么读、应用里怎么看  

这两块工作量与风险不同，**分三期**交付；本规格对一期写到可实现粒度，二/三期只定分类与边界，避免一期膨胀。

### 1.1 已确认决策

| 项 | 决策 |
|---|---|
| 分期 | 一期：context limit 设置；二期：附件发送扩展；三期：预览/外链打开 |
| 一期 UI | Settings **内嵌表格**（非独立 Tab、非仅顶栏快捷） |
| 模型行来源 | `settings.models` ∪ CPA catalog id（去重），**不可**手填任意 id |
| 保存后生效 | **仅下一 turn / 新会话** 的 meter；不强制即时重算当前会话 |
| limit 优先级 | 不变：`override` → `cpa` → `builtin` → `default` |
| 代码类打开（三期） | **系统外链** VS Code / 默认编辑器；不内嵌 Monaco |
| txt / md（三期） | 应用内直接展示 |
| 其它办公/二进制（三期） | **不内嵌排版预览** |

---

## 2. 分期与成功标准

### 2.1 一期 — Per-model context limits（实现范围）

**成功标准**

1. Settings 展示已知模型列表；每行可设 / 清空 override  
2. 仍可编辑全局 `defaultContextLimit`  
3. 每行 **Effective** 显示解析后的 limit + 来源徽章（`override` | `cpa` | `builtin` | `default`）  
4. 保存后下一轮 turn 的 `ContextUsage.limitTokens` / `ratio` 使用新配置  
5. 保存时 **不删除** 其它模型已有 override；清空某行仅删除该 key  
6. 校验：有值的 override 与全局默认均在 `[1024, 10_000_000]` 的有限整数  

**一期明确不做**

- 当前会话 meter 即时重算  
- 手填任意 modelId  
- 任何文件格式 / 预览 / 外链改动  
- Settings 拆 Tab  
- 改变 `resolveContextLimit` 优先级语义  

### 2.2 二期 — 附件发送扩展（路线图）

目标：用户列出的格式可进入 Composer，主进程按类型产出合理 `UserContentBlock`（或明确拒绝并提示）。

### 2.3 三期 — 打开 / 预览（路线图）

目标：按文件类决定应用内展示 vs 系统打开；代码类外链编辑器。

---

## 3. 一期详细设计

### 3.1 数据模型

沿用现有字段，**不新增** settings schema 键名：

```ts
// AppSettings / PublicSettings（已存在）
defaultContextLimit: number;              // 全局兜底，默认 200_000
modelContextLimits: Record<string, number>; // modelId → override tokens
```

- `modelContextLimits` 只存 **用户显式 override**；「auto」= key 不存在  
- 持久化：`settings-store` 已 merge / 读写该字段  

### 3.2 模型行集合与 CPA catalog 暴露

**现状缺口：** CPA `ModelInfo[]`（含 `contextLimit`）仅缓存在 main 的 `CpaSupervisor`；renderer 的 `syncCpaModels` 只把 **id 列表** 写进 `settings.models`，**不**带 context 字段。因此 Settings 要正确显示 `source: "cpa"` 的 Effective，一期必须增加只读暴露。

**一期必做 IPC（最小）：**

```ts
// preload + ipc-handlers
getModelCatalog(): Promise<ModelInfo[]>  // 转调 cpa.getModelCatalog()
```

- 不把 catalog 持久化进 settings.json  
- Settings 打开时、以及用户点「Sync models from CPA」成功后，各拉一次 catalog 进组件本地 state  
- 若 CPA 未就绪 / 目录为空：catalog = `[]`，Effective 回落 builtin/default  

打开 Settings 或刷新 form 时计算行：

```
modelIds = unique_sorted(
  settings.models
  ∪ catalog.map(m => m.id)
)
```

约束：

- 不提供「添加自定义 modelId」输入  
- Models CSV 仍是编辑 `settings.models` 的入口；表格行随 CSV / 同步 CPA 更新  
- 若某 override 的 key **不在**当前 modelIds 中（历史残留）：  
  - **保留**在 `modelContextLimits` 中（不静默删除）  
  - 一期 UI **可不展示**孤儿行；实现时在保存逻辑中 **不得** 用「仅表格可见行」整表替换导致孤儿丢失  
  - 推荐保存算法见 §3.5  

### 3.3 Effective 列计算

对每一行 `modelId`，调用已有：

```ts
resolveContextLimit(modelId, {
  defaultContextLimit,
  modelContextLimits: draftOverrides, // form 中的 draft，含未保存编辑
}, catalog)
```

展示：

| 展示 | 示例 |
|---|---|
| 数值 | **整数 tokens**（如 `256000`），与输入框单位一致；不强制 `256k` 缩写 |
| 来源徽章 | `override` / `cpa` / `builtin` / `default` |

用户改 override 输入框时，**本地 draft** 立即反映到 Effective（无需 Save），便于预览；真正持久化仍在 Save。

### 3.4 SettingsDrawer UI

**替换** WIP 的单一字段 `modelContextLimit`（当前默认模型一个输入框），改为：

1. **Default context limit**（保留现有 number 输入 + 校验提示）  
2. **Per-model context limits** 区块  
   - 表头：`Model` | `Effective` | `Override`  
   - 每行：只读 model id、Effective 文本+徽章、Override `<input type="number">`  
   - Override 空字符串 = auto  
   - 模型较多时：区块 `max-height` + 内部滚动，避免撑破整个 Drawer  
3. 文案提示（英文或中英一致于现有 Settings 风格）：  
   - 清空 Override 即恢复 CPA / 内置 / 全局默认链  
   - 更改在下一轮对话后反映到 context meter  

**Form 状态**

```ts
type FormState = {
  // …existing fields…
  defaultContextLimit: string;
  /** modelId → override 字符串；缺 key 或 "" = auto */
  modelContextLimitDraft: Record<string, string>;
};
```

从 settings 初始化：

```ts
modelContextLimitDraft: { ...Object.fromEntries(
  Object.entries(s?.modelContextLimits ?? {}).map(([k, v]) => [k, String(v)])
)}
```

行编辑：只更新 `modelContextLimitDraft[modelId]`。

### 3.5 保存语义

Save 时：

1. 校验 `defaultContextLimit` ∈ [1024, 10_000_000]  
2. 构建 `nextOverrides: Record<string, number>`：  
   - **起点** = 当前已持久化的 `settings.modelContextLimits`（保留孤儿 key）  
   - 对每个 **表格可见** `modelId`：  
     - draft 为空 / 仅空白 → `delete nextOverrides[modelId]`  
     - 否则解析整数，校验范围，`nextOverrides[modelId] = floor(n)`  
3. `saveSettings({ defaultContextLimit, modelContextLimits: nextOverrides, …其它字段 })`  
4. 成功后清空 token 输入、显示 Saved；失败显示错误  

**禁止**：`modelContextLimits = {}` 再只写入当前可见行（会抹掉孤儿与未展示 key）——除非显式产品要「重置全部」。

### 3.6 生效路径

```
Save → settings-store 磁盘
     → PublicSettings 回传 renderer store
下一 turn result → computeContextUsage({ settings: 最新, catalog, turn })
                 → SessionSummary.contextUsage 更新 → meter
```

- 不新增 IPC  
- 不在 Save 时遍历 sessions 重写 `contextUsage`  
- auto-compress 阈值仍基于 ratio；limit 变大/变小只影响**之后**算出的 ratio  

### 3.7 与现有 WIP 的关系

| WIP 项 | 一期处理 |
|---|---|
| Settings 单模型 `modelContextLimit` | **删除**，并入表格 draft |
| merge 修复（不清空其它模型） | **保留并扩展**为 §3.5 算法 |
| `/compact`、auto 权限、compressor 增强 | **不在本规格范围**；可独立提交 |

### 3.8 测试计划（一期）

| 层 | 用例 |
|---|---|
| shared（已有可补） | `resolveContextLimit` 四档优先级；override 清空后回落 |
| settings-store | patch `modelContextLimits` 深合并 / 整表替换语义与现实现一致则加回归 |
| Settings 逻辑（可抽纯函数测） | draft → nextOverrides：改一行、清空一行、孤儿 key 保留 |
| 手动 | 改 k3 override → 新会话/新 turn meter 分母变化；清空后恢复 |

---

## 4. 二期 / 三期：文件格式路线图

### 4.1 分类表

| 类 | 扩展名（用户点名 + 合理并集） | 二期：发给模型 | 三期：查看 |
|---|---|---|---|
| **代码** | `py`, `java`, `cpp`, `c`, `h`, `hpp`, `go`, `sql`, `yml`, `yaml`, `xml`, 以及现有 `js/ts/tsx/…` | 按 **text** 读入（UTF-8，限大小，超限拒绝） | **外链** VS Code（`code`/`code.cmd`）或系统默认编辑器；失败则提示安装/配置 |
| **纯文本可预览** | `txt`, `md`（`markdown`） | text 读入 | **应用内**只读展示（md 可渲染或纯文本，实现时二选一并写死） |
| **办公文档** | `doc`, `docx`, `xls`, `xlsx`, `xlx`, `ppt`, `pptx` | **不**内嵌 Office 渲染；二期需单独定：抽取纯文本 / 或暂不支持并明确错误 | **不**应用内排版预览；可选「用系统默认应用打开」 |
| **PDF** | `pdf` | 保持现有 document/base64 路径（限大小） | 不内嵌完整排版；可系统打开 |
| **图片** | `png`, `jpg`, `jpeg`（可保留现有 gif/webp） | 现有 image base64 block | Composer/消息缩略图可保留；大图系统打开可选 |

说明：

- 用户写的 `xlx` 按扩展名接受；若无法识别为 Excel，二期归 **办公** 并走同一拒绝/抽取策略  
- **二期不实现** Office 二进制原样塞进 text（会污染上下文）  

### 4.2 二期实现要点（预告，非一期任务）

- 扩展 `TEXT_EXTENSIONS` / `guessMimeType` / `attachmentKindFromMime`  
- 办公类新增 `AttachmentKind` 或子类型（如 `office`），避免被误当 text  
- `attachment-reader`：按 kind 分支；office 未实现抽取前 **显式 error**  
- Composer `accept` 与拖放白名单对齐  
- 单测：扩展名 → kind；超限；office 拒绝文案  

### 4.3 三期实现要点（预告）

- IPC：`shell.openPath` / `shell.openExternal` 或 `code <path>`（Windows 优先 `code.cmd`）  
- 代码类：工具卡 / Changes / 附件芯片提供「在编辑器中打开」  
- txt/md：只读预览面板或轻量 Modal  
- 办公/PDF：仅「系统打开」，不做嵌入式 Word/Excel  

---

## 5. 架构边界（一期）

| 单元 | 职责 | 依赖 |
|---|---|---|
| `resolveContextLimit`（shared） | 纯函数：modelId + settings + catalog → limit/source | 无 UI |
| `getModelCatalog` IPC | renderer 只读 CPA 缓存目录 | CpaSupervisor |
| SettingsDrawer | 展示表格、draft、校验、调用 saveSettings | store settings + catalog state |
| settings-store | 持久化 `modelContextLimits` | 磁盘 |
| session-manager / computeContextUsage | turn 结束写 ContextUsage | 最新 settings + main 侧 catalog |

Renderer 仍不接触 token；context limit 配置不含密钥。

---

## 6. 错误处理（一期）

| 情况 | 行为 |
|---|---|
| override 非数字 / 越界 | Save 拦截，行级或顶栏错误，不写盘 |
| 全局 default 越界 | 同上 |
| CPA catalog 为空 | 表格仅 `settings.models` |
| models 列表为空 | 沿用现有「Models list cannot be empty」 |

---

## 7. 非目标汇总

- 一期不做文件格式、预览、VS Code 内嵌  
- 不做「上下文长度」与「计费 SessionUsage」混算  
- 不改变 80% 横幅 / auto-compress 阈值公式（仅分母来源可被 override 影响）  
- 不引入云端同步 settings  

---

## 8. 实现顺序建议（供 writing-plans）

1. 抽出 `buildModelContextLimitsPatch(existing, visibleIds, draft) → Record<string, number>` 纯函数 + 单测  
2. 增加 `getModelCatalog` IPC / preload / 类型  
3. SettingsDrawer：拉 catalog；form 改为 draft map；渲染表格；Effective 用 `resolveContextLimit`  
4. 删除单模型 `modelContextLimit` 字段  
5. 手动验证 Save + 新 turn meter  
6. （可选后续 PR）二期附件扩展规格细化  

---

## 9. 开放问题（二期再决，不阻塞一期）

1. Office：是否做本地文本抽取（依赖库 / 外置工具），还是一期后长期「仅系统打开、不发给模型」？  
2. md 预览：Markdown 渲染 vs 纯文本  
3. 「在 VS Code 打开」找不到 `code` 时的安装引导文案  
