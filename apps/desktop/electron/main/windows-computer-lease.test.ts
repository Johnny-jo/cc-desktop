import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "win32")("owns and releases the control indicator and emergency keys on a private Windows desktop", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agentos-lease-test-"));
  const exe = path.join(scratch, "DesktopLeaseTests.exe");
  const compiler = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  try {
    execFileSync(compiler, ["/nologo", "/langversion:5", "/platform:x64", "/warnaserror", "/out:" + exe,
      "/reference:System.Windows.Forms.dll", source("../../resources/windows-computer/DesktopLease.cs"),
      source("../../../../scripts/fixtures/windows-computer/DesktopLeaseTests.cs")], { windowsHide: true });
    execFileSync(exe, { windowsHide: true, timeout: 15000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}, 25000);
