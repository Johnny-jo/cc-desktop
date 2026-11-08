import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("rechecks the original capture source and every glyph of an observed click target", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-capture-source-"));
  const exe = path.join(scratch, "CaptureSourceTests.exe");
  const compiler = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  try {
    execFileSync(compiler, ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror", "/out:" + exe,
      "/reference:System.Drawing.dll", source("../../resources/windows-computer/WindowCaptureSource.cs"),
      source("../../../../scripts/fixtures/windows-computer/CaptureSourceTests.cs")], { windowsHide: true, stdio: "inherit" });
    execFileSync(exe, { windowsHide: true, timeout: 5000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});
