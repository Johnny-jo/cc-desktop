import path from "node:path";
import type { McpServersMap, McpServerConfig } from "@claude-desktop/shared";
import { normalizeCdpEndpoint } from "@claude-desktop/shared";

/** Keep installation-specific paths out of settings and resolve them for every SDK entry point. */
export function resolveMcpServers(servers: McpServersMap, isPackaged: boolean, allowControl = true, sessionTitle = "浏览器会话", browserAuthStorePath?: string) {
  const resolved: Record<string, Exclude<McpServerConfig, { type: "playwright" | "windows-computer" }>> = {};
  const resources = isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../resources");
  for (const [name, config] of Object.entries(servers)) {
    if (config.type === "windows-computer") {
      if (!allowControl || process.platform !== "win32") continue;
      resolved[name] = {
        type: "stdio",
        command: process.execPath,
        args: [path.join(resources, "windows-computer", isPackaged ? "server.cjs" : "dist/server.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    } else if (config.type === "playwright") {
      if (!allowControl) continue;
      resolved[name] = {
        type: "stdio",
        command: process.execPath,
        args: [path.join(resources, "playwright-mcp", "control.cjs"), config.browser,
          config.connection ?? "extension", sessionTitle, config.connection === "cdp" ? "" : config.profile ?? "",
          ...(config.connection === "cdp" ? [normalizeCdpEndpoint(config.cdpEndpoint)] : [])],
        env: { ELECTRON_RUN_AS_NODE: "1", ...(browserAuthStorePath && (config.connection ?? "extension") === "extension"
          ? { AGENTOS_BROWSER_AUTH_STORE: browserAuthStorePath } : {}) },
      };
    } else {
      resolved[name] = config;
    }
  }
  return resolved;
}
