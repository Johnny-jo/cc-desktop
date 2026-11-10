# Provider 模型信息与使用统计

目标：同步真实推理档位；只在展示层移除账号前缀；仪表盘以 token 用量和推理请求成功率为主，提供近 24 小时、7 天、30 天曲线。

实现边界：

- [x] 模型发现保留 reasoningEfforts/defaultReasoningEffort；上游目录优先，公开 API 缺少字段时只使用有官方依据的精确模型能力表。内部 Provider/model ID 与设置键不变。
- [x] 将原生 Messages JSON/SSE 响应以有背压的流观察器透传，合并累计 usage，区分成功、HTTP/流错误、用户取消，不缓存聊天正文。
- [x] SQLite 持久化每次推理的结束时间、Provider、结果与实际 token 数，保留 35 天；不记录鉴权/目录查询，不伪造历史。
- [x] input 为非缓存输入；总 token = input + output + cache read + cache creation，归一化避免缓存重复计数。未上报/取消可能不完整，界面明确说明。
- [x] 成功率 = success / (success + failure)，取消单列；没有有效分母的桶为 null。按 24/7/30 个滑动窗口桶汇总，并按 Provider 筛选。
- [x] 新 usage IPC 与限频刷新事件，SVG token/成功率曲线、统计起始时间和无历史空态、测试筛选/竞态/刷新/取消。
- [x] 运行相关回归、共享与桌面类型检查、构建及独立审查；全量回归沿用此前已记录的 Windows 管道测试限制。

验收结果（2026-11-10）：

- desktop：148 个测试文件、2205 项测试通过；仅排除前次已单独复现、未改动的 `windows-computer-scoped-broker.test.ts` 管道错误。
- shared：19 个测试文件、261 项测试通过；desktop/shared TypeScript 检查通过。
- OCR 完整性与 Electron 主进程/preload/renderer 构建通过。
- 真实捆绑 CLI 默认工具请求经本机假上游、协议适配器和用量观察器成功返回 `OK`，只记录一次 success / 10 input / 1 output，未调用真实账号或外部推理服务。
- 实际浏览器验证暗色及 480px 亮色布局，切换时间/Provider 查询参数正确，键盘 tooltip 可见，无页面 JS 错误或横向溢出。布局截图使用示例数据，不是用户实际消耗。
- 独立只读审查未发现阻断项；补齐元数据未变 ID 时的更新事件监听，以及 Responses 中 xhigh/max 原样发送。

数据界限：统计从本地数据库首次启用时积累，旧请求不回填。失败/取消时未传达到 Messages 响应的 usage 不估算，完整无上报单列缺报数。没有生成新安装包。
