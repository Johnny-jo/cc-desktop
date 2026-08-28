export * from "./models";
export * from "./ipc";
export * from "./diff";
export * from "./permission-rules";
export * from "./context-usage";
export * from "./attachments";
export * from "./model-context-limits";
export * from "./mcp-servers";
export * from "./transcript-reducer";
export * from "./room-protocol";
export * from "./room-seat-bind";
// room-crypto / room-handshake / room-pdu 依赖 node:crypto，仅供主进程经
// "@claude-desktop/shared/room-crypto" 等子路径引入（同 mod-hash 惯例），
// 不进桶文件——渲染进程与 sandboxed preload 没有 node:crypto。
