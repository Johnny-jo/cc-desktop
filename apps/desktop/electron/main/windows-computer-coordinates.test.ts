import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("maps physical pixels to exact SendInput coordinates across the virtual desktop", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-coordinate-test-"));
  const exe = path.join(scratch, "CoordinateTests.exe");
  const framework = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319");
  const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  try {
    execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror",
      "/out:" + exe, "/reference:System.Drawing.dll",
      ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(name => "/reference:" + path.join(framework, "WPF", name + ".dll")),
      source("../../resources/windows-computer/NativeDesktop.cs"),
      source("../../../../scripts/fixtures/windows-computer/CoordinateTests.cs")], { windowsHide: true, stdio: "inherit" });
    execFileSync(exe, { windowsHide: true, timeout: 5000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});
