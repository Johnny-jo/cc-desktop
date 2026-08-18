import { beforeEach, describe, expect, it, vi } from "vitest";

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

vi.stubGlobal("localStorage", makeStorage());
import {
  createModCollection,
  deleteModCollection,
  loadLastCollectionId,
  loadModCollections,
  renameModCollection,
  saveLastCollectionId,
  saveModCollections,
  setCollectionMods,
  type ModCollection,
} from "./mod-collections";

describe("mod-collections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns [] when storage is empty or corrupt", () => {
    expect(loadModCollections()).toEqual([]);
    localStorage.setItem("mod-collections.v1", "{not json");
    expect(loadModCollections()).toEqual([]);
    localStorage.setItem("mod-collections.v1", JSON.stringify({ a: 1 }));
    expect(loadModCollections()).toEqual([]);
    localStorage.setItem(
      "mod-collections.v1",
      JSON.stringify([{ id: 1, name: "x", modIds: [] }, { id: "a", name: "ok", modIds: ["m1"] }]),
    );
    expect(loadModCollections()).toEqual([{ id: "a", name: "ok", modIds: ["m1"] }]);
  });

  it("round-trips through save/load", () => {
    const list: ModCollection[] = [
      { id: "c1", name: "基础包", modIds: ["vote", "shared-memory"] },
    ];
    saveModCollections(list);
    expect(loadModCollections()).toEqual(list);
  });

  it("creates with trimmed name and deduped modIds", () => {
    const list = createModCollection([], "  我的选集  ", ["a", "a", "b"]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("我的选集");
    expect(list[0].modIds).toEqual(["a", "b"]);
    expect(list[0].id).toBeTruthy();
  });

  it("ignores blank names on create/rename", () => {
    expect(createModCollection([], "   ")).toEqual([]);
    const list = createModCollection([], "one");
    expect(renameModCollection(list, list[0].id, "  ")).toEqual(list);
  });

  it("renames, deletes and updates mods by id", () => {
    let list = createModCollection([], "one");
    list = createModCollection(list, "two");
    const [a, b] = list;
    list = renameModCollection(list, a.id, " renamed ");
    expect(list[0].name).toBe("renamed");
    list = setCollectionMods(list, b.id, ["x", "x", "y"]);
    expect(list[1].modIds).toEqual(["x", "y"]);
    list = deleteModCollection(list, a.id);
    expect(list.map((c) => c.id)).toEqual([b.id]);
  });

  it("remembers the last used collection id", () => {
    expect(loadLastCollectionId()).toBe("");
    saveLastCollectionId("c1");
    expect(loadLastCollectionId()).toBe("c1");
    saveLastCollectionId("");
    expect(loadLastCollectionId()).toBe("");
  });
});
