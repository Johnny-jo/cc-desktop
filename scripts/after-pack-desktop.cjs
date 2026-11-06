const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const writeUpdateConfig = require("./after-pack-app-update.cjs");

module.exports = async function afterPack(context) {
  // Copy actual package contents outside ASAR. pnpm links and developer-machine
  // paths cannot be used by the MCP subprocess on the installed machine.
  const desktopRequire = createRequire(path.resolve(__dirname, "../apps/desktop/package.json"));
  const manifest = desktopRequire.resolve("@playwright/mcp/package.json");
  const mcpRequire = createRequire(manifest);
  const target = path.join(context.appOutDir, "resources", "playwright-mcp", "node_modules");
  for (const name of ["@playwright/mcp", "playwright", "playwright-core"]) {
    const source = path.dirname(mcpRequire.resolve(name + "/package.json"));
    fs.cpSync(source, path.join(target, name), { recursive: true });
  }
  await writeUpdateConfig(context);
};
