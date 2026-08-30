import React, { useCallback, useEffect, useState } from "react";
import { getDesktop, hasDesktopApi } from "../../lib/desktop-api";
import { ToggleSwitch } from "../ToggleSwitch";
import {
  createModCollection,
  deleteModCollection,
  loadModCollections,
  renameModCollection,
  saveModCollections,
  setCollectionMods,
  type ModCollection,
} from "../../lib/mod-collections";
import {
  disableRoomKernelMod,
  enableRoomKernelMod,
  enableRoomMod,
  endRoomMod,
  listRoomMods,
  useRoomStore,
  type RoomModPack,
} from "../../state/room-store";

type Tab = "manage" | "collections" | "guide";

/** 设置里的「群聊设置」页：Mod 管理 / 选集设置 / 如何制作 Mod */
export function RoomModsSettings() {
  const [tab, setTab] = useState<Tab>("manage");
  const [packs, setPacks] = useState<RoomModPack[]>([]);
  const [collections, setCollections] = useState<ModCollection[]>(() =>
    loadModCollections(),
  );
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeRoom = useRoomStore((s) => s.activeRoom);
  const rooms = useRoomStore((s) => s.rooms);
  const canHost = Boolean(
    activeRoom &&
      activeRoom.status === "open" &&
      (rooms.find((r) => r.roomId === activeRoom.roomId)?.role ?? "member") ===
        "host",
  );

  const refreshPacks = useCallback(async () => {
    setPacks(await listRoomMods());
  }, []);

  useEffect(() => {
    void refreshPacks();
  }, [refreshPacks]);

  const updateCollections = (next: ModCollection[]) => {
    setCollections(next);
    saveModCollections(next);
  };

  const activeKernelIds = new Set(
    (activeRoom?.kernel?.mods ?? [])
      .filter((m) => m.state === "active")
      .map((m) => m.id),
  );

  const toggleMod = async (pack: RoomModPack, on: boolean) => {
    if (!activeRoom || !canHost) return;
    setBusyId(pack.id);
    setErr(null);
    const res =
      pack.hostApi === 2
        ? on
          ? await enableRoomKernelMod(activeRoom.roomId, pack.packDir)
          : await disableRoomKernelMod(activeRoom.roomId, pack.id)
        : on
          ? await enableRoomMod(activeRoom.roomId, pack.packDir)
          : await endRoomMod();
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? "操作失败");
  };

  const isActive = (pack: RoomModPack): boolean => {
    if (!activeRoom) return false;
    if (pack.hostApi === 2) return activeKernelIds.has(pack.id);
    return Boolean(pack.checksum && pack.checksum === activeRoom.modChecksum);
  };

  const onDelete = async (pack: RoomModPack) => {
    if (!hasDesktopApi("modsDelete")) return;
    if (!window.confirm(`确定删除 Mod「${pack.name}」？此操作不可恢复。`)) return;
    setBusyId(pack.id);
    setErr(null);
    const res = await getDesktop().modsDelete(pack.packDir);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? "删除失败");
      return;
    }
    setNote(`已删除「${pack.name}」`);
    await refreshPacks();
  };

  const onOpenDir = async (pack: RoomModPack) => {
    if (!hasDesktopApi("modsOpenDir")) return;
    const res = await getDesktop().modsOpenDir(pack.packDir);
    if (!res.ok) setErr(res.error ?? "打开文件夹失败");
  };

  return (
    <div className="mods-settings">
      <div className="mods-tabs" role="tablist">
        {(
          [
            ["manage", "Mod 管理"],
            ["collections", "选集设置"],
            ["guide", "如何制作 Mod"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`mods-tab${tab === key ? " active" : ""}`}
            onClick={() => {
              setTab(key);
              setErr(null);
              setNote(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {err ? <p className="settings-error">{err}</p> : null}
      {note ? <p className="settings-ok">{note}</p> : null}

      {tab === "manage" ? (
        <ModManageTab
          packs={packs}
          canHost={canHost}
          busyId={busyId}
          isActive={isActive}
          onToggle={toggleMod}
          onDelete={onDelete}
          onOpenDir={onOpenDir}
        />
      ) : null}

      {tab === "collections" ? (
        <CollectionsTab
          packs={packs}
          collections={collections}
          onChange={updateCollections}
        />
      ) : null}

      {tab === "guide" ? (
        <ModGuideTab
          onScaffolded={async (packDir) => {
            await refreshPacks();
            setNote("模板已生成，已打开所在文件夹");
            if (hasDesktopApi("modsOpenDir")) {
              await getDesktop().modsOpenDir(packDir);
            }
          }}
          onError={setErr}
        />
      ) : null}
    </div>
  );
}

function ModManageTab(props: {
  packs: RoomModPack[];
  canHost: boolean;
  busyId: string | null;
  isActive: (p: RoomModPack) => boolean;
  onToggle: (p: RoomModPack, on: boolean) => void;
  onDelete: (p: RoomModPack) => void;
  onOpenDir: (p: RoomModPack) => void;
}) {
  const { packs, canHost, busyId } = props;
  if (!packs.length) {
    return <p className="settings-hint">未发现任何 Mod。</p>;
  }
  return (
    <div className="mods-list">
      {!canHost ? (
        <p className="settings-hint">
          启用 / 禁用需要你是某个进行中的群聊的群主；进入群聊后此处可操作。
        </p>
      ) : null}
      {packs.map((p) => {
        const active = props.isActive(p);
        return (
          <div key={`${p.hostApi}-${p.id}-${p.checksum}`} className="mods-row">
            <div className="mods-row-main">
              <span className="mods-row-name">{p.name}</span>
              <span className="mods-row-meta">
                v{p.version} · {p.hostApi === 2 ? "群聊扩展" : "玩法模组"} ·{" "}
                {p.source === "cache" ? "本地/缓存" : "内置"}
              </span>
            </div>
            <div className="mods-row-actions">
              <ToggleSwitch
                checked={active}
                label={active ? `停用 ${p.name}` : `启用 ${p.name}`}
                disabled={!canHost || busyId === p.id}
                onCheckedChange={(next) => void props.onToggle(p, next)}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void props.onOpenDir(p)}
              >
                打开文件夹
              </button>
              {p.source === "cache" ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busyId === p.id}
                  onClick={() => void props.onDelete(p)}
                >
                  删除
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CollectionsTab(props: {
  packs: RoomModPack[];
  collections: ModCollection[];
  onChange: (next: ModCollection[]) => void;
}) {
  const { packs, collections, onChange } = props;
  const [selectedId, setSelectedId] = useState<string | null>(
    collections[0]?.id ?? null,
  );
  const [newName, setNewName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  const create = () => {
    const next = createModCollection(collections, newName);
    if (next === collections) return;
    onChange(next);
    setSelectedId(next[next.length - 1].id);
    setNewName("");
  };

  return (
    <div className="mods-coll-layout">
      {/* 左列：选集列表（Paradox 启动器式） */}
      <div className="mods-coll-list">
        <div className="mods-coll-list-head">选集（{collections.length}）</div>
        <div className="mods-coll-items">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`mods-coll-item${c.id === selectedId ? " active" : ""}`}
              onClick={() => {
                setSelectedId(c.id);
                setEditingName(false);
              }}
            >
              <span className="mods-coll-item-name">{c.name}</span>
              <span className="mods-coll-item-count">{c.modIds.length} 个 Mod</span>
            </button>
          ))}
          {!collections.length ? (
            <p className="settings-hint" style={{ padding: "8px 12px" }}>
              还没有选集
            </p>
          ) : null}
        </div>
        <div className="mods-coll-new">
          <input
            placeholder="新选集名称…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!newName.trim()}
            onClick={create}
          >
            新建
          </button>
        </div>
      </div>

      {/* 右列：选中选集的详情 */}
      <div className="mods-coll-detail">
        {!selected ? (
          <p className="settings-hint">
            选集是一组 Mod 的命名组合，创建群聊时可以一键套用。左侧选择或新建一个选集。
          </p>
        ) : (
          <>
            <div className="mods-coll-detail-head">
              {editingName ? (
                <>
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onChange(renameModCollection(collections, selected.id, nameDraft));
                        setEditingName(false);
                      }
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      onChange(renameModCollection(collections, selected.id, nameDraft));
                      setEditingName(false);
                    }}
                  >
                    确定
                  </button>
                </>
              ) : (
                <>
                  <span className="mods-coll-detail-name">{selected.name}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setEditingName(true);
                      setNameDraft(selected.name);
                    }}
                  >
                    重命名
                  </button>
                </>
              )}
              <span style={{ marginLeft: "auto" }} />
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  onChange(deleteModCollection(collections, selected.id));
                  setSelectedId(null);
                }}
              >
                删除选集
              </button>
            </div>

            <div className="mods-coll-detail-sub">包含的 Mod</div>
            <div className="mods-coll-detail-mods">
              {packs.map((p) => {
                const key = `${p.hostApi === 2 ? "k" : "p"}:${p.id}`;
                const checked = selected.modIds.includes(key);
                return (
                  <label key={key} className="mods-coll-mod">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...selected.modIds, key]
                          : selected.modIds.filter((m) => m !== key);
                        onChange(setCollectionMods(collections, selected.id, next));
                      }}
                    />
                    <span className="mods-coll-mod-name">{p.name}</span>
                    <span className="mods-coll-mod-meta">
                      {p.hostApi === 2 ? "扩展" : "玩法"} · v{p.version}
                    </span>
                  </label>
                );
              })}
              {!packs.length ? (
                <p className="settings-hint">未发现任何 Mod。</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModGuideTab(props: {
  onScaffolded: (packDir: string) => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const scaffold = async () => {
    if (!hasDesktopApi("modsScaffold")) {
      props.onError("请完全重启应用后再使用 Mod 制作工具");
      return;
    }
    setBusy(true);
    props.onError(null);
    const res = await getDesktop().modsScaffold({ id, name });
    setBusy(false);
    if (!res.ok || !res.packDir) {
      props.onError(res.error ?? "生成失败");
      return;
    }
    setId("");
    setName("");
    await props.onScaffolded(res.packDir);
  };

  return (
    <div className="mods-guide">
      <div className="settings-context-limits-title">Mod 是什么</div>
      <p className="settings-hint">
        Mod 是一个文件夹，内含 <code>manifest.json</code>（声明 id / 名称 /
        权限 / hooks）和一个代码文件。群聊扩展（hostApi 2）使用{" "}
        <code>mod.js</code>，导出 <code>activate(ctx)</code>{" "}
        函数，可以拦截聊天消息、提供共享能力、跑定时任务。
      </p>

      <div className="settings-context-limits-title">manifest.json 示例</div>
      <pre className="mods-guide-code">{`{
  "id": "my-mod",
  "name": "我的 Mod",
  "version": "0.1.0",
  "hostApi": 2,
  "inject": [],
  "provides": [],
  "permissions": [],
  "hooks": ["room.chat.in"]
}`}</pre>

      <div className="settings-context-limits-title">mod.js 示例</div>
      <pre className="mods-guide-code">{`export function activate(ctx) {
  ctx.hooks.on("room.chat.in", (env) => {
    if (env.text === "stop") {
      return { action: "drop", reason: "blocked" };
    }
    return { action: "continue" };
  });
}`}</pre>

      <p className="settings-hint">
        要点：<code>hooks</code> 目前只允许 <code>room.chat.in</code>；权限只有{" "}
        <code>storage:room</code> / <code>schedule:room</code>；沙箱内禁止{" "}
        <code>require / import / eval / setTimeout</code>{" "}
        等。完整文档见仓库 <code>docs/mods/hostapi-2.md</code>，现成示例见{" "}
        <code>resources/mods/</code> 下的内置 Mod。
      </p>

      <div className="settings-context-limits-title">新建 Mod 模板</div>
      <p className="settings-hint">
        在本地 Mod 目录生成一个可运行的骨架，生成后会出现在「Mod
        管理」列表中，可直接编辑后启用。
      </p>
      <label className="settings-field">
        Mod id（小写字母 / 数字 / 连字符）
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="my-mod"
          spellCheck={false}
        />
      </label>
      <label className="settings-field">
        显示名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="我的 Mod"
        />
      </label>
      <div className="settings-inline-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !id.trim()}
          onClick={() => void scaffold()}
        >
          {busy ? "生成中…" : "生成模板并打开文件夹"}
        </button>
      </div>
    </div>
  );
}
