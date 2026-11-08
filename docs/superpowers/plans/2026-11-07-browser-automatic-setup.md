# 浏览器自动准备与黑色指针

用户要求虚拟鼠标改为黑色，周围有小圈虚化，并在连接日常 Edge/Chrome 时自动安装所需扩展。延续已批准的日常浏览器方案及 10 字内会话标记。

## 实施

- [x] 指针使用黑色箭头、细白描边和小范围柔光；光圈不接收输入，与箭头同步移动，点击动画保持。
- [x] 新增独立 CommonJS 扩展准备模块和 45 项合成单测：检测所选配置的扩展状态，通过 Windows 当前用户的外部扩展登记机制登记固定官方扩展和更新地址，打开所选浏览器的正确配置，返回明确的待下载/待启用/已就绪状态。
- [x] MCP 第一次实际连接时自动准备缺失扩展；已安装的连接不重复操作。设置页增加自动检测/安装入口和两秒状态轮询，替换“请自行安装”流程。IPC 校验浏览器及配置目录，不接受任意扩展、更新 URL 或命令。
- [x] 运行相关单测、类型检查、构建及真实临时 Edge 视觉/控制回归；验证固定登记参数与真实本机状态。Windows 浏览器要求的启用确认保留，未获确认不得报告已启用。无需企业强制安装策略或篡改浏览器配置。

## 官方依据

- Chrome 外部安装：https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
- Edge 外部安装：https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options
- Chromium 当前用户登记读取实现：https://chromium.googlesource.com/chromium/src/+/refs/tags/146.0.7676.0/chrome/browser/extensions/external_registry_loader_win.cc

## 完成边界

应用负责检测、登记、启动和安装状态反馈；浏览器强制的一次启用确认属于浏览器交互。合成测试验证命令白名单和幂等，真实浏览器仅依据检测结果显示状态，不把“已登记”当成“已安装”。

## 验证结果（2026-11-07）

- 自动准备模块 45/45，安装 IPC 4/4，设置表单 4/4；浏览器控制、资料查询、会话管理和共享配置相关回归通过。
- Desktop 与 shared 类型检查通过，Electron/Vite 构建通过。
- 临时 Edge 的初始指针、iframe、会话标记、刷新、撤销和同页重新接管回归通过；已保存黑色鼠标与柔光的局部截图。
- 本机 Edge `Profile 2` 已通过固定 HKCU 外部登记路径完成准备，状态仍为 `pending-download`，未声称已启用。浏览器可能需要完整退出并重启以处理安装。
- 在独立新启动的临时 Edge 配置中，约四秒内实际出现官方扩展 manifest，证明本机 Edge 156 能处理当前用户的自动安装登记；探测浏览器和临时目录已清理，未关闭日常浏览器。
- 独立审查发现并修复现代 Chromium 无 state 字段的启用判断、已就绪安装被无关注册表错误阻断及非中英文 Windows 的首次登记兼容性；复核未遗留 Critical/Important。
