# hostApi 2 房间扩展（作者说明）

`hostApi: 1` 是玩法包（`host.js` + `createGame`），一房间最多一个。  
`hostApi: 2` 是组合扩展（`mod.js` + `activate(ctx)`），一房间可多个。

## 包结构

```
my-ext/
  manifest.json
  mod.js
```

不要放 `host.js`、`ui.js`，不要写 `createGame`。

```json
{
  "id": "shared-memory",
  "name": "群共享记忆",
  "version": "1.0.0",
  "hostApi": 2,
  "inject": [],
  "provides": ["memory"],
  "permissions": ["storage:room"],
  "hooks": []
}
```

权限目前只允许 `storage:room`（房间级 KV，不是包私有）。未知权限会拒载。  
`hooks` 目前只允许 `room.chat.in`。

## ctx

只能通过 `ctx` 拿能力。禁止 `require` / `import`。

内建：`room`、`log`、`onDispose`、`provide`、`hooks`。  
声明了 `storage:room` 才有 `ctx.storage`。  
`inject` 里的名字才会出现在 ctx 上。

`provide(name, api)` 必须在 `activate` 同步返回前调用，且 `name` 要写在 `provides` 里。  
官方 `memory` 会编译成 Agent 工具 `memory_get` / `memory_set` / `memory_list` / `memory_search`，数据打在房主 KV。

## 聊天 railway

`hooks: ["room.chat.in"]` 后可：

```js
ctx.hooks.on("room.chat.in", (env) => {
  if (env.text === "stop") return { action: "drop", reason: "blocked" };
  return { action: "replace", value: { ...env, text: env.text.trim() } };
});
```

没有 `next`。客人进房不会下载也不会执行 `mod.js`。

模板：复制 `apps/desktop/resources/mods/shared-memory/`。
