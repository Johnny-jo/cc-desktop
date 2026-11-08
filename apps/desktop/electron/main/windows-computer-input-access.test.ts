import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("distinguishes a compatible target from an unreadable one on a private desktop", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-input-access-"));
  const exe = path.join(scratch, "InputAccessTests.exe");
  const framework = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319");
  const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  try {
    execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror",
      "/out:" + exe, "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
      ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(name => "/reference:" + path.join(framework, "WPF", name + ".dll")),
      source("../../resources/windows-computer/NativeDesktop.cs"), source("../../resources/windows-computer/WindowInputAccess.cs"),
      source("../../../../scripts/fixtures/windows-computer/InputAccessTests.cs")], { windowsHide: true, stdio: "inherit" });
    execFileSync(exe, { windowsHide: true, timeout: 5000, stdio: "inherit" });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}, 15000);
