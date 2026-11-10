# Computer use 补齐实现计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 分任务实现，按 test-driven-development 验证新增行为，最后做规格与代码质量审查。

**目标：** 为现有电脑工具补齐浏览器 CDP、连接租约/释放、独立只读结果验证以及 Windows 滚动和拖拽。

**架构：** 沿用 Playwright MCP 和 Windows UIA/OCR 执行器。设置层只增加连接配置；浏览器包装层负责资源所有权、租约和结果观察；Windows 原生层沿现有窗口/坐标/输入权限边界增加动作。Provider/认证本轮只保留研究资料。

**技术栈：** TypeScript、CommonJS、Playwright MCP 0.0.84、C# Windows helper、Vitest。

用户已确认先完成 computer use；设计来源为 Alma 静态对比后的 `拟补齐方案.txt`。当前工作区含用户已有 provider 等未提交改动，保留该基线，不回滚、不混入提交。

## 任务 1：CDP 配置与界面

文件：`packages/shared/src/mcp-servers.ts`、`apps/desktop/electron/main/playwright-mcp.ts`、设置页及其相关测试。

- [x] 写失败测试：`connection:'cdp',cdpEndpoint:'http://127.0.0.1:9222'` 校验和往返保留；拒绝缺少地址/非法协议/嵌入凭证；legacy extension 和 isolated 不变。
- [x] 运行 shared 和 resolver 目标测试确认缺少 CDP 功能导致失败。
- [x] 增加 CDP 类型/校验/清洗。仅 CDP 传第5个运行时参数：`[browser,'cdp',sessionTitle,'',cdpEndpoint]`；不传扩展授权store，不处理profile。
- [x] 设置表单按连接模式显示 endpoint；旧配置不丢失，CDP 不触发扩展安装和profile授权。
- [x] 跑目标单测、设置交互测试、shared/desktop类型检查。

## 任务 2：浏览器所有权、租约、验证

文件：`apps/desktop/resources/playwright-mcp/control.cjs`，新增聚焦的连接/租约/验证模块和 `electron/main/*browser*.test.ts`。

- [x] 写失败测试：CDP 使用现有context；取消/dispose只断开attached连接并保留已有页面；isolated关闭自己创建的context/browser。
- [x] 写失败测试：同资源的两个 MCP 进程互斥，同连接调用串行，取消中的排队操作不执行；进程退出释放租约，失效连接拒绝后续动作。
- [x] 实现 CDP 接线：`config.browser.cdpEndpoint`/对应上游参数；区分 extension profile 与 attached context，复用上游 `createBrowserWithInfo`。
- [x] 增加跨进程租约：按规范化CDP地址或extension profile标识资源。使用OS自动释放的独占句柄，避免仅靠内存计数或过期时间强抢仍活跃连接。isolated连接互不阻塞。
- [x] 增加 `browser_release_control`；初始化失败、取消、EOF、SIGTERM、dispose全部释放租约和指示器。
- [x] 增加只读 `browser_verify`：URL/可见文本条件，返回 `observed|not_observed|unavailable`、页面、URL、观察时间，验证失败不重放写动作。
- [x] 截图返回页面/URL、viewport、像素尺寸/scale/时间元数据；继续复用上游动作后快照。
- [x] 运行相关Vitest；真实CDP验收仅启动独立测试profile，并验证断开后浏览器/原有页面仍存活。

## 任务 3：Windows 滚动与拖拽

文件：`apps/desktop/resources/windows-computer/` 原生/JS协议与工具注册、相关 `windows-computer-*` 测试。

- [x] 写失败测试：滚动/拖拽必须有现有授权与新鲜场景，起终点窗口匹配；拒绝跨窗口/超范围/撤销后动作。
- [x] 原生滚动使用现有物理坐标与输入lease，支持垂直和水平滚轮，有界有限数值校验。
- [x] 拖拽沿现有SendInput路径执行；检查起终点和当前前台窗口，取消/异常在finally释放鼠标按键。
- [x] JS/MCP暴露参数与原生协议一致；提升窗口连接明确拒绝未获支持的动作，不绕过ScopedWindowBroker。
- [x] 动作沿现有独立回读给出结果；不因验证失败自动重试滚动/拖拽。
- [x] 跑单测和C#构建；可行时用专用测试窗口验收，不操作用户日常窗口。

## 任务 4：集成与交付

- [x] 审查连接/动作所有权和取消竞态；检查未知状态不变成已验证成功。
- [x] 运行 scoped Windows、browser、resolver、settings相关测试和类型检查；按具体失败补充必要测试。
- [x] 更新使用说明及AgentOS的研究资料，区分已实现与未验证平台行为。
- [x] 交付精确改动、测试结果、实际限制，不声称未做的真实账号/桌面验证已通过。

测试运行时使用本机已安装Node，命令形如：

```powershell
& 'D:\Alma\alma-server\runtime\node.exe' 'D:\gitRep\ccDesktop\apps\desktop\node_modules\vitest\vitest.mjs' run electron/main/playwright-mcp.test.ts
```

需要本机HTTP/跨进程IPC的测试在允许该能力的测试环境执行；使用模拟凭据和独立浏览器profile。
