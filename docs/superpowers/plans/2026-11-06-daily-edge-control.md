# 日常 Edge 控制实现计划

> 使用 subagent-driven-development 执行已批准的设计。当前用户明确指定并正在运行 `agentos-foundation`，在此检出中实现和验证，避免额外工作树影响运行路径。

**目标：** 连接日常 Edge，提供历史/书签查询，并在受控网页显示立即可见的虚拟指针和 `AgentOS：<10 字内对话概括>`。

**架构：** 沿用已固定的 Playwright MCP，日常模式由官方扩展建立连接；独立模式保留。只读资料查询独立封装；控制器统一处理标记与撤销。

**技术栈：** TypeScript、CommonJS 资源脚本、Node SQLite、Playwright MCP、Vitest。

## 任务

- [x] 配置与标题传递：共享配置、设置表单与 MCP 解析器保存连接模式和配置目录，会话入口传递对话标题；官方扩展安装链接通过固定地址 IPC 打开系统浏览器。
- [x] 只读浏览器资料：新增 `browser-data.cjs` 与 50 项合成数据测试；历史通过一致的临时 SQLite 快照查询，关键词与条数有边界，原资料不变。
- [x] 页面指示器与连接：日常扩展和独立模式均已接线；控制条、网页标题和连接名使用 10 字内摘要，初始指针可见，iframe 点击可追踪，同页再次接管能替换旧指示器。
- [x] 代码验证与审查：210 项相关单测、两包类型检查、Electron/Vite 构建通过；真实临时 Edge 验证初始指针、iframe 点击、标题更新、刷新、跨标签撤销和同页重连。独立审查未遗留 Critical/Important 问题，临时 CDP 断开重连验证页面保留及绑定替换。
- [ ] 用户侧扩展安装及首次共享：本机 Edge `Profile 2` 尚未安装官方 Playwright 扩展。电脑操作工具因无法可靠确认当前浏览器 URL 而停止，未继续页面输入；由用户在日常 Edge 打开官方商店入口安装并选择共享标签页，再验收真实扩展连接。

## 关键命令

```powershell
# 使用已安装 Node 24 和工作区已有 CLI，避免 Codex 的 pnpm 回退版本差异。
node apps/desktop/node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts
node packages/shared/node_modules/vitest/vitest.mjs run packages/shared/src/mcp-servers.test.ts
# 在 apps/desktop 目录执行：
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/electron-vite/bin/electron-vite.js build
# 在仓库根目录执行：
node scripts/verify-browser-control.mjs --browser=msedge
```

## 完成条件

配置不会丢失日常模式/配置目录；标题和指针在第一步交互前就可见；取消后无法继续调用浏览器和资料工具；历史/书签查询不修改原资料；日常浏览器连接失败会提示扩展安装而非静默退回无登录状态的窗口。

## 2026-11-06 验证记录

- Desktop 定向测试 64/64，会话管理回归 114/114，共享 MCP 配置 32/32。
- `scripts/verify-browser-control.mjs --browser=msedge` 通过；同页重连、iframe 和站点动态修改标题的回归均覆盖。
- 已只读查询用户指定 Edge `Profile 2` 的历史和书签各一条，仅输出可读状态及条数，未输出访问地址或书签内容。
- 浏览器扩展缺失，真实日常浏览器登录态接管仍需安装后验证；未把临时页面测试表述为真实扩展端到端验收。
