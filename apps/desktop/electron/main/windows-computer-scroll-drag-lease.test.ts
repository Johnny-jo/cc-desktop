import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("retains an expired input lease while an owned drag press awaits release", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-drag-idle-lease-"));
  const exe = path.join(scratch, "NativeDragIdleLeaseTests.exe");
  const framework = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319");
  const metadata = path.join(process.env.SystemRoot!, "System32/WinMetadata");
  const source = fileURLToPath(new URL("../../resources/windows-computer/", import.meta.url));
  const fixture = (name: string) => fileURLToPath(new URL("../../../../scripts/fixtures/windows-computer/" + name, import.meta.url));
  try {
    execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror",
      "/codepage:65001", "/main:AgentOS.Computer.NativeDragIdleLeaseTests", "/out:" + exe,
      "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll",
      ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(name => "/reference:" + path.join(framework, "WPF", name + ".dll")),
      ...["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime"].map(name => "/reference:" + path.join(framework, name + ".dll")),
      ...["Windows.Foundation", "Windows.Graphics"].map(name => "/reference:" + path.join(metadata, name + ".winmd")),
      ...readdirSync(source).filter(name => name.endsWith(".cs") && name !== "DesktopControlOverlay.cs").map(name => path.join(source, name)),
      fixture("DesktopLeaseTests.cs"), fixture("NativeDragIdleLeaseTests.cs"),
    ], {windowsHide:true,stdio:"inherit"});
    execFileSync(exe,{windowsHide:true,timeout:12000,stdio:"inherit"});
  } finally { rmSync(scratch,{recursive:true,force:true,maxRetries:3}); }
}, 25000);
