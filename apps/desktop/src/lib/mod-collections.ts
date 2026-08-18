/**
 * Mod 选集（collection）：一组命名好的 mod id 列表，创建群聊时可一键套用。
 * 持久化在 localStorage（渲染进程本地），键 `mod-collections.v1`。
 */

export type ModCollection = {
  id: string;
  name: string;
  modIds: string[];
};

const STORAGE_KEY = "mod-collections.v1";

function isCollection(v: unknown): v is ModCollection {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    Array.isArray(o.modIds) &&
    o.modIds.every((m) => typeof m === "string")
  );
}

export function loadModCollections(): ModCollection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCollection);
  } catch {
    return [];
  }
}

export function saveModCollections(list: ModCollection[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage full / unavailable — ignore
  }
}

export function createModCollection(
  list: ModCollection[],
  name: string,
  modIds: string[] = [],
): ModCollection[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return [...list, { id, name: trimmed, modIds: [...new Set(modIds)] }];
}

export function renameModCollection(
  list: ModCollection[],
  id: string,
  name: string,
): ModCollection[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  return list.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
}

export function deleteModCollection(
  list: ModCollection[],
  id: string,
): ModCollection[] {
  return list.filter((c) => c.id !== id);
}

export function setCollectionMods(
  list: ModCollection[],
  id: string,
  modIds: string[],
): ModCollection[] {
  return list.map((c) =>
    c.id === id ? { ...c, modIds: [...new Set(modIds)] } : c,
  );
}

/** 记住创建群聊时上次选用的选集 */
const LAST_KEY = "mod-collections.last";

export function loadLastCollectionId(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveLastCollectionId(id: string): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    // ignore
  }
}
