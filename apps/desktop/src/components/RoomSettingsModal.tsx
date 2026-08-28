import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  countOnlineMembers,
  memberIsOnline,
  type RoomSnapshot,
} from "@claude-desktop/shared";
import { fillTemplate } from "../lib/room-mod-ui";
import { useI18n } from "../i18n/useI18n";
import {
  applyRoomKernelProposal,
  deleteRoomKernelMemory,
  disableRoomKernelMod,
  enableRoomKernelMod,
  enableRoomMod,
  endRoomMod,
  getRoomKernelImprove,
  kickRoomMember,
  leaveActiveRoom,
  setRoomAiShare,
  setRoomFilePolicy,
  setRoomMemberRole,
  listRoomKernelMemory,
  listRoomMods,
  proposeRoomKernelImprove,
  rejectRoomKernelProposal,
  renameRoom,
  rollbackRoomKernelImprove,
  setRoomKernelAutonomy,
  setRoomKernelMemory,
  type KernelImproveState,
  type RoomModPack,
} from "../state/room-store";
import { RoomLeaveConfirm } from "./RoomLeaveConfirm";
import { isRoomMuted, setRoomMuted } from "../lib/room-notify";

type Props = {
  room: RoomSnapshot;
  canHost: boolean;
  canAdmin?: boolean;
  offline?: boolean;
  onClose: () => void;
};

export function RoomSettingsModal({
  room,
  canHost,
  canAdmin,
  offline,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [packs, setPacks] = useState<RoomModPack[]>([]);
  const [entries, setEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [improve, setImprove] = useState<KernelImproveState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 概览页：改名草稿 + 退出/解散确认
  const [nameDraft, setNameDraft] = useState(room.name);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // 消息免打扰：本机偏好（localStorage），普通消息不弹通知，@ 仍弹
  const [muted, setMutedState] = useState(() => isRoomMuted(room.roomId));
  const [tab, setTab] = useState<"mods" | "improve" | "memory" | "overview">(
    "mods",
  );
  const memoryOn = Boolean(
    room.kernel?.mods.some((m) => m.id === "shared-memory" && m.state === "active"),
  );

  const refreshMemory = async () => {
    if (!canHost || !memoryOn) {
      setEntries([]);
      return;
    }
    const res = await listRoomKernelMemory(room.roomId);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      return;
    }
    setEntries(res.entries);
  };

  const refreshImprove = async () => {
    if (!canHost) {
      setImprove(null);
      return;
    }
    const res = await getRoomKernelImprove(room.roomId);
    if (!res.ok || !res.state) {
      setImprove(null);
      if (res.error) setErr(res.error);
      return;
    }
    setImprove(res.state);
  };

  useEffect(() => {
    void listRoomMods().then(setPacks);
  }, []);

  useEffect(() => {
    void refreshMemory();
    void refreshImprove();
    // room.kernel changes when enable/disable/apply completes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomId, room.kernel, canHost, memoryOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 改名成功后快照回流 → 草稿跟随最新名字
  useEffect(() => {
    setNameDraft(room.name);
  }, [room.name]);

  const submitRename = async () => {
    const name = nameDraft.trim();
    if (!name || name === room.name) return;
    setBusyId("rename");
    setErr(null);
    const res = await renameRoom(room.roomId, name);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? t.common.error);
  };

  const playPacks = packs.filter((p) => p.hostApi !== 2);
  const kernelPacks = packs.filter((p) => p.hostApi === 2);
  const activeIds = new Set(
    (room.kernel?.mods ?? []).filter((m) => m.state === "active").map((m) => m.id),
  );
  const activePlay = playPacks.find((p) => p.checksum && p.checksum === room.modChecksum);

  const setPlayPack = async (packDir: string) => {
    setBusyId("play");
    setErr(null);
    if (!packDir) {
      if (!room.modChecksum) {
        setBusyId(null);
        return;
      }
      const res = await endRoomMod();
      setBusyId(null);
      if (!res.ok) setErr(res.error ?? t.common.error);
      return;
    }
    const pack = playPacks.find((p) => p.packDir === packDir);
    if (pack && pack.checksum === room.modChecksum) {
      setBusyId(null);
      return;
    }
    if (room.modChecksum) {
      const ended = await endRoomMod();
      if (!ended.ok) {
        setBusyId(null);
        setErr(ended.error ?? t.common.error);
        return;
      }
    }
    const res = await enableRoomMod(room.roomId, packDir);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? t.common.error);
  };

  const togglePack = async (pack: RoomModPack, on: boolean) => {
    setBusyId(pack.id);
    setErr(null);
    const res = on
      ? await enableRoomKernelMod(room.roomId, pack.packDir)
      : await disableRoomKernelMod(room.roomId, pack.id);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? t.common.error);
  };

  const addEntry = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setBusyId("memory-add");
    setErr(null);
    const res = await setRoomKernelMemory(room.roomId, key, valueDraft);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      return;
    }
    setKeyDraft("");
    setValueDraft("");
    await refreshMemory();
  };

  const removeEntry = async (key: string) => {
    setBusyId(`del:${key}`);
    setErr(null);
    const res = await deleteRoomKernelMemory(room.roomId, key);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      return;
    }
    await refreshMemory();
  };

  const changeAutonomy = async (level: 0 | 1 | 2) => {
    setBusyId("autonomy");
    setErr(null);
    const res = await setRoomKernelAutonomy(room.roomId, level);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      return;
    }
    await refreshImprove();
  };

  const proposePack = async (packId: string) => {
    const src = (drafts[packId] ?? "").trim();
    if (!src) return;
    setBusyId(`propose:${packId}`);
    setErr(null);
    const res = await proposeRoomKernelImprove(room.roomId, packId, src);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      await refreshImprove();
      return;
    }
    setDrafts((cur) => ({ ...cur, [packId]: "" }));
    await refreshImprove();
  };

  const decideProposal = async (proposalId: string, accept: boolean) => {
    setBusyId(`prop:${proposalId}`);
    setErr(null);
    const res = accept
      ? await applyRoomKernelProposal(room.roomId, proposalId)
      : await rejectRoomKernelProposal(room.roomId, proposalId);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      await refreshImprove();
      return;
    }
    await refreshImprove();
  };

  const rollbackPack = async (packId: string) => {
    setBusyId(`rollback:${packId}`);
    setErr(null);
    const res = await rollbackRoomKernelImprove(room.roomId, packId);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      return;
    }
    await refreshImprove();
  };

  const kickMember = async (userId: string) => {
    setBusyId(`kick:${userId}`);
    setErr(null);
    const res = await kickRoomMember(room.roomId, userId);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? t.common.error);
  };

  const me = room.members.find((m) => m.userId === room.localUserId);
  const filePolicy = me?.filePolicy ?? "ask";
  const aiShareOn = me?.aiShare === "on";
  const canKick = Boolean(canAdmin) && room.status === "open";

  const changeRole = async (userId: string, role: "admin" | "member") => {
    setBusyId(`role:${userId}`);
    setErr(null);
    const res = await setRoomMemberRole(room.roomId, userId, role);
    setBusyId(null);
    if (!res.ok) setErr(res.error ?? t.common.error);
  };

  const loadedIds = new Set((room.kernel?.mods ?? []).map((m) => m.id));
  const enabledKernel = kernelPacks.filter((p) => loadedIds.has(p.id));
  const pending = (improve?.proposals ?? []).filter((p) => p.status === "pending");
  const canRollback = new Set(improve?.canRollback ?? []);

  return createPortal(
    <div className="room-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="room-modal room-settings-modal"
        role="dialog"
        aria-label={t.room.settingsTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="room-modal-head">
          <h3>{t.room.settingsTitle}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="room-settings-layout">
          <nav className="settings-nav">
            {(
              [
                ["mods", t.room.settingsPlay],
                ["improve", t.room.settingsImprove],
                ["memory", t.room.settingsMemory],
                ["overview", t.room.settingsOverview],
              ] as Array<[typeof tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`settings-nav-item${tab === key ? " active" : ""}`}
                onClick={() => setTab(key)}
              >
                <span className="settings-nav-label">{label}</span>
              </button>
            ))}
          </nav>

          <div className="room-modal-body room-settings-content">
          {tab === "overview" ? (
            <section className="room-settings-section room-overview">
              <div className="room-overview-card room-overview-head">
                <div className="room-overview-title">{room.name}</div>
                <div className="room-overview-meta">
                  {offline
                    ? t.room.offline
                    : room.status === "open"
                      ? fillTemplate(t.room.peopleOnline, {
                          n: String(
                            room.onlineCount ??
                              countOnlineMembers(room.members),
                          ),
                        })
                      : "已结束"}{" "}
                  · {t.room.settingsPort.replace("{port}", String(room.port))}
                </div>
                {canHost && room.status === "open" ? (
                  <div className="room-rename-row">
                    <input
                      value={nameDraft}
                      maxLength={40}
                      placeholder="群聊名"
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRename();
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={
                        busyId === "rename" ||
                        !nameDraft.trim() ||
                        nameDraft.trim() === room.name
                      }
                      onClick={() => void submitRename()}
                    >
                      保存
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="room-overview-card">
                <div className="room-overview-card-title">通知</div>
                <label className="room-check room-mute-check">
                  <input
                    type="checkbox"
                    checked={muted}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setRoomMuted(room.roomId, on);
                      setMutedState(on);
                    }}
                  />
                  消息免打扰
                </label>
                <p className="settings-hint room-mute-hint">
                  普通消息不弹桌面通知，@ 我的仍会弹
                </p>
              </div>

              <div className="room-overview-card">
                <div className="room-overview-card-title">
                  成员 {room.memberCount}
                  {room.status === "open"
                    ? ` · ${fillTemplate(t.room.peopleOnline, {
                        n: String(
                          room.onlineCount ?? countOnlineMembers(room.members),
                        ),
                      })}`
                    : ""}
                </div>
                <ul className="room-member-list">
                  {room.members.map((m) => (
                    <li key={m.userId} className="room-member-row">
                      <span className="room-member-name">
                        {m.name}
                        {m.role === "host" ? (
                          <span className="room-member-badge">群主</span>
                        ) : m.role === "admin" ? (
                          <span className="room-member-badge">管理员</span>
                        ) : null}
                        <span
                          className={`room-member-badge${
                            memberIsOnline(m) ? "" : " is-off"
                          }`}
                        >
                          {memberIsOnline(m)
                            ? t.room.memberOnline
                            : t.room.memberOffline}
                        </span>
                      </span>
                      {canHost &&
                      room.status === "open" &&
                      m.role !== "host" &&
                      m.userId !== room.localUserId ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busyId === `role:${m.userId}`}
                          onClick={() =>
                            void changeRole(
                              m.userId,
                              m.role === "admin" ? "member" : "admin",
                            )
                          }
                        >
                          {m.role === "admin" ? "取消管理员" : "设为管理员"}
                        </button>
                      ) : null}
                      {canKick &&
                      m.role !== "host" &&
                      !(me?.role === "admin" && m.role === "admin") &&
                      m.userId !== room.localUserId ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busyId === `kick:${m.userId}`}
                          onClick={() => void kickMember(m.userId)}
                        >
                          {t.room.kick}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>

              {room.status === "open" ? (
                <div className="room-overview-card">
                  <div className="room-overview-card-title">我的项目权限</div>
                  <p className="settings-hint">
                    别人的 Agent 以你当前打开的项目为工作目录时
                  </p>
                  {(["ask", "allow", "deny"] as const).map((p) => (
                    <label key={p} className="room-check">
                      <input
                        type="radio"
                        name="file-policy"
                        checked={filePolicy === p}
                        onChange={() => void setRoomFilePolicy(room.roomId, p)}
                      />
                      {p === "allow"
                        ? "完全允许操作"
                        : p === "deny"
                          ? "禁止操作"
                          : "审批操作"}
                    </label>
                  ))}
                  <label className="room-check" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={aiShareOn}
                      onChange={(e) =>
                        void setRoomAiShare(room.roomId, e.target.checked)
                      }
                    />
                    允许本房席位借用我的 AI（模型 / 额度）
                  </label>
                </div>
              ) : null}

              <div className="room-danger-zone">
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setConfirmLeave(true)}
                >
                  {canHost && room.status === "open"
                    ? t.room.leaveConfirmYesHost
                    : t.room.leaveConfirmYes}
                </button>
              </div>
            </section>
          ) : null}

          {tab === "mods" ? (
            <div className="room-mods-page">
              {!canHost ? <p className="settings-hint">{t.room.settingsGuestHint}</p> : null}
              {playPacks.length === 0 && kernelPacks.length === 0 ? (
                <p className="settings-hint">{t.room.settingsMemoryEmpty}</p>
              ) : null}

              {playPacks.length ? (
                <>
                  <div className="room-mods-group-title">
                    {t.room.settingsPlay}
                    <span className="settings-hint"> · 单选</span>
                  </div>
                  {playPacks.map((pack) => {
                    const on = activePlay?.packDir === pack.packDir;
                    return (
                      <div key={pack.packDir} className="mods-row">
                        <div className="mods-row-main">
                          <span className="mods-row-name">{pack.name}</span>
                          <span className="mods-row-meta">
                            {pack.id}@v{pack.version}
                            {pack.source === "cache" ? ` · ${t.room.packCached}` : ""}
                          </span>
                        </div>
                        <div className="mods-row-actions">
                          <button
                            type="button"
                            className={`btn btn-sm${on ? " btn-primary" : ""}`}
                            disabled={!canHost || room.status !== "open" || busyId === "play"}
                            onClick={() => void setPlayPack(on ? "" : pack.packDir)}
                          >
                            {on ? t.room.modDisable : t.room.modEnable}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : null}

              {kernelPacks.length ? (
                <>
                  <div className="room-mods-group-title">
                    {t.room.settingsExtensions}
                    <span className="settings-hint"> · 可多选</span>
                  </div>
                  <p className="settings-hint">{t.room.settingsExtHint}</p>
                  {kernelPacks.map((pack) => {
                    const on = activeIds.has(pack.id);
                    const live = room.kernel?.mods.find((m) => m.id === pack.id);
                    return (
                      <div key={pack.packDir} className="mods-row">
                        <div className="mods-row-main">
                          <span className="mods-row-name">{pack.name}</span>
                          <span className="mods-row-meta">
                            {pack.id}@v{pack.version}
                            {pack.source === "cache" ? ` · ${t.room.packCached}` : ""}
                            {live?.state && live.state !== "active" ? ` · ${live.state}` : ""}
                            {live?.pendingReason ? ` · ${live.pendingReason}` : ""}
                            {live?.failedReason ? ` · ${live.failedReason}` : ""}
                          </span>
                        </div>
                        <div className="mods-row-actions">
                          <button
                            type="button"
                            className={`btn btn-sm${on ? " btn-primary" : ""}`}
                            disabled={!canHost || room.status !== "open" || busyId === pack.id}
                            onClick={() => void togglePack(pack, !on)}
                          >
                            {on ? t.room.modDisable : t.room.modEnable}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "improve" ? (
            <section className="room-settings-section">
              <h4>{t.room.settingsImprove}</h4>
              <p className="settings-hint">{t.room.settingsImproveHint}</p>
              {!canHost ? (
                <p className="settings-hint">{t.room.settingsGuestHint}</p>
              ) : (
                <>
                  <label className="room-improve-actions">
                    <span className="settings-hint">{t.room.settingsAutonomy}</span>
                    <select
                      className="select"
                      value={improve?.autonomy ?? 0}
                      disabled={room.status !== "open" || busyId === "autonomy"}
                      onChange={(e) =>
                        void changeAutonomy(Number(e.target.value) as 0 | 1 | 2)
                      }
                    >
                      <option value={0}>{t.room.settingsAutonomyL0}</option>
                      <option value={1}>{t.room.settingsAutonomyL1}</option>
                      <option value={2}>{t.room.settingsAutonomyL2}</option>
                    </select>
                  </label>
                  {enabledKernel.length === 0 ? (
                    <p className="settings-hint">{t.room.settingsExtOff}</p>
                  ) : (
                    enabledKernel.map((pack) => (
                      <div key={pack.id} className="room-improve-pack">
                        <span>
                          {pack.name}{" "}
                          <span className="settings-hint">{pack.id}</span>
                        </span>
                        <textarea
                          className="room-improve-src"
                          placeholder={t.room.settingsProposeHint}
                          value={drafts[pack.id] ?? ""}
                          disabled={room.status !== "open"}
                          onChange={(e) =>
                            setDrafts((cur) => ({ ...cur, [pack.id]: e.target.value }))
                          }
                        />
                        <div className="room-improve-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={
                              room.status !== "open" ||
                              !(drafts[pack.id] ?? "").trim() ||
                              busyId === `propose:${pack.id}`
                            }
                            onClick={() => void proposePack(pack.id)}
                          >
                            {t.room.settingsPropose}
                          </button>
                          {canRollback.has(pack.id) ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={
                                room.status !== "open" || busyId === `rollback:${pack.id}`
                              }
                              onClick={() => void rollbackPack(pack.id)}
                            >
                              {t.room.settingsRollback}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                  <h4>{t.room.settingsPending}</h4>
                  {pending.length === 0 ? (
                    <p className="settings-hint">{t.room.settingsNoPending}</p>
                  ) : (
                    <ul className="room-improve-pending">
                      {pending.map((prop) => (
                        <li key={prop.id}>
                          <span>
                            {prop.packId}
                            {prop.note ? ` · ${prop.note}` : ""}
                          </span>
                          <textarea
                            className="room-improve-src"
                            readOnly
                            value={prop.modJs}
                          />
                          <div className="room-improve-actions">
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={
                                room.status !== "open" || busyId === `prop:${prop.id}`
                              }
                              onClick={() => void decideProposal(prop.id, true)}
                            >
                              {t.room.settingsApplyProposal}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={
                                room.status !== "open" || busyId === `prop:${prop.id}`
                              }
                              onClick={() => void decideProposal(prop.id, false)}
                            >
                              {t.room.settingsRejectProposal}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          ) : null}

          {tab === "memory" ? (
            <section className="room-settings-section">
              <h4>{t.room.settingsMemory}</h4>
              <p className="settings-hint">{t.room.settingsMemoryHint}</p>
              {!memoryOn ? (
                <p className="settings-hint">{t.room.settingsMemoryNeedPack}</p>
              ) : !canHost ? (
                <p className="settings-hint">{t.room.settingsGuestHint}</p>
              ) : (
                <>
                  {entries.length === 0 ? (
                    <p className="settings-hint">{t.room.settingsMemoryEmpty}</p>
                  ) : (
                    <ul className="room-memory-list">
                      {entries.map((row) => (
                        <li key={row.key} className="room-memory-row">
                          <code className="room-memory-key">{row.key}</code>
                          <span className="room-memory-val">{row.value}</span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busyId === `del:${row.key}` || room.status !== "open"}
                            onClick={() => void removeEntry(row.key)}
                          >
                            {t.common.delete}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="room-memory-add">
                    <input
                      placeholder={t.room.settingsMemoryKey}
                      value={keyDraft}
                      disabled={room.status !== "open"}
                      onChange={(e) => setKeyDraft(e.target.value)}
                    />
                    <input
                      placeholder={t.room.settingsMemoryValue}
                      value={valueDraft}
                      disabled={room.status !== "open"}
                      onChange={(e) => setValueDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!keyDraft.trim() || room.status !== "open" || busyId === "memory-add"}
                      onClick={() => void addEntry()}
                    >
                      {t.room.settingsMemoryAdd}
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : null}

          {err ? <p className="room-err">{err}</p> : null}
          </div>
        </div>

        <footer className="room-modal-foot">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {t.common.close}
          </button>
        </footer>
      </div>
      {confirmLeave ? (
        <RoomLeaveConfirm
          isHost={canHost && room.status === "open"}
          roomName={room.name}
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            onClose();
            void leaveActiveRoom();
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
