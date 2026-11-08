# AgentOS 在 Windows 接管任务的实现提案

调研日期为 2026-11-07。这份提案基于论文、官方文档、公开源码以及当前 ccDesktop 的会话接入代码。下节记录 AgentOS 原生执行器的实现和验证范围。

## 已实现的 Windows 系统执行层

在「设置 → 操控」开启桌面应用并保存，应用到当前会话或开启新会话。此页也可分别管理 Chrome 和 Edge 的网页操控。内置桌面服务由 Electron 通过 stdio 启动独立的 x64 Windows 执行器，使用系统自带的 .NET Framework、Win32 和 UI Automation。用户无需安装 Python、uv 或编译工具。下文的 Windows-MCP 是调研参考项目。

工具包括 `list_windows`、`observe_window`（支持分页）、`activate_window`、`invoke_control`、`set_value`、`select_item`、`click`、`type_text`、`shortcut` 和 `release_control`。一次观察绑定窗口和一页控件。物理点击使用绝对屏幕像素，要求窗口仍在原来的位置且实际命中目标。键鼠输入需要目标窗口位于前台。Windows 拒绝激活、控件提供程序失效或权限不足时，工具会报告失败。

普通权限会话首次操作需要管理员权限的窗口时，会请求 Windows UAC 和针对该窗口的确认。也可使用 `authorize_window_control({windowId})` 显式请求。授权完成后重新观察，再使用新凭据点击。授权只覆盖本次连接中指定窗口的观察、激活、点击和控件选择或调用。物理 Esc、释放控制或连接关闭会结束授权。用户拒绝后，本连接会停止对该窗口请求授权。

AgentOS 取得桌面控制权后，每个显示器四周出现缓慢起伏的柔光，右侧显示「AgentOS 正在控制你的电脑」和「按 Esc 退出」。黑色虚拟指针随控件操作或坐标点击移动，等待时停在最后的目标。完成后调用 `release_control`，空闲 45 秒后也会自动释放。单独读取窗口或截图时保持原桌面外观。

用户在截图识别或桌面接管期间按 **Esc** 可立即终止当前控制连接，原快捷键 **Ctrl+Alt+F10** 也可使用。退出后需要重新连接桌面 MCP 才能继续操控。

开发验证使用 `node scripts/verify-windows-computer.mjs`。它临时打开两个独立 WPF 测试窗口，通过实际 MCP 客户端验证控件操作、前台中文输入、坐标点击、快捷键、失焦拒绝、会话互斥及紧急停止，然后关闭窗口。传入 electron-builder 生成的 `win-unpacked` 目录可验证打包版。开发路径与 Windows x64 解包版均已实测。

## 通用窗口操作

正常入口为 `list_windows` → `inspect_window` → `act_on_target` → 核对回读结果。跨应用或出现新对话框时，重新枚举窗口，绑定目标窗口后继续。同一会话仍可使用底层键鼠、屏幕概览和窗口截图。

1. **查找目标。** `inspect_window({windowId, query: "保存", action: "activate"})` 优先搜索 UI Automation 控件的名称和 automationId。自动模式下有唯一、精确且支持所需动作的原生匹配时直接返回。没有匹配或匹配有歧义时，补充窗口 OCR 和图形证据。未指定查询时先返回当前控件层级。要查看尚不知名称的自绘区域，可传 `vision: "always"` 和 `includeImage: true`。大树采用有界读取，有更多原生控件时返回 `nextCursor`。
2. **区分候选。** 每个目标给出当前场景的 ID、名称、角色、物理屏幕边界、识别来源和能执行的动作。原生控件可以提供祖先路径。纯视觉目标可附带明确标作几何推测的容器提示。OCR 文字与轮廓可靠配对后，按位置和标签与原生控件关联。比较同名按钮时使用其所在窗口、路径和边界。如果同一位置的视觉文字和可操作原生控件明确异名，保留原生动作并禁止该冲突视觉点击。
3. **执行和核实。** `act_on_target({windowId, sceneId, targetId, action: "activate", verifyText: "已保存"})` 使用目标绑定的原生 Invoke、SelectionItem 或经像素复核的前台点击。也支持 `set_value` 和 `select`。一次动作尝试消费场景。工具返回实际使用的 `via` 和独立回读结果；`observed` 表示观察到指定文本，`not_observed` 或 `unavailable` 说明需要再检查。没有指定预期文本时，返回操作后的简短界面状态。输入已提交而结果尚未确认时，不应自动重放。
4. **更新与撤销。** 新观察、底层写操作和释放控制会使旧场景失效。每个连接串行执行操作。截图和前台接管沿用现有的紧急停止、物理坐标验证及窗口身份检查。

验收使用带两个同名按钮及一个中文自绘按钮的独立 WPF 窗口。开发路径和 Windows x64 解包版都通过实际 MCP 调用验证了目标融合、原生点击/赋值/选择、视觉点击以及预期文字出现和未出现两种结果。测试只对夹具操作。每次按名称查找最多读取三个原生分块，较大的树可继续翻页。回读文字用于核实界面反馈；涉及保存或导出时，还应根据任务要求核实最终文件。

## 首版体验

目标是接管当前 Windows 交互桌面。AgentOS 可以从桌面、任务栏、开始菜单或资源管理器出发，在多个应用和系统对话框之间完成任务。用户已确认当前链路可以传图，视觉步骤选择支持图片输入的多模态模型。

首个任务示例为「打开下载文件夹里的交接说明，在记事本末尾加上今天的日期，另存到桌面」。AgentOS 从桌面定位资源管理器，打开目标文件，切换到记事本，处理另存为对话框，最后核对文件位置与内容。任务卡显示当前应用以及前台键鼠是否正被占用，用户可随时停止接管。

## 三层职责

| 层 | 输入和输出 | 在“另存为”对话框里的作用 |
| --- | --- | --- |
| 1. Windows 系统接口与动作执行 | 使用 Win32 发现和激活窗口。通过 UI Automation（UIA）读取控件属性，调用控件支持的操作。需要坐标或快捷键时，向前台发送键鼠输入。 | 确认活动对话框，给文件名框赋值，调用保存按钮。自绘按钮只有屏幕位置时执行坐标点击。 |
| 2. OCR 与视觉定位 | 读取桌面或窗口截图。OCR 给出文字和边界框，图标检测器或多模态模型结合画面与任务辨认目标，输出候选区域。 | 界面只画了一个磁盘图标时，视觉模型可把该区域识别为候选保存入口。识别结果需要通过操作后的状态验证。 |
| 3. 桌面界面的结构化表示 | 从 UIA 的桌面根节点获取窗口与控件层级，再按需加入视觉目标。给每个目标分配本次观测的短编号，记录来源、所在窗口、边界和可用动作。 | 模型可指明“在这个另存为对话框里调用保存按钮 #12”，即使其他窗口也有同名按钮，执行范围依然明确。 |

这三层是工程职责。UIA 同时服务于第一层和第三层。UIA 提供的父子关系来自应用的可访问性接口，自绘区域的候选框、标签及归属来自画面推断。模型可用类似 HTML 的树形文本或 JSON 阅读它们。给截图上的候选区域加编号属于视觉标注，编号本身只能标识区域；父子关系和可调用能力应保留各自的依据。桌面树动态变化，每次只展开与任务相关的窗口或菜单。[Windows UIA 树](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview) · [UIA 控件能力](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview) · [OmniParser](https://github.com/microsoft/OmniParser) · [Set-of-Mark 论文](https://arxiv.org/abs/2310.11441)

执行顺序为：观察桌面和前台窗口 → 构造控件树，对缺失区域按需补充视觉识别 → 多模态模型选择目标和动作 → 执行器检查当前窗口及观测是否有效 → 调用控件或接管键鼠 → 再观察并核实结果。选择解析整桌面或局部截图取决于动作：找窗口用桌面概览，点对话框内的小图标用原分辨率的窗口区域。

黑色虚拟指针由 AgentOS 自己绘制。它只消费执行器产生的目标位置，动作结束后停留在最后一个有效位置，窗口移动时跟随目标窗口换算坐标。用户的鼠标移动不会更新它。普通控件如果支持直接调用，优先走控件接口。必须用前台键鼠时，由 AgentOS 在授权范围内完成。此期间使用的是同一个 Windows 输入桌面，独立绘制的指针只表示 Agent 的操作位置。

### 已实现的 OCR 与视觉定位

- **入口。** `observe_visual` 捕获指定窗口。PrintWindow 返回失败或单色图像时，自动尝试 Windows Graphics Capture 读取该窗口的合成画面。若打印调用超时，可在下一次观察时通过 `captureSource: "compositor"` 直接读取合成画面。要读取屏幕上实际可见的像素，可调用 `observe_display_visual({windowId})`，工具会选择窗口所在的显示器，只返回该屏与窗口相交的区域，其中可能有其他窗口遮挡。省略 `windowId` 时可以观察整屏。`region` 的单位是物理像素，窗口截图的裁剪起点相对窗口，显示器截图的裁剪起点相对显示器。返回的 `bounds`、文字框、形状框及 `point` 均为桌面绝对坐标。
- **文字和图像。** 独立子进程复用随包分发的 PP-OCRv5 mobile（两份权重合计约 20.4 MiB），通过 CPU 推理返回文字、置信度和位置。默认只返回结构化结果。选择支持图像输入的模型，传 `includeImage: true` 可让模型查看同一帧，处理无文字或有歧义的图标。较大的预览按原分辨率压缩，截图在内存传递，分析进程空闲一分钟后回收。
- **形状。** 首版在目标窗口或局部区域上做边缘、轮廓和矩形框检测，把文字框与周围的边框按包含关系配对。输出“矩形区域内有‘保存’”或“此处有一个无标签图标”等候选。UIA 的角色和可用操作优先用于确认它是不是按钮；无边框、同名控件或陌生图标有歧义时，请当前多模态模型看局部截图。
- **执行。** `inspect_window` 产生视觉画面时，会同时返回用于 `act_on_target` 的场景编号和用于坐标点击的 `observationId`。窗口截图和绑定窗口的显示器截图也会返回点击凭据。传给 `click` 的坐标是桌面绝对像素，通过图片定位时加上该帧 `bounds`（或 `imageBounds`）的左上角偏移。执行前再次检查前台窗口、实际命中窗口、几何、裁剪范围和同一截图来源的目标邻域像素。一次视觉点击尝试消费该观测。窗口移动、更换显示器或目标重绘后重新观察。未绑定窗口的整屏概览仅供读取。
- **验证。** 开发版和 Windows x64 解包版均用真实 WPF 自绘夹具完成中文 OCR、按钮轮廓定位、整窗与局部区域点击，以及从无字色块预览定位并点击。验证包含窗口移动、局部重绘、过期及跨窗口观测被拒绝。另在夹具内的小块屏幕区域核实了显示器坐标，并用合成图覆盖深色轮廓、负屏幕坐标和裁剪边界。

## 可借鉴的实现

| 来源 | 查到的机制 | 对 AgentOS 的选择 |
| --- | --- | --- |
| [OpenAI 官方 Computer use 指南](https://developers.openai.com/api/docs/guides/tools-computer-use/) · [集成示例](https://developers.openai.com/api/docs/guides/tools-computer-use-integration/) | Responses 模型提出有序动作，应用驱动执行并回传同一调用对应的屏幕状态。环境、权限和清理由应用负责。官方示例还独立检查最终状态。 | 模型决策与本机执行分开。原生 Responses 支持作为可选模型适配。 |
| [微软 UFO² 论文](https://www.microsoft.com/en-us/research/publication/ufo2-the-desktop-agentos/) · [控件执行源码](https://github.com/microsoft/UFO/blob/main/ufo/automator/ui_control/controller.py) | 论文结合 UI Automation、视觉定位和应用 API。源码中有设置焦点并按窗口坐标点击的路径。其 [UFO² README](https://github.com/microsoft/UFO/blob/main/ufo/README.md) 仍将隔离桌面的画中画标为 coming soon。 | 采用混合定位。把动作是否会抢焦点作为执行器的显式属性，独立桌面另行验证。 |
| [CursorTouch/Windows-MCP 发布版](https://github.com/CursorTouch/Windows-MCP/releases/tag/v0.8.8) · [启动入口](https://github.com/CursorTouch/Windows-MCP/blob/v0.8.8/src/windows_mcp/__main__.py) · [桌面操作实现](https://github.com/CursorTouch/Windows-MCP/blob/v0.8.8/src/windows_mcp/desktop/service.py) | 有可运行的 Windows stdio MCP、快照、截图和输入动作，启动器支持工具白名单。坐标点击会产生真实的桌面输入。 | 作为开发原型后端，把窗口绑定、AgentOS 指针、会话取消和打包交付作为集成工作。 |
| [Windows Agent Arena 论文](https://arxiv.org/abs/2409.08264) · [项目与评测方法](https://microsoft.github.io/WindowsAgentArena/) | 在 Windows 应用上执行任务，以结束后的系统状态评分。 | 用临时文件、已打开的窗口和文本内容判断成功。模型的完成提示只用于展示。 |

## 开发原型

在装有 uv 的 Windows 开发机上，可用以下命令启动固定版本的测试后端。stdio 进程应由测试客户端启动并连接。先枚举工具，再在专用测试窗口执行任务；工具白名单只限定工具类别，窗口范围仍需要 AgentOS 校验。版本和依赖见 [PyPI 发布包](https://pypi.org/project/windows-mcp/0.8.8/) 和 [版本配置](https://github.com/CursorTouch/Windows-MCP/blob/v0.8.8/pyproject.toml)。

```powershell
uvx --from windows-mcp==0.8.8 windows-mcp serve --transport stdio --tools Snapshot,Screenshot,Click,Type,Shortcut,Scroll
```

先在开发环境从已打开的空白记事本开始。正式交付时，建议把锁定并验证过的执行器及所需运行时一起打包，由桌面应用按需启动、结束时回收。用户沿用现有安装流程。

## 如何接入当前项目

1. **会话接入。** 沿用 `apps/desktop/electron/main/session-manager.ts` 向 SDK 注入 MCP 服务的入口。现有 browser 继续走 Playwright，新增受主进程管理的 `computer` 服务。桌面控制只提供给启用了该能力的本地会话，沿用现有权限代理和受限房间规则。普通 stdio 配置会直接透传，因此内置 computer 需要单独识别并在解析时检查范围。
2. **观察桌面。** 建议提供 `observeDesktop()` 获取显示器、前台窗口、可见窗口列表以及按需的桌面截图。再用 `observe(windowId)` 获取目标窗口的控件子树、视觉区域及观测编号。任务引起窗口切换或系统弹窗时重新发现目标。验证模型实际收到的图片分辨率及其与物理坐标的映射。
3. **执行动作。** `act(windowId, observationId, action)` 先校验会话控制权和窗口身份。控件支持 Invoke、Value、Selection 等能力时走对应接口。需要像素定位时使用当前窗口截图。将截图像素映射到屏幕物理坐标，复核缩放、窗口边界和实际命中窗口。窗口移动、焦点转移或控件过期时重新观察。来自网页、窗口或文档的文字只当作任务数据。[Windows UI Automation 控件规范](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview)
4. **接管与取消。** 全应用同时只给一个会话前台输入权。任务需要切换应用时，从当前桌面重新定位目标窗口，并绑定之后的输入。用户按停止时撤销控制权，取消待执行动作，释放按键和鼠标按钮。每次输入前复核控制权，避免上一条会话结束后仍然打字。遇到 UAC 安全桌面或权限等级阻止输入时，向会话返回具体原因。[Windows SendInput 限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
5. **回读与完成。** 一次点击可以触发异步保存。执行器在目标条件出现时返回，例如出现另存为窗口、文件可读且内容匹配。状态不明时先重新观察；像提交、发送、保存覆盖这样的动作不可盲目重放。历史消息以一次桌面任务作为一组，保留步骤摘要；截图按需传递，避免每次鼠标移动都成为一条聊天消息。

## 模型接法

首版优先让当前会话模型调用 MCP，沿用现有会话、CPA 及工具卡。视觉不可用时，仍可执行能从控件树定位并验证的任务。遇到必须识图的动作，明确返回缺少的模型能力，由已配置、获准使用的视觉路由继续。

如果接 OpenAI 原生 computer 工具，适配层读取 `computer_call.actions[]`，依次执行允许的动作，再用相同 `call_id` 回传含新截图的 `computer_call_output`。保持同一环境会话，按 API 要求处理待确认的安全检查。这个适配需要支持该工具的 Responses 模型及路由，普通函数调用成功无法验证这项能力。[OpenAI 官方动作循环](https://developers.openai.com/api/docs/guides/tools-computer-use/)

## 验收顺序

| 场景 | 可检查的结果 |
| --- | --- |
| 记事本输入中文并另存为 | 指定测试目录里生成预期文件，读回文字逐字匹配。 |
| 从资源管理器打开交接说明，切换到记事本并另存到桌面 | 同一会话完成跨应用操作，原文件保留，桌面副本可打开且末尾日期正确。 |
| 目标突然移动、弹窗或切换显示器 | 旧图坐标失效并重新定位，旁边的测试窗口未被写入。覆盖 100%、150% 缩放和副屏负坐标。 |
| 停止控制或两个会话同时请求前台 | 停止后排队输入被取消，同一时刻只有一个会话可注入前台输入，虚拟指针与用户鼠标保持独立。 |
| 自绘控件无法从 UIA 定位 | 有视觉能力时能用截图定位并验证状态变化。缺少视觉能力时返回可解释的阻塞状态。 |

主要落地风险是不同应用的可访问性支持、视觉定位精度，以及随包运行时在干净 Windows 机器上的兼容性。上面的场景需要用真实应用验证后，再确定支持列表和交付范围。
