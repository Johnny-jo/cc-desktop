import fs from "node:fs";
import path from "node:path";
import type { AuthFileEntry } from "@claude-desktop/shared";

/**
 * Desktop-local manager for auth-file credentials.
 *
 * Each credential is stored as two files:
 *   <id>.json  — AuthFileEntry metadata (no token)
 *   <id>.token — raw access token (newline-stripped)
 *
 * The token is kept separate so it can be independently restricted (e.g. NTFS
 * ACLs) or encrypted in a future phase. The .json is safe to read and display
 * in UI without exposing secrets.
 */
export class AuthFileManager {
  private readonly dir: string;

  constructor(userDataPath: string) {
    this.dir = path.join(userDataPath, "auth-files");
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
    } catch (e) {
      console.error("[auth-file-manager] failed to create dir:", e);
    }
  }

  /** Return all known auth-file entries. Token values are never included. */
  list(): AuthFileEntry[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const entries: AuthFileEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const filePath = path.join(this.dir, f);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const entry = JSON.parse(raw) as AuthFileEntry;
        if (entry && typeof entry.id === "string" && typeof entry.provider === "string") {
          entries.push(entry);
        }
      } catch {
        // malformed file — skip silently
      }
    }
    // Sort by id for stable display order
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return entries;
  }

  /** Read the raw access token for an entry. Returns null if not found. */
  getToken(id: string): string | null {
    const tokenFile = path.join(this.dir, `${this.safeId(id)}.token`);
    try {
      if (!fs.existsSync(tokenFile)) return null;
      return fs.readFileSync(tokenFile, "utf-8").trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Save an auth-file entry and its token.
   * Overwrites any existing entry with the same id.
   */
  save(entry: AuthFileEntry, token: string): void {
    const safeId = this.safeId(entry.id);
    const metaFile = path.join(this.dir, `${safeId}.json`);
    const tokenFile = path.join(this.dir, `${safeId}.token`);
    const withTimestamp: AuthFileEntry = {
      ...entry,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaFile, JSON.stringify(withTimestamp, null, 2), "utf-8");
    fs.writeFileSync(tokenFile, token, "utf-8");
  }

  /** Delete an auth-file entry and its token. */
  delete(id: string): void {
    const safeId = this.safeId(id);
    this.tryRemove(path.join(this.dir, `${safeId}.json`));
    this.tryRemove(path.join(this.dir, `${safeId}.token`));
  }

  /** Toggle the disabled flag on an existing entry. */
  setDisabled(id: string, disabled: boolean): void {
    const metaFile = path.join(this.dir, `${this.safeId(id)}.json`);
    if (!fs.existsSync(metaFile)) return;
    const entry = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as AuthFileEntry;
    entry.disabled = disabled;
    fs.writeFileSync(metaFile, JSON.stringify(entry, null, 2), "utf-8");
  }

  /** Persist a quota cache snapshot for an entry. */
  updateQuotaCache(id: string, quotaCache: AuthFileEntry["quotaCache"]): void {
    const metaFile = path.join(this.dir, `${this.safeId(id)}.json`);
    if (!fs.existsSync(metaFile)) return;
    const entry = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as AuthFileEntry;
    entry.quotaCache = quotaCache;
    fs.writeFileSync(metaFile, JSON.stringify(entry, null, 2), "utf-8");
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private safeId(id: string): string {
    // Strip any path-traversal characters; allow only alphanum / dash / underscore / dot
    return id.replace(/[^a-zA-Z0-9\-_.]/g, "_").slice(0, 64);
  }

  private tryRemove(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}
