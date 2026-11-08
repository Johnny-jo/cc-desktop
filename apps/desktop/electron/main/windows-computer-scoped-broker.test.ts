import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("checks the elevated worker's request policy without raising UAC", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-scope-test-"));
  const exe = path.join(scratch, "ScopeTests.exe");
  const framework = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319");
  const metadata = path.join(process.env.SystemRoot!, "System32/WinMetadata");
  const source = fileURLToPath(new URL("../../resources/windows-computer/", import.meta.url));
  const fixture = fileURLToPath(new URL("../../../../scripts/fixtures/windows-computer/ScopedWindowBrokerTests.cs", import.meta.url));
  try {
    execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror",
      "/codepage:65001", "/main:AgentOS.Computer.ScopedWindowBrokerTests", "/out:" + exe,
      "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll",
      ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(name => "/reference:" + path.join(framework, "WPF", name + ".dll")),
      ...["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime"].map(name => "/reference:" + path.join(framework, name + ".dll")),
      ...["Windows.Foundation", "Windows.Graphics"].map(name => "/reference:" + path.join(metadata, name + ".winmd")),
      ...readdirSync(source).filter(name => name.endsWith(".cs")).map(name => path.join(source, name)), fixture,
    ], { windowsHide: true, stdio: "inherit" });
    execFileSync(exe, { windowsHide: true, timeout: 10000, stdio: "inherit" });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}, 25000);
