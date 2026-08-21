import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { fingerprintPublic } from "@claude-desktop/shared";
import { loadOrCreateDeviceKeys } from "./room-device-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("room-device-store", () => {
  it("persists and reloads the same fingerprint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-"));
    dirs.push(dir);
    const a = loadOrCreateDeviceKeys(dir);
    const b = loadOrCreateDeviceKeys(dir);
    expect(fingerprintPublic(a.publicRaw)).toBe(fingerprintPublic(b.publicRaw));
    const raw = fs.readFileSync(path.join(dir, "room-device.json"), "utf8");
    expect(raw).not.toMatch(/BEGIN/);
  });
});
