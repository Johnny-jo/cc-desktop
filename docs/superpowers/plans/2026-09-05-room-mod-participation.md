# Mod 仅限制活动参与

> 在当前工作区按 test-driven-development 逐步执行；用户已有 styles.css 改动不触碰。本次不实现常驻群服务、全局账号或成员端分布式 Mod 引擎。

**目标：** 群内活动包不再是入群前置条件，成员主动加载后才获得活动资格。

**架构：** 保留现有玩法运行时，将群的 modChecksum 与成员确认加载的 modChecksum 分开。群连接不检查活动包一致性，mod.intent 和私人活动投影检查成员资格。下载仍复用现有校验与缓存链路，不默认执行新类型的成员端代码。

**技术栈：** TypeScript、Electron IPC、现有 RoomFrame/WebSocket、React、Vitest。

## 文件边界

- packages/shared/src/room-protocol.ts：成员参与状态、统一资格判断、参与请求与响应帧。
- packages/shared/src/ipc.ts、apps/desktop/electron/preload/index.ts、apps/desktop/electron/main/ipc-handlers.ts：群内加载/停止参与 IPC。
- apps/desktop/electron/main/room-service.ts：入群放行、明确参与登记、私有投影和活动动作门禁、活动席位过滤、重连保存本人选择。
- apps/desktop/src/state/room-store.ts：参与操作接入。
- apps/desktop/src/components/RoomSidebar.tsx、ModPlayPanel.tsx：普通入群与群内加载入口；复用现有样式。
- apps/desktop/src/lib/room-mod-ui.ts：默认入群不同步活动包。
- apps/desktop/src/i18n/zh.ts、en.ts：不再声称必须下载才可入群。
- apps/desktop/electron/main/room-mod.test.ts、apps/desktop/src/lib/room-mod-ui.test.ts、apps/desktop/src/components/ModPlayPanel.test.ts、packages/shared/src/room-protocol.test.ts：回归用例。

## 顺序与检查点

- [x] 读取 Mod 接口、入群链路、活动动作、视图和恢复流程。
- [x] 基线：node node_modules/vitest/vitest.mjs run electron/main/room-mod.test.ts src/lib/room-mod-ui.test.ts（工作目录 apps/desktop）；43 项通过。
- [x] 修改旧测试：无校验码及错误校验码入群都成功，普通消息可达。
- [x] 新增测试：未参与者不能 modIntent，不获得私有投影，不被计入玩法开始人数。
- [x] 新增测试：入群后主动加载可参与，停止参与后仍留群且不能继续操作。
- [x] 新增测试：群启用/更换 Mod 不把未参与者的重连配置自动改成同意参与。
- [x] 运行上述测试，确认因原行为或缺失参与接口失败。
- [x] 实现成员资格：只接受当前包的匹配校验码；身份取已认证连接，不取请求自报 userId。持有校验码不等于可信客户端，仍须检查原有席位权限。
- [x] 参与变更使用请求 ID 与响应；超时/断线返回错误，不能乐观声称已加入活动。重试保留幂等状态。
- [x] 清除入群阶段的包拒绝；将所有成员活动动作和私有视图入口接入同一资格判断，保留受控的内部 Agent 执行路径，玩法席位仅包含参与成员及原有 Agent 席位。
- [x] UI 默认只入群；在活动面板明确加载/停止参与，不自动下载。包损坏或版本变化只报活动错误。
- [x] 独立审查发现的参与入口缺失、内部 Agent 误拦、开始/退出竞态均以失败测试复现并修复；重置活动也按当前参与人数校验。
- [x] 运行定向测试及 typecheck；检查授权、重连、Mod 失败恢复相关测试。
- [x] 检查 git diff，确认只涉及本功能；核对用户 styles.css 哈希不变。

## 验收断言

```ts
expect((await guest.rooms.join({ host: "127.0.0.1", port })).ok).toBe(true);
expect((await guest.rooms.modIntent(roomId, seatId, "inc", {})).ok).toBe(false);
expect((await guest.rooms.setModParticipation(roomId, true)).ok).toBe(true);
expect((await guest.rooms.setModParticipation(roomId, false)).ok).toBe(true);
expect(guest.rooms.get(roomId)?.status).toBe("open");
```

实际测试使用文件包、真实本机 WebSocket 与 RoomService；模型 SDK 继续采用现有测试替身，不触发真实模型调用。完成后报告验证范围；不把本次改动称为客户端 Mod 引擎、常驻服务器或账号体系已实现。

## 验证记录（2026-09-05）

- 桌面端：`node node_modules/vitest/vitest.mjs run --silent`，69 个文件、663 项通过。
- 共享协议：`node ../../apps/desktop/node_modules/vitest/vitest.mjs run src/room-protocol.test.ts --silent`，13 项通过。
- 桌面类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`，退出码 0。
- 生产构建：`node node_modules/electron-vite/bin/electron-vite.js build`，主进程、preload、renderer 均成功。
- `git diff --check` 通过。用户样式 SHA256 保持 `E59F16770780F292725A08F0016A9F8113A349800F6653181D19FA7F97178D86`。
- UI 覆盖静态渲染的参与入口、未参与者私有数据/操作隐藏；未进行真实双机桌面交互验收，未部署或提交。使用新增 preload 接口需完全重启应用，群两端需使用支持新参与协议的版本。
- 本轮仅落地旧玩法运行时上的参与资格门禁，不改变 hostApi 2 群级扩展运行位置。具体 Mod 的中途加入/退出规则不由通用参与开关代替。
