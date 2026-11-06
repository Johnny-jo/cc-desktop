# Claude Code 2.1.318 更新

2026-11-04：CC Desktop 内置 Claude Code 从 2.1.220 更新至 2.1.318，配套
Agent SDK 从 0.3.220 更新至 0.3.318，依赖与锁文件固定精确版本。
选择的是官方 latest 发布 2.1.318；当日 npm 的保守 stable 通道为 2.1.311。

官方发布：https://github.com/anthropics/claude-code/releases/tag/v2.1.318

## 准备与打包

`scripts/claude-release.json` 记录 SDK/CLI 配对。准备脚本从当前已解析 SDK
的 optional dependency 获取 Windows 二进制，不再扫描 pnpm 缓存并选取第一个旧包。
运行时开发依赖回退同样从 SDK 所在位置解析平台包。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:vendor:claude
pnpm verify:vendor:claude
pnpm --filter @claude-desktop/desktop build
pnpm --filter @claude-desktop/desktop dist:dir
```

`--claude-only` 保留 CPA。打包前验证 SDK 元数据、平台包版本、CLI --version
以及 vendor 与 SDK 原生程序 SHA256 一致；不符合则阻止打包。
vendor 和 Windows 包中的 2.1.318 哈希均为：

`b9aa5b08dc2cc46ea77d334dce792d1b8fdbb3a43bb290efdebdc905b1181082`

本次旧版二进制已备份在本机忽略目录 `tools/claude-backups/2.1.220/claude.exe`。
回退需要同时回退 SDK/锁文件和版本配对，不能只替换 exe。
应用主进程已加载的 SDK 需要重启后才切换到新版本。

## 验证

- 二进制选择回归 3 项；运行路径、会话、权限和 SDK 事件回归 208 项通过。
- TypeScript 类型检查、生产构建及 Windows 目录打包通过。
- SDK 0.3.318 + CLI 2.1.318 + 当前 CPA / DeepSeek 的真实验收通过：
  扫描 PDF 本地 OCR 后首次回复、关闭再恢复会话、读取合成文件的 Read 工具调用、
  canUseTool 权限回调均成功，三个会话 result 均为成功。
- `scripts/verify-pdf-model.mjs` 只使用合成 PDF 和临时测试文件，不读取用户文档。

未执行全模型提供商测试或生产业务文件准确率验收。
