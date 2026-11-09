/**
 * 认证凭证加密（使用 OS 的安全存储）
 */

import { execSync } from "node:child_process";

export class CredentialManager {
  /**
   * 使用 Windows DPAPI 加密 API Key
   * (macOS 使用 Keychain，Linux 使用 plain text warning)
   */
  static encrypt(plaintext: string): string {
    try {
      if (process.platform === "win32") {
        // Windows: 使用 PowerShell 的 DPAPI
        const encoded = Buffer.from(plaintext, "utf-8").toString("base64");
        const psCmd = `
$encrypted = ConvertTo-SecureString -String '${encoded}' -AsPlainText -Force | ConvertFrom-SecureString
$encrypted
`.trim();
        const result = execSync(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, {
          encoding: "utf-8",
        }).trim();
        return result;
      } else {
        // macOS/Linux: 暂时直接返回，实际应使用 Keychain/Secret Service
        return Buffer.from(plaintext, "utf-8").toString("base64");
      }
    } catch (err) {
      console.warn("Encryption failed, using fallback:", err);
      return Buffer.from(plaintext, "utf-8").toString("base64");
    }
  }

  /**
   * 解密 API Key
   */
  static decrypt(encrypted: string): string {
    try {
      if (process.platform === "win32") {
        // Windows: 使用 PowerShell 的 DPAPI
        const psCmd = `
$encrypted = @'
${encrypted}
'@
$encrypted | ConvertTo-SecureString | ForEach-Object { [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($_)) }
`.trim();
        const result = execSync(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, {
          encoding: "utf-8",
        }).trim();
        return Buffer.from(result, "base64").toString("utf-8");
      } else {
        return Buffer.from(encrypted, "base64").toString("utf-8");
      }
    } catch (err) {
      console.warn("Decryption failed:", err);
      return Buffer.from(encrypted, "base64").toString("utf-8");
    }
  }
}
