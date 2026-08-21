import fs from "node:fs";
import path from "node:path";
import {
  exportPrivatePkcs8,
  generateDeviceKeys,
  importDeviceKeys,
  type DeviceKeys,
} from "@claude-desktop/shared/room-crypto";

type DeviceFile = {
  v: 1;
  /** base64 PKCS#8 DER — never leaves the main process. */
  pkcs8: string;
  /** base64 raw X25519 public key. */
  pub: string;
};

/**
 * Load the persistent room device identity from userData, or generate and
 * persist a fresh X25519 keypair on first run / after corruption.
 * The private key is never exposed over IPC.
 */
export function loadOrCreateDeviceKeys(userDataDir: string): DeviceKeys {
  const file = path.join(userDataDir, "room-device.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw) as DeviceFile;
    if (data.v === 1 && typeof data.pkcs8 === "string" && typeof data.pub === "string") {
      return importDeviceKeys(Buffer.from(data.pkcs8, "base64"), Buffer.from(data.pub, "base64"));
    }
  } catch {
    // missing or unreadable file — fall through to regenerate
  }
  const keys = generateDeviceKeys();
  const payload: DeviceFile = {
    v: 1,
    pkcs8: exportPrivatePkcs8(keys).toString("base64"),
    pub: keys.publicRaw.toString("base64"),
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  return keys;
}
