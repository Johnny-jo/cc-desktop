import React, { useCallback, useEffect, useState } from "react";
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
import { ToggleSwitch } from "./ToggleSwitch";

type Props = {
  room: RoomSnapshot;
  canHost: boolean;
  canAdmin?: boolean;
  offline?: boolean;
  onClose: () => void;
};

type RoomSettingsTab = "mods" | "improve" | "memory" | "overview";

function RoomSettingsTabIcon({ tab }: { tab: RoomSettingsTab }) {
  if (tab === "overview") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="5.5" cy="5.2" r="2.2" stroke="currentColor" strokeWidth="1.35" />
        <path d="M1.8 13c.2-2.2 1.7-3.6 3.7-3.6S9 10.8 9.2 13" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <path d="M10.2 4.2h4M10.2 7h4M11.2 9.8h3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }
  if (tab === "memory") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <ellipse cx="8" cy="3.8" rx="5" ry="2.1" stroke="currentColor" strokeWidth="1.35" />
        <path d="M3 3.8v4c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1v-4M3 7.8v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-4" stroke="currentColor" strokeWidth="1.35" />
      </svg>
    );
  }
  if (tab === "improve") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M8 1.8l1.2 3 3 .5-2.3 2.1.6 3L8 9l-2.5 1.4.6-3-2.3-2.1 3-.5L8 1.8Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="M3.2 11.5 2.5 14l2.5-.8M12.8 11.5l.7 2.5-2.5-.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m8 1.8 5.2 2.8v6.8L8 14.2l-5.2-2.8V4.6L8 1.8Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M2.9 4.8 8 7.6l5.1-2.8M8 7.6v6.3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

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
  const [savedName, setSavedName] = useState(room.name);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  // 消息免打扰：本机偏好（localStorage），普通消息不弹通知，@ 仍弹
  const [muted, setMutedState] = useState(() => isRoomMuted(room.roomId));
  const [tab, setTab] = useState<RoomSettingsTab>("overview");
  const nameValid = Boolean(nameDraft.trim());
  const nameDirty = Boolean(
    canHost &&
      room.status === "open" &&
      nameDraft.trim() !== savedName,
  );
  const requestClose = useCallback(() => {
    if (confirmLeave) {
      setConfirmLeave(false);
      return;
    }
    if (nameDirty) {
      setClosePending(true);
      return;
    }
    onClose();
  }, [confirmLeave, nameDirty, onClose]);
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
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // 改名成功后快照回流 → 草稿跟随最新名字
  useEffect(() => {
    setNameDraft((current) => (current === savedName ? room.name : current));
    setSavedName(room.name);
    // savedName intentionally reflects the last snapshot seen by this modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.name]);

  const submitRename = async () => {
    const name = nameDraft.trim();
    if (!name || name === savedName) return;
    setBusyId("rename");
    setErr(null);
    const res = await renameRoom(room.roomId, name);
    setBusyId(null);
    if (!res.ok) {
      setErr(res.error ?? t.common.error);
      return;
    }
    setSavedName(name);
    setNameSaved(true);
    setClosePending(false);
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
    <div className="room-modal-overlay" role="presentation" onClick={requestClose}>
      <div
        className="room-modal room-settings-modal"
        role="dialog"
        aria-label={t.room.settingsTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="room-modal-head">
          <div className="room-modal-title">
            <h3>{t.room.settingsTitle}</h3>
            <p>{room.name}</p>
          </div>
          <button
            type="button"
            className="settings-close-btn"
            title={t.common.close}
            aria-label={t.common.close}
            onClick={requestClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="room-settings-layout">
          <nav className="settings-nav">
            {(
              [
                ["overview", t.room.settingsOverview],
                ["mods", t.room.settingsPlay],
                ["improve", t.room.settingsImprove],
                ["memory", t.room.settingsMemory],
              ] as Array<[typeof tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`settings-nav-item${tab === key ? " active" : ""}`}
                onClick={() => setTab(key)}
              >
                <span className="room-settings-nav-icon">
                  <RoomSettingsTabIcon tab={key} />
                </span>
                <span className="settings-nav-label">{label}</span>
              </button>
            ))}
          </nav>

          <div className="room-modal-body room-settings-content">
          {tab === "overview" ? (
            <section className="room-settings-section room-overview">
              <div className="room-overview-identity">
                <div className="room-overview-room-icon" aria-hidden>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="16.5" cy="9.5" r="2.3" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M3.5 19c0-3 2.4-5 5.5-5s5.5 2 5.5 5M15.5 14.7c2.3.3 4 1.8 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="room-overview-identity-main">
                  <label className="room-overview-card-title" htmlFor="room-name-input">
                    群聊名称
                  </label>
                  {canHost && room.status === "open" ? (
                    <input
                      id="room-name-input"
                      className="room-name-input"
                      value={nameDraft}
                      maxLength={40}
                      placeholder="群聊名称"
                      onChange={(e) => {
                        setNameDraft(e.target.value);
                        setNameSaved(false);
                        setClosePending(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && nameDirty && nameValid) void submitRename();
                      }}
                    />
                  ) : (
                    <div className="room-overview-title">{room.name}</div>
                  )}
                  <div className="room-overview-meta">
                    <span className={`room-state-pill${room.status === "open" && !offline ? " is-online" : ""}`}>
                      {offline
                        ? t.room.offline
                        : room.status === "open"
                          ? fillTemplate(t.room.peopleOnline, {
                              n: String(room.onlineCount ?? countOnlineMembers(room.members)),
                            })
                          : "已结束"}
                    </span>
                    <span>{t.room.settingsPort.replace("{port}", String(room.port))}</span>
                  </div>
                </div>
              </div>

              <div className="room-overview-grid">
                <div className="room-overview-card room-setting-card">
                  <div className="room-setting-card-head">
                    <span className="room-setting-card-icon" aria-hidden>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M4 6.7c0-2.3 1.3-3.9 4-3.9s4 1.6 4 3.9v2.4l1.2 1.6H2.8L4 9.1V6.7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                        <path d="M6.3 12.4c.3.7.9 1 1.7 1s1.4-.3 1.7-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </span>
                    <div>
                      <div className="room-setting-card-title">消息免打扰</div>
                      <p>仍会提醒 @ 我的消息</p>
                    </div>
                    <ToggleSwitch
                      checked={muted}
                      label={muted ? "关闭消息免打扰" : "开启消息免打扰"}
                      onCheckedChange={(on) => {
                        setRoomMuted(room.roomId, on);
                        setMutedState(on);
                      }}
                    />
                  </div>
                </div>

                {room.status === "open" ? (
                  <div className="room-overview-card room-permission-card">
                    <div className="room-overview-card-title">我的项目权限</div>
                    <div className="room-permission-options">
                      {(["ask", "allow", "deny"] as const).map((p) => (
                        <label key={p} className={`room-permission-option${filePolicy === p ? " active" : ""}`}>
                          <input
                            type="radio"
                            name="file-policy"
                            checked={filePolicy === p}
                            onChange={() => void setRoomFilePolicy(room.roomId, p)}
                          />
                          {p === "allow" ? "允许" : p === "deny" ? "禁止" : "审批"}
                        </label>
                      ))}
                    </div>
                    <div className="room-ai-share-row">
                      <span>允许席位借用我的 AI</span>
                      <ToggleSwitch
                        checked={aiShareOn}
                        label={aiShareOn ? "停用 AI 借用" : "启用 AI 借用"}
                        onCheckedChange={(on) => void setRoomAiShare(room.roomId, on)}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="room-overview-card room-members-card">
                <div className="room-members-head">
                  <div>
                    <div className="room-overview-card-title">成员</div>
                    <p>{room.memberCount} 人 · {room.onlineCount ?? countOnlineMembers(room.members)} 在线</p>
                  </div>
                  <span className="room-members-count">{room.memberCount}</span>
                </div>
                <ul className="room-member-list">
                  {room.members.map((m) => {
                    const online = memberIsOnline(m);
                    const roleLabel = m.role === "host" ? "群主" : m.role === "admin" ? "管理员" : null;
                    return (
                      <li key={m.userId} className="room-member-row">
                        <span className="room-member-avatar" aria-hidden>
                          {m.name.trim().slice(0, 1).toUpperCase() || "?"}
                          <span className={`room-member-presence${online ? " is-online" : ""}`} />
                        </span>
                        <span className="room-member-main">
                          <span className="room-member-name">
                            {m.name}
                            {m.userId === room.localUserId ? <span className="room-member-self">我</span> : null}
                          </span>
                          <span className="room-member-detail">
                            {roleLabel ?? "成员"} · {online ? t.room.memberOnline : t.room.memberOffline}
                          </span>
                        </span>
                        <span className="room-member-actions">
                          {canHost && room.status === "open" && m.role !== "host" && m.userId !== room.localUserId ? (
                            <button
                              type="button"
                              className={`room-action-icon${m.role === "admin" ? " is-active" : ""}`}
                              title={m.role === "admin" ? "取消管理员" : "设为管理员"}
                              aria-label={m.role === "admin" ? `取消 ${m.name} 的管理员` : `将 ${m.name} 设为管理员`}
                              disabled={busyId === `role:${m.userId}`}
                              onClick={() => void changeRole(m.userId, m.role === "admin" ? "member" : "admin")}
                            >
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                                <path d="M8 1.8 13 4v3.4c0 3.1-2 5.5-5 6.8-3-1.3-5-3.7-5-6.8V4l5-2.2Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                                <path d="m5.8 8 1.4 1.4 3-3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          ) : null}
                          {canKick && m.role !== "host" && !(me?.role === "admin" && m.role === "admin") && m.userId !== room.localUserId ? (
                            <button
                              type="button"
                              className="room-action-icon is-danger"
                              title={t.room.kick}
                              aria-label={`${t.room.kick} ${m.name}`}
                              disabled={busyId === `kick:${m.userId}`}
                              onClick={() => void kickMember(m.userId)}
                            >
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                                <circle cx="6.2" cy="5" r="2.3" stroke="currentColor" strokeWidth="1.35" />
                                <path d="M2.3 13c.2-2.2 1.7-3.6 3.9-3.6 1 0 1.9.3 2.5.8M10.5 8.8l3.2 3.2M13.7 8.8l-3.2 3.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                              </svg>
                            </button>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="room-danger-zone">
                <div className="room-danger-copy">
                  <span className="room-danger-title">
                    {canHost && room.status === "open" ? "解散群聊" : "退出群聊"}
                  </span>
                  <span>{canHost && room.status === "open" ? "所有成员都会断开连接" : "本机将离开当前群聊"}</span>
                </div>
                <button
                  type="button"
                  className="room-action-icon is-danger room-leave-icon"
                  title={canHost && room.status === "open" ? t.room.leaveConfirmYesHost : t.room.leaveConfirmYes}
                  aria-label={canHost && room.status === "open" ? t.room.leaveConfirmYesHost : t.room.leaveConfirmYes}
                  onClick={() => setConfirmLeave(true)}
                >
                  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M6.8 2.3H3.2v11.4h3.6M9.7 5.2 12.5 8l-2.8 2.8M5.8 8h6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
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
                          <ToggleSwitch
                            checked={on}
                            label={on ? `停用 ${pack.name}` : `启用 ${pack.name}`}
                            disabled={!canHost || room.status !== "open" || busyId === "play"}
                            onCheckedChange={(next) => void setPlayPack(next ? pack.packDir : "")}
                          />
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
                          <ToggleSwitch
                            checked={on}
                            label={on ? `停用 ${pack.name}` : `启用 ${pack.name}`}
                            disabled={!canHost || room.status !== "open" || busyId === pack.id}
                            onCheckedChange={(next) => void togglePack(pack, next)}
                          />
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

          </div>
        </div>

        <footer className={`room-modal-foot room-settings-foot${closePending ? " is-confirming" : ""}`}>
          <div className="room-settings-save-state" role="status" aria-live="polite">
            {closePending ? (
              <span className="settings-save-warning">放弃未保存的群聊名称？</span>
            ) : err ? (
              <span className="settings-error">{err}</span>
            ) : busyId === "rename" ? (
              <span>正在保存…</span>
            ) : nameDirty ? (
              <span>群聊名称尚未保存</span>
            ) : nameSaved ? (
              <span className="settings-ok">✓ 已保存</span>
            ) : (
              <span>其他设置会立即生效</span>
            )}
          </div>
          <div className="room-settings-foot-actions">
            {closePending ? (
              <>
                <button type="button" className="btn btn-ghost" onClick={() => setClosePending(false)}>
                  继续编辑
                </button>
                <button type="button" className="btn btn-danger" onClick={onClose}>
                  放弃并关闭
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-ghost" onClick={requestClose}>
                  {nameDirty ? "取消" : t.common.close}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId === "rename" || !nameDirty || !nameValid}
                  onClick={() => void submitRename()}
                >
                  {busyId === "rename" ? "保存中…" : "保存"}
                </button>
              </>
            )}
          </div>
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
