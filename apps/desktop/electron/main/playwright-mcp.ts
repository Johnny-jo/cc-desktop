import path from "node:path";
import type { McpServersMap, McpServerConfig } from "@claude-desktop/shared";

/** Keep installation-specific paths out of settings and resolve them for every SDK entry point. */
export function resolveMcpServers(servers: McpServersMap, isPackaged: boolean, allowBrowser = true) {
  const resolved: Record<string, Exclude<McpServerConfig, { type: "playwright" }>> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.type !== "playwright") {
      resolved[name] = config;
    } else if (allowBrowser) {
      const resources = isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../resources");
      resolved[name] = {
        type: "stdio",
        command: process.execPath,
        args: [path.join(resources, "playwright-mcp", "control.cjs"), config.browser],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }
  return resolved;
}
