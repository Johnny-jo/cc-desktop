// Runs on the Windows build machine; the installed app needs neither csc nor npm.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const desktopRequire = createRequire(path.join(__dirname, "../package.json"));
const source = path.resolve(__dirname, "../resources/windows-computer");
const output = path.join(source, "dist");

async function buildWindowsComputer(context) {
  if (context?.electronPlatformName && context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") {
    if (context?.electronPlatformName === "win32") throw new Error("Build the native Windows computer driver on Windows x64.");
    return;
  }
  fs.mkdirSync(output, { recursive: true });
  const framework = path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319");
  const exe = path.join(output, "AgentOS.Computer.exe");
  const sources = fs.readdirSync(source).filter(name => name.endsWith(".cs")).map(name => path.join(source, name));
  const previous = fs.existsSync(exe) ? fs.statSync(exe).mtimeMs : 0;
  if ([...sources, __filename].some(file => fs.statSync(file).mtimeMs > previous)) {
    const references = ["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(name => "/reference:" + path.join(framework, "WPF", name + ".dll"));
    const winMetadata = path.join(process.env.SystemRoot, "System32/WinMetadata");
    for (const name of ["Windows.Foundation", "Windows.Graphics"]) references.push("/reference:" + path.join(winMetadata, name + ".winmd"));
    for (const name of ["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime"]) {
      references.push("/reference:" + path.join(framework, name + ".dll"));
    }
    execFileSync(path.join(framework, "csc.exe"), [
      "/nologo", "/langversion:5", "/platform:x64", "/optimize+", "/utf8output", "/codepage:65001", "/warnaserror", "/out:" + exe,
      "/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", ...references, ...sources,
    ], { windowsHide: true, stdio: "inherit" });
  }
  // Resolve the same SDK and Zod as the existing Claude SDK peer dependencies.
  const sdkRequire = createRequire(desktopRequire.resolve("@anthropic-ai/claude-agent-sdk"));
  const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
  const entry = path.join(source, "server-entry.cjs");
  const result = await build({
    absWorkingDir: source, entryPoints: [entry], outfile: path.join(output, "server.cjs"),
    bundle: true, platform: "node", target: "node22", format: "cjs", metafile: true,
    plugins: [{ name: "desktop-sdk", setup(builder) {
      builder.onResolve({ filter: /^(?:@modelcontextprotocol\/sdk\/|zod$)/ }, args =>
        args.importer === entry ? { path: sdkRequire.resolve(args.path) } : undefined);
    } }],
  });
  const notices = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
    let dir = path.dirname(path.resolve(source, input));
    while (dir !== path.dirname(dir)) {
      const license = fs.readdirSync(dir).find(name => /^licen[sc]e(?:\.|$)/i.test(name));
      if (license) {
        notices.set(path.basename(dir), fs.readFileSync(path.join(dir, license), "utf8"));
        break;
      }
      dir = path.dirname(dir);
    }
  }
  fs.writeFileSync(path.join(output, "THIRD-PARTY-NOTICES.txt"), [...notices].map(([name, terms]) => name + "\n" + terms).join("\n\n"));
}
module.exports = buildWindowsComputer;
if (require.main === module) buildWindowsComputer().catch(error => { console.error(error); process.exitCode = 1; });
