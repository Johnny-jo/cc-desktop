import fs from "node:fs";
import path from "node:path";
import type { RoomKv, RoomKvNs, RoomKvSetResult } from "./mod-kernel";
import type { AppDatabase } from "./app-database";

export const KERNEL_NS_MAX_KEYS = 256;
export const KERNEL_VALUE_MAX_BYTES = 8 * 1024;
export const KERNEL_NS_MAX_BYTES = 256 * 1024;
export const KERNEL_SEARCH_LIMIT = 20;
export const KERNEL_KEY_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
export const KERNEL_NS_RE = /^[A-Za-z0-9._:-]{1,64}$/;

type NsMap = Record<string, string>;

export class HostRoomKv implements RoomKv {
  private data: Record<string, NsMap>;
  private sealed = false;

  constructor(
    private readonly filePath: string,
    private readonly database?: AppDatabase | null,
    private readonly roomId?: string,
  ) {
    if (database && roomId) {
      const migrationKey = `migration.mod-kv-json-v1:${roomId}`;
      if (!database.getMeta(migrationKey)) {
        database.replaceModKv(roomId, loadStore(filePath));
        database.setMeta(migrationKey, String(Date.now()));
      }
      this.data = database.loadModKv(roomId);
    } else {
      this.data = loadStore(filePath);
    }
  }

  namespace(ns: string): RoomKvNs {
    if (!KERNEL_NS_RE.test(ns)) {
      return deadNs("invalid namespace");
    }
    return {
      get: (key) => {
        if (!KERNEL_KEY_RE.test(key)) return undefined;
        return this.data[ns]?.[key];
      },
      set: (key, value) => this.write(ns, key, value),
      list: (prefix) => {
        const bag = this.data[ns] ?? {};
        const keys = Object.keys(bag).sort();
        if (!prefix) return keys;
        return keys.filter((k) => k.startsWith(prefix));
      },
      search: (query) => {
        if (!query || query.length > 256) return [];
        const bag = this.data[ns] ?? {};
        const out: Array<{ key: string; value: string }> = [];
        for (const [k, v] of Object.entries(bag)) {
          if (k.includes(query) || v.includes(query)) {
            out.push({ key: k, value: v });
            if (out.length >= KERNEL_SEARCH_LIMIT) break;
          }
        }
        return out;
      },
    };
  }

  listEntries(ns: string): Array<{ key: string; value: string }> {
    const bag = this.data[ns] ?? {};
    return Object.keys(bag)
      .sort()
      .map((key) => ({ key, value: bag[key]! }));
  }

  remove(ns: string, key: string): RoomKvSetResult {
    if (this.sealed) return { ok: false, error: "store is sealed" };
    if (!KERNEL_NS_RE.test(ns) || !KERNEL_KEY_RE.test(key)) {
      return { ok: false, error: "invalid key" };
    }
    const bag = { ...(this.data[ns] ?? {}) };
    if (!(key in bag)) return { ok: false, error: "missing key" };
    delete bag[key];
    if (this.database && this.roomId) {
      this.database.removeModKv(this.roomId, ns, key);
    }
    if (Object.keys(bag).length) this.data[ns] = bag;
    else delete this.data[ns];
    if (!this.database || !this.roomId) this.persistJson();
    return { ok: true };
  }

  seal(): void {
    this.sealed = true;
  }

  deleteFile(): void {
    if (this.database && this.roomId) {
      try {
        this.database.deleteModKv(this.roomId);
      } catch {
        // ignore cleanup failures
      }
    }
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // ignore
    }
  }

  private write(ns: string, key: string, value: string): RoomKvSetResult {
    if (this.sealed) return { ok: false, error: "store is sealed" };
    if (!KERNEL_KEY_RE.test(key)) return { ok: false, error: "invalid key" };
    if (typeof value !== "string") return { ok: false, error: "value must be string" };
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > KERNEL_VALUE_MAX_BYTES) {
      return { ok: false, error: "value exceeds 8KiB" };
    }
    const bag = { ...(this.data[ns] ?? {}) };
    const prev = bag[key];
    const prevBytes = prev !== undefined ? Buffer.byteLength(prev, "utf8") : 0;
    const nextCount =
      prev === undefined ? Object.keys(bag).length + 1 : Object.keys(bag).length;
    if (nextCount > KERNEL_NS_MAX_KEYS) {
      return { ok: false, error: "namespace key limit" };
    }
    let total = 0;
    for (const v of Object.values(bag)) total += Buffer.byteLength(v, "utf8");
    if (total - prevBytes + bytes > KERNEL_NS_MAX_BYTES) {
      return { ok: false, error: "namespace size limit" };
    }
    bag[key] = value;
    if (this.database && this.roomId) {
      this.database.setModKv(this.roomId, ns, key, value);
    }
    this.data[ns] = bag;
    if (!this.database || !this.roomId) this.persistJson();
    return { ok: true };
  }

  private persistJson(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}

function deadNs(error: string): RoomKvNs {
  return {
    get: () => undefined,
    set: () => ({ ok: false, error }),
    list: () => [],
    search: () => [],
  };
}

function loadStore(filePath: string): Record<string, NsMap> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, NsMap> = {};
    for (const [ns, bag] of Object.entries(parsed as Record<string, unknown>)) {
      if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
      const nsMap: NsMap = {};
      for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
        if (typeof v === "string") nsMap[k] = v;
      }
      out[ns] = nsMap;
    }
    return out;
  } catch {
    return {};
  }
}
