import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("scrolls and drags only in dedicated fixture windows and releases on failure", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-scroll-drag-"));
  const exe = path.join(scratch, "NativeScrollDragTests.exe");
  const framework = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319");
  const metadata = path.join(process.env.SystemRoot!, "System32/WinMetadata");
  const source = fileURLToPath(new URL("../../resources/windows-computer/", import.meta.url));
  const fixture = fileURLToPath(new URL("../../../../scripts/fixtures/windows-computer/NativeScrollDragTests.cs", import.meta.url));
  try {
    execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror",
      "/codepage:65001", "/main:AgentOS.Computer.NativeScrollDragTests", "/out:" + exe,
      "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll", "/reference:System.Xaml.dll",
      ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase", "PresentationCore", "PresentationFramework"].map(name => "/reference:" + path.join(framework, "WPF", name + ".dll")),
      ...["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime"].map(name => "/reference:" + path.join(framework, name + ".dll")),
      ...["Windows.Foundation", "Windows.Graphics"].map(name => "/reference:" + path.join(metadata, name + ".winmd")),
      ...readdirSync(source).filter(name => name.endsWith(".cs")).map(name => path.join(source, name)), fixture,
    ], { windowsHide:true, stdio:"inherit" });
    execFileSync(exe, {windowsHide:true,timeout:20000,stdio:"inherit"});
  } finally { rmSync(scratch,{recursive:true,force:true,maxRetries:3}); }
}, 30000);
