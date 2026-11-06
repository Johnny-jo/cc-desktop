# CPA v8 升级与验收

项目使用 CLIProxyAPI **8.0.43** 与管理页 **1.26.7**；版本在 `scripts/cpa-release.json` 固定。
升级版本时应一起验证后端和管理页，避免新版管理页搭配 v7 后端。

## Windows 开发与打包

在 PowerShell 中进入本仓库根目录，然后依次执行：

```powershell
pnpm install --frozen-lockfile
pnpm download:cpa
pnpm prepare:vendor
pnpm typecheck
pnpm --filter @claude-desktop/desktop exec vitest run electron/main/cpa-config.test.ts electron/main/runtime-paths.test.ts electron/main/cpa-supervisor.test.ts electron/main/cpa-quota.test.ts electron/main/cpa-model-sync.test.ts
pnpm --filter @claude-desktop/desktop build
pnpm --filter @claude-desktop/desktop dist:dir
```

官方发行文件保存在忽略的 `tools/cpa/8.0.43/`，供 `prepare-vendor` 复制到 `vendor/win-x64/cpa/`。
如仅更新 CPA，可用 `pnpm prepare:vendor:cpa`；首次完整打包需用 `pnpm prepare:vendor` 准备 Claude CLI。
显式设置 `CLAUDE_DESKTOP_CPA_DIST` 可使用自备 v8 目录，但必须包含 `cli-proxy-api.exe` 和支持 v8 的 `static/management.html`。
准备和打包前都会检查后端版本及页面，拒绝 v7 或缺失的页面。不会复制本地配置或认证文件。

## 配置与接口

| 用途 | v8 路径 |
| --- | --- |
| 监听地址、端口和 TLS | `server.host`、`server.port`、`server.tls` |
| 管理密钥和页面设置 | `management` |
| 客户端密钥 | `access.api-keys` |
| 上游供应商凭据组 | 顶层 `api-keys`，不可当作客户端密钥覆盖 |
| OAuth 凭据目录 | `oauth.auth-dir` |
| 日志调试 | `observability.logs.debug` |
| 凭据列表、模型和下载 | `/v8/management/credentials`、`/credentials/models`、`/credentials/download` |
| 配额请求代理 | `/v8/management/requests/api-call` |

新配置使用 v8。已有配置的启动修复同时识别旧版和 v8，只启用管理页、关闭页面独立自动更新，并在管理密钥为空时补齐；保留非空密钥、客户端密钥、供应商、监听配置和凭据目录。
完整旧配置迁移交由 CPA 自己的 v8 配置写入完成；读取 `/v8/management/config.yaml` 不会迁移文件。
管理页由桌面应用从当前捆绑版本同步到实际配置旁的 `static/management.html`。

## 升级现有安装与验证

1. 备份当前 CPA 程序、配置和管理页，保留 OAuth 凭据目录。配置备份含密钥，应留在本机用户数据目录，不提交到仓库。
2. 停止正在运行的 CPA，替换实际监听端口对应的可执行文件和配套页面，使用原配置和原管理令牌启动。
3. 使用原管理密钥读取 `/v8/management/config`，确认响应成功且 `X-CPA-Version` 为 v8。如需迁移已有配置，通过 v8 管理接口保存；保存后核对原客户端密钥、管理密钥、供应商配置和凭据目录。
4. 打开 `http://localhost:8317/management.html`，输入原管理密钥，确认进入仪表盘，配置与凭据请求成功。再检查 `/v1/models`，确认客户端访问仍可用。
5. 配额单元测试只验证客户端适配；它们不代表所有供应商的真实配额接口或模型推理均已通过。

回退时停止升级后的 CPA，再成套恢复旧程序、旧配置和与旧后端兼容的管理页。不要只把二进制降回 v7 而保留 v8 配置。

官方参考：[v8 接口契约](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.43/docs/management-api-v8.md)、[v8 配置示例](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.43/config.example.yaml)。
