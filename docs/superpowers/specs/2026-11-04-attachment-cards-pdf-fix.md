# 附件卡片与 PDF 拖入修复

用户确认范围：文件卡片排版不清楚，以及 PDF 拖入后报错。

## 原因与改动

- PDF 的传输分类为 binary，主进程已有 document/base64 发送通道，但单聊
  输入框把全部 binary 标为不支持。现在共享同一校验规则：PDF 10 MiB，
  图片和文本 5 MiB；主进程发送前使用实际磁盘大小重新校验。
- 未识别扩展名原先默认 text/plain，DOC/XLSX 会误读为 UTF-8。
  现在识别 Office MIME，其他二进制使用 application/octet-stream；
  不支持的正文格式显示明确转换提示并阻止误发，不向模型注入乱码。
- 文件卡片改为格式图标、单行截断文件名、友好的类型/大小和独立删除按钮。
  单聊、群聊共用；图片保留缩略图。附件区限高滚动，窄窗口不挤出发送按钮。
- 重复添加相同路径会去重；文件读取错误不会被后续校验清掉。
  附件不可读取时停止模型提交，已有会话发出失败结果以结束界面的处理中状态。

## 支持边界

- PDF 的选择/拖入、大小校验与文档请求构造沿用原通道；下述补充修复覆盖 DeepSeek 的模型请求兼容性。
- DOC/DOCX/XLS/XLSX 的正文解析没有在本轮新增；单聊明确提示转 PDF/TXT。
  群聊仍能传输普通文件给真人，其 Agent 读取限制保持原有边界。
- 本轮未接入外部解析服务、未新增 Office 解析依赖、未上传真实用户文件。

## 验证

- shared 附件测试 16 项，以及桌面附件读取、会话管理、群聊 UI 和跨节点附件
  集成回归通过。新增延续会话错误反馈用例单独验证。
- `node scripts/verify-composer-attachments.mjs` 使用真实 Electron File 对象、
  生产 preload 与文件读取 IPC，将 6,292,070 字节的有效测试 PDF 拖入输入框；
  验证去重、删除、10 MiB 超限阻断、五种文件标签及 420px 明暗主题布局。
- PDF 请求的 document/base64 内容与磁盘文件逐字节相同。模型边界为测试桩，
  本轮没有调用真实模型，不能将请求构造验证表述为模型内容理解验收。
- `node scripts/verify-room-chat.mjs` 的群聊样式、引用/@/附件发送与窄窗口回归通过。

## DeepSeek PDF 400 补充修复

用户实测错误：`.messages[31]: file must have a file_id or file_data`。
当前 CPA 8.0.43 将 Anthropic PDF document 转成 OpenAI 嵌套 `file.file_data`，
而当前 DeepSeek 文件输入接口不接收 PDF。仅验证本地 document/base64 构造不足以验收。

- 新增出站兼容层，在 Claude SDK → CPA 之间对 DeepSeek 请求中的 PDF 本地提取文字，
  输出保留页码的 text block。后续已接入应用自带本地 OCR，扫描页自动补识别，
  空白/无法识别页明确标记，不把空内容当成功；不包含图表视觉理解。
- 在出站边界处理完整 messages，因此同时覆盖新附件、旧 SDK 会话恢复，以及
  tool_result 内的 PDF。单聊与群聊使用相同 SessionManager，借用模型时保留
  既有目标端点、认证和流式响应。其他模型仍收到原始 PDF。
- 解析使用 PDF.js 6.5.438 和 PP-OCRv5 mobile，在独立子进程中执行。单文件限制
  10 MiB / 200 页 / 30 万字符，页面停滞 45 秒或整份超过 5 分钟失败；
  超过限制明确报错，不静默截断。提取结果最多在内存
  缓存 8 份，应用退出清理，不新增用户文档落盘副本或外部解析服务。
- 需要重启桌面主进程使兼容层生效；仅刷新渲染页面不会替换现有 SDK 进程。

PDF 兼容初版验收（2026-11-04，全部使用合成文件；最新 OCR 验收见同目录 local-ocr-design）：

- PDF 提取/兼容层 12 项测试通过，包含中文 CMap、页码、空页/扫描件提示、损坏
  文档、页数/大小限制、历史与工具结果转换、认证/查询参数/SSE、原生 PDF 保留。
- 附件读取、会话管理、群聊跨节点附件及借用模型回归 148 项通过；类型检查通过。
- `pnpm --filter @claude-desktop/desktop build` 和 `dist:dir` 通过。
- `node scripts/verify-pdf-model.mjs` 调用实际 CPA / `deepseek-v4-flash`：同一 PDF
  修复前 HTTP 400 且错误一致；修复后 HTTP 200，正确读出 CEDAR-731 / 24680 USD；
  带原始 PDF 的历史续问正确读出第二页验证码 59283。实际 SessionManager + Claude
  SDK 的首次发送、关闭再恢复会话均成功，两个 result 都为成功。
- `node scripts/verify-pdf-runtime.mjs` 在真实 Electron 中分别加载开发构建和
  Windows 打包 app.asar 内的 worker；两者均正确提取中文，验证依赖与 CMap 资源随包可用。

以上未使用用户报错的原始 PDF，不能据此保证任意扫描件或复杂版式均可理解。
