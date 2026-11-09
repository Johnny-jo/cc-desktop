import { describe, expect, it } from "vitest";
import { CredentialManager, type CredentialCipher } from "./credential-manager";

/** 可控的假加密：只是把字符反转，足以验证「走没走加密路径」而不依赖 OS。 */
function fakeCipher(): CredentialCipher {
  return {
    encrypt: (plain) => `X${plain.split("").reverse().join("")}`,
    decrypt: (cipher) => cipher.slice(1).split("").reverse().join(""),
  };
}

describe("CredentialManager", () => {
  it("round-trips through the cipher when OS encryption is available", () => {
    const manager = new CredentialManager(fakeCipher());
    const stored = manager.encrypt("sk-ant-secret");

    expect(stored.startsWith("enc:")).toBe(true);
    // 密文里不能出现明文
    expect(stored).not.toContain("sk-ant-secret");
    expect(manager.decrypt(stored)).toBe("sk-ant-secret");
    expect(manager.encryptionAvailable).toBe(true);
  });

  it("tags the degraded path as base64 so it can never be mistaken for ciphertext", () => {
    const manager = new CredentialManager(null);
    const stored = manager.encrypt("sk-live");

    expect(stored).toBe(`b64:${Buffer.from("sk-live", "utf8").toString("base64")}`);
    expect(manager.decrypt(stored)).toBe("sk-live");
    // 降级必须可被调用方看见，否则 UI 无法提示「未加密存储」
    expect(manager.encryptionAvailable).toBe(false);
  });

  it("refuses to silently return garbage when an encrypted value cannot be decrypted", () => {
    const encryptedByAnotherRun = new CredentialManager(fakeCipher()).encrypt("sk-x");
    const noCipher = new CredentialManager(null);

    // 旧实现会在这里 base64 解一次得到乱码当密钥用；现在必须显式报错。
    expect(() => noCipher.decrypt(encryptedByAnotherRun)).toThrow(/re-enter/i);
  });

  it("rejects unrecognized stored formats instead of guessing", () => {
    const manager = new CredentialManager(fakeCipher());
    expect(() => manager.decrypt("not-a-known-format")).toThrow(/Unrecognized/);
    expect(() => manager.decrypt("")).toThrow(/Unrecognized/);
  });

  it("handles non-ASCII and shell-metacharacter payloads safely", () => {
    // 旧实现把这些字符拼进 PowerShell 命令串
    const manager = new CredentialManager(fakeCipher());
    const nasty = `sk-"'; rm -rf / ;$([char]34)密钥`;
    expect(manager.decrypt(manager.encrypt(nasty))).toBe(nasty);
  });
});
