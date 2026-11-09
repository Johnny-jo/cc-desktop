/**
 * 认证凭证加密（使用 OS 的安全存储）
 *
 * 旧实现用 execSync 把明文拼进 PowerShell 命令串做 DPAPI，既给了命令注入面
 * （任何含引号的 key 都会改写脚本），失败时又静默退化成 base64——等于明文落盘。
 * 现在统一走 Electron safeStorage（Windows 上是 DPAPI），纯内存调用，无子进程。
 *
 * 存储格式带前缀，便于区分「真正加密」与「降级为 base64」，也避免把两种数据
 * 混在一起后无法判断：
 *   enc:<safeStorage 密文>
 *   b64:<base64 明文>       ← 仅当系统加密不可用时
 */

export type CredentialCipher = {
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
};

const ENCRYPTED_PREFIX = "enc:";
const PLAINTEXT_PREFIX = "b64:";

export class CredentialManager {
  /**
   * @param cipher 由 bootstrap 按 `safeStorage.isEncryptionAvailable()` 决定；
   *               传 null 表示系统加密不可用，凭证只能 base64 存储。
   */
  constructor(private readonly cipher: CredentialCipher | null) {}

  /** 系统级加密是否可用。不可用时 UI 应提示用户凭证并未真正加密。 */
  get encryptionAvailable(): boolean {
    return this.cipher !== null;
  }

  encrypt(plaintext: string): string {
    if (!this.cipher) {
      return PLAINTEXT_PREFIX + Buffer.from(plaintext, "utf8").toString("base64");
    }
    return ENCRYPTED_PREFIX + this.cipher.encrypt(plaintext);
  }

  decrypt(stored: string): string {
    if (stored.startsWith(ENCRYPTED_PREFIX)) {
      const body = stored.slice(ENCRYPTED_PREFIX.length);
      if (!this.cipher) {
        // 加密过的值在系统加密不可用时真的解不开，不能假装读到了明文。
        throw new Error(
          "Credential was encrypted but OS encryption is unavailable; re-enter it.",
        );
      }
      return this.cipher.decrypt(body);
    }
    if (stored.startsWith(PLAINTEXT_PREFIX)) {
      return Buffer.from(stored.slice(PLAINTEXT_PREFIX.length), "base64").toString(
        "utf8",
      );
    }
    throw new Error("Unrecognized credential format; re-enter the credential.");
  }
}
