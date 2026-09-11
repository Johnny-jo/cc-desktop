# Ubuntu 24：常驻群聊服务器部署

## 行为与升级范围

- 局域网：仍由群主电脑处理，群主离线就不可继续实时聊天。
- 服务器托管：服务器处理消息和房间状态，创建者是群主，服务器不出现在成员列表中。群主关闭客户端后，其他在线成员仍可聊天；群主主动确认“解散群聊”才会结束房间。
- 此版替换旧中继协议；旧 `/ctl`、`/work` 不再支持。客户端也必须更新到此次代码构建的版本，旧群须重新创建，旧邀请码不迁移。
- 托管群支持文字、附件、引用/撤回、成员管理及成员电脑上的 Agent。Agent 的工作区必须绑定真实成员；节点离线或移除后任务失败，不回退到服务器。成员电脑原有的工作区审批和路径限制继续生效。
- Mod、扩展改善和共享记忆由群主电脑运行。服务器只转发固定协议请求和同步界面数据，不接收或执行 Mod 源码，也不提供 Agent 会话、终端或本机 AI 网关。群主离线时扩展暂停，普通聊天仍可使用；群主电脑保持运行并重连后恢复扩展。重启群主客户端后需重新启用本地扩展。
- 使用现有房间协议的最近 400 条时间线视图与去重机制，不是无限历史归档服务。上限 40 个房间、每房间 128 个连接（包含握手中连接）。
- 服务器断线后客户端显示离线，服务恢复后点击“重连”；没有实现无限后台重试。
- 服务器是可信权威，可处理消息明文；TLS 和应用层加密不意味着服务器无法读取消息。

## 1. 准备部署文件

本地构建命令：

```powershell
node scripts/build-room-server.mjs
```

上传以下文件到 Ubuntu：

- `scripts/room-relay-server.mjs`：已打包的独立程序，服务器不需要 npm install，也不需要 Electron / Claude / CPA。
- `scripts/room-server.service`：systemd 配置示例。

程序源代码在 `apps/desktop/electron/server/room-server.ts`。不要手改生成后的 mjs；修改源代码后重新构建。

服务器安装 Node.js 22.13 或更新的 22.x / 24.x。Ubuntu 系统自带的旧 Node 版本可能不满足要求。按照 Node.js 官方安装说明安装，然后检查：

```bash
node --version
command -v node
node -e "require('node:sqlite'); console.log('SQLite OK')"
```

systemd 示例使用 `/usr/bin/node`。若安装位置不同，必须把 ExecStart 改成 `command -v node` 给出的绝对路径；不要依赖交互式 shell 的 nvm 环境。

## 2. 创建服务账号和目录

首次安装：

```bash
sudo useradd --system --user-group --home-dir /var/lib/cc-room --shell /usr/sbin/nologin cc-room
sudo install -d -o root -g root -m 755 /opt/cc-room
sudo install -d -o root -g root -m 700 /etc/cc-room
sudo install -d -o cc-room -g cc-room -m 700 /var/lib/cc-room
sudo install -o root -g root -m 644 ./room-relay-server.mjs /opt/cc-room/room-relay-server.mjs
sudo install -o root -g root -m 644 ./room-server.service /etc/systemd/system/cc-room.service
openssl rand -hex 32
sudoedit /etc/cc-room/server.env
```

将生成的随机字符串填入配置（不要提交到 Git、公开或发进群）：

```ini
ROOM_SERVER_TOKEN=替换为刚生成的随机字符串
ROOM_SERVER_PUBLIC_URL=wss://chat.example.com
```

```bash
sudo chmod 600 /etc/cc-room/server.env
sudo systemctl daemon-reload
sudo systemctl enable --now cc-room
sudo systemctl status cc-room --no-pager
curl --fail http://127.0.0.1:7600/healthz
```

健康接口应返回 `service: cc-room-server`、`version: 2`。

## 3. 配置 HTTPS / WSS 入口

程序默认仅监听回环地址。公网必须使用 TLS 反向代理，不要把明文建群接口直接开放到公网。

如果已有 Nginx 与有效证书，在对应域名的 HTTPS server 配置中转发所有路径，而不仅是 `/r/`：

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    ssl_certificate /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 8k;
    location / {
        proxy_pass http://127.0.0.1:7600;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

替换域名和证书路径，先通过 `sudo nginx -t`，再重载配置。沿用现有 TLS 入口也可以，但需同时支持 `POST /api/rooms` 和 WebSocket `/r/<roomId>`。域名须解析到本机，网络需允许访问 443；无需开放 7600。公网 URL 只能是域名根地址，不支持子路径前缀。

测试：

```bash
curl --fail https://chat.example.com/healthz
```

## 4. 客户端建群

1. 使用此次代码构建的新客户端。
2. 建群时启用“服务器托管（自建）”。
3. 地址填 `wss://chat.example.com`，令牌填服务器的 `ROOM_SERVER_TOKEN`。
4. 设置群名和入群密码。若开启自动放行，密码至少 8 位；关闭自动放行时，创建者在客户端批准新设备。
5. 创建后复制新的邀请码给群友。邀请码不包含密码，密码需另外告知。
6. 创建者关闭客户端，其他两位成员互发消息验证。

建群令牌用于允许创建房间，不是群密码，不应发给普通群友。创建者是群主，身份绑定本机设备密钥；不要丢失客户端数据目录。服务器不作为成员或席位出现。群主可授予、撤销管理员；管理员可管理普通成员，但不能设置管理员、改群主、解散群聊。未开启自动放行且群主离线时，新设备不能入群，已加入的群友仍可聊天。

## 5. 升级与备份

旧脚本必须停掉后再启动新服务，以免争抢端口。保留旧部署文件用于人工恢复，但新旧房间协议不兼容。

后续新版升级：先停服务，备份 `/var/lib/cc-room` 和 `/etc/cc-room`，替换 `/opt/cc-room/room-relay-server.mjs`，再启动。SQLite 备份应停服后复制整个数据目录，不能只复制运行中的数据库主文件而遗漏 WAL。

Agent、附件与桌面 Mod 支持需要同时更新服务端脚本和参与群聊的客户端。已有托管群无需重建。新客户端连接旧服务器时，旧服务器仍会返回“不支持 Agent、附件或 Mod”。

群主身份修复需要同时更新服务端和客户端，再让客户端重连。已有托管群会移除旧的服务器成员，并根据保存的创建者设备绑定恢复群主。早期版本会丢失托管标记和创建者指纹；只有存档中存在唯一历史管理员和唯一已验证设备绑定时才自动恢复，存在歧义时不会猜测或提升任何人的权限。保留原数据目录和设备密钥，正常旧群不需要重建。

数据目录含服务器设备密钥、房间密码与 SQLite 数据，必须保持私密。删除目录会丢失身份及房间；不要通过清空数据目录“修复”启动错误。

```bash
sudo journalctl -u cc-room -n 100 --no-pager
sudo systemctl restart cc-room
```

管理员电脑掉线不影响其他人；服务器重启期间所有群连接会中断，启动后原邀请码仍可使用。客户端点击重连后获取最新保留的历史。

## 6. 验证范围

本地自动化使用实际部署 mjs 子进程，覆盖创建者离线后的双向聊天、服务重启后的历史与指纹恢复、审批、非管理员拒绝、令牌验证和局域网回归。Ubuntu 24 上的 systemd、实际域名证书与公网网络仍须按以上步骤部署验收，不能把本地测试等同于已完成服务器实测。

本次 Agent / 附件 / 桌面 Mod 支持的定向验证（Windows / Node 22.23.2）：类型检查、桌面生产构建和独立服务器打包通过；9 个群聊相关测试文件共 162 项通过，shared 228 项通过。覆盖真实服务器子进程、伪造执行请求拒绝、执行节点移除后禁止回退、Mod Agent 回合、私有视图、扩展重连、附件下载及被取消的 WebSocket 升级连接。修复升级连接遭重置时服务器未处理 Socket 错误而退出的问题；附件节点路径断言使用原生 realpath，兼容 Windows 短路径。这是定向回归，未宣称整个仓库测试全部通过。
