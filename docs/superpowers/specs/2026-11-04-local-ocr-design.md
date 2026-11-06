# CC Desktop 本地 OCR 兜底

用户已确认将上一轮实测的 PP-OCRv5 mobile 模型嵌入 CC Desktop。

## 行为

沿用先提取文字、逐页 OCR 兜底的方案。DeepSeek 的 PDF 出站转换对没有文字、
文字损坏、只有少量文字且有图片的页面启用本地 OCR。完整文字层直接保留；
OCR 结果标注页码与来源，低置信度文字明确标记，无法识别不默认为成功。
支持原生 PDF 的其他模型仍使用原通道。

采用应用自带 ONNX 检测、识别模型和字典，总计约 21.4 MB，固定 SHA256。
使用固定版本 paddleocr.js / ONNX Runtime CPU，最多 4 个计算线程。
不引入 Python、GPU 或在线 OCR；不依赖原 x-bidding-desktop 安装目录。

## 隔离与生命周期

将现有 PDF 工作线程升级为独立解析子进程，Electron 使用 utilityProcess，
Node 验收工具使用 fork。模型首次需要 OCR 时才加载，后续页和文件复用；
Electron utilityProcess 内使用 Node 工作线程，确保 PDF.js 选择 Node 渲染工厂；
原生崩溃仍隔离在子进程。部署依赖由 electron-builder 自动解包，避免手写
asarUnpack 匹配器对 pnpm 工作区链接产生错误。
空闲 60 秒释放，退出/取消/解析超时可终止进程，避免原生推理拖住桌面。
每次只处理一个文档。保留 10 MiB / 200 页 / 30 万字符限制，渲染限制像素数，
单页无进度 45 秒或整个文件超过 5 分钟明确失败。

PDF 页面图片只保留在内存；不写入 photo-flow、剪贴板或群聊缓存。
提取文字延用出站代理的最多 8 份内存缓存；退出应用释放。

## 打包

模型放在 apps/desktop/resources/models/ocr/ppocr_v5_mobile，构建时校验哈希，
Windows 包复制到 resources/models/ocr/ppocr_v5_mobile。ONNX 原生依赖解包到
app.asar.unpacked；保留模型来源和许可证。模型缺失/损坏显示修复安装提示。

## 实现顺序与验收

1. 纳入模型资源、固定推理依赖、校验脚本及打包规则。
2. 实现独立解析进程及按页 OCR；保留历史 PDF 和群聊借用模型兼容。
3. 测试文字层保留、中文扫描件、混合页、空白/低置信度/错误提示、进程退出。
4. 实测开发 Electron 与 Windows 打包环境，确认无外部模型路径依赖。
5. 使用合成扫描 PDF 经当前 CPA / DeepSeek 完成首次及恢复会话续问。

本轮不新增方向分类、表格结构识别或图表理解模型。

## 已完成验收（2026-11-04）

- 173 项相关测试通过：本地模型校验、实际 CPU 扫描页识别、混合 PDF 原文保留、
  页码/低置信度、子进程复用/释放/退出/取消、会话与跨节点群聊附件回归。
- TypeScript 类型检查、生产构建、Windows 目录打包通过。
- 真实 Electron 开发和打包 app.asar 两种环境均通过中文扫描 PDF 识别；
  验收脚本只引用 CC Desktop 的模型资源和依赖，识别用时约 1 秒/合成单页。
- 当前 CPA 8.0.43 + deepseek-v4-flash 实测：两页纯图片 PDF，直接提交仍复现 400；
  本地 OCR 转换后 HTTP 200，读出 CEDAR-731 / 24680 USD；历史续问读出 59283。
  实际 SessionManager + Claude SDK 首次及关闭后恢复会话均成功。
- 使用合成样本；未将该结果当作任意复杂版式、倒置扫描件或真实投标文件的准确率验收。

图片缓存位置由当前源码及磁盘核对：日间照片流为
`%APPDATA%/@claude-desktop/desktop/photo-flow`（核对时 12 张 JPG 和索引）；
粘贴截图为 `%TEMP%/cc-desktop-clipboard`；群聊为 userData 下的 room-attachments。
