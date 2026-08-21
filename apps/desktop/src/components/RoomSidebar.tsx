import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ROOM_DEFAULT_PORT,
  decodeRoomInvite,
  looksLikeRoomInvite,
  type ModOfferPayload,
} from "@claude-desktop/shared";
import {
  fillTemplate,
  formatModBadge,
  formatModSize,
  joinPrimaryAction,
  offerHasMod,
} from "../lib/room-mod-ui";
import { joinErrorForInvite } from "../lib/room-invite-ui";
import { useI18n } from "../i18n/useI18n";
import {
  loadLastCollectionId,
  loadModCollections,
  saveLastCollectionId,
  type ModCollection,
} from "../lib/mod-collections";
import {
  closeRoomDialog,
  createRoom,
  enableRoomKernelMod,
  enableRoomMod,
  fetchRoomMod,
  hasRoomMod,
  joinRoom,
  listRoomMods,
  openRoomDialog,
  peekRoom,
  rejoinRoom,
  selectRoom,
  useRoomStore,
} from "../state/room-store";

export function RoomSidebar() {
  const { t } = useI18n();
  const rooms = useRoomStore((s) => s.rooms);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);
  const lastError = useRoomStore((s) => s.lastError);
  const dialog = useRoomStore((s) => s.dialog);
  const reconnectNote = useRoomStore((s) => s.reconnectNote);
  const [open, setOpen] = useState(false);

  // Create form
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(String(ROOM_DEFAULT_PORT));
  const [skipEncrypt, setSkipEncrypt] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [publicOn, setPublicOn] = useState(false);
  const [publicWss, setPublicWss] = useState("");
  const [tunnel, setTunnel] = useState(false);
  const [relayOn, setRelayOn] = useState(false);
  const [relay, setRelay] = useState("");
  const [relayToken, setRelayToken] = useState("");
  // Mod 选集（创建时一键套用）
  const [collections, setCollections] = useState<ModCollection[]>([]);
  const [collectionId, setCollectionId] = useState<string>(() =>
    loadLastCollectionId(),
  );
  // Join form
  const [secret, setSecret] = useState("");
  const [host, setHost] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [joinPort, setJoinPort] = useState(String(ROOM_DEFAULT_PORT));
  const [inviteHosts, setInviteHosts] = useState<string[]>([]);
  const [inviteChecksum, setInviteChecksum] = useState("");
  const [offer, setOffer] = useState<ModOfferPayload | null>(null);
  const [cacheHit, setCacheHit] = useState<boolean | undefined>(undefined);
  const [peeking, setPeeking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const peekGen = useRef(0);
  const joinGen = useRef(0);

  const abortOps = () => {
    peekGen.current += 1;
    joinGen.current += 1;
    setBusy(false);
    setPeeking(false);
    setProgress(null);
  };

  const dismissDialog = () => {
    abortOps();
    closeRoomDialog();
  };

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  useEffect(() => {
    if (dialog !== "join") return;
    const gen = ++peekGen.current;
    setOffer(null);
    setCacheHit(undefined);
    let h = host.trim();
    let p = Number(joinPort) || ROOM_DEFAULT_PORT;
    let extras = inviteHosts;
    const secretRaw = secret.trim();
    if (looksLikeRoomInvite(secretRaw)) {
      try {
        const inv = decodeRoomInvite(secretRaw);
        h = inv.host;
        p = inv.port;
        extras = inv.hosts ?? [];
      } catch {
        setPeeking(false);
        return;
      }
    } else if (h.includes(":") && !h.includes("::")) {
      const [hh, pp] = h.split(":");
      if (hh && pp && /^\d+$/.test(pp)) {
        h = hh;
        p = Number(pp);
      }
    }
    if (!h) {
      setPeeking(false);
      return;
    }
    const candidates = [h, ...extras.filter((x) => x && x !== h)];
    setPeeking(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        let found: ModOfferPayload | null = null;
        for (const candidate of candidates) {
          if (gen !== peekGen.current) return;
          const res = await peekRoom({ host: candidate, port: p });
          if (gen !== peekGen.current) return;
          if (res.ok) {
            found = res.offer ?? null;
            break;
          }
        }
        if (gen !== peekGen.current) return;
        setOffer(found);
        const checksum = found?.checksum || inviteChecksum;
        if (checksum) {
          const has = await hasRoomMod(checksum);
          if (gen !== peekGen.current) return;
          setCacheHit(has);
        } else {
          setCacheHit(undefined);
        }
        setPeeking(false);
      })();
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [dialog, host, joinPort, secret, inviteHosts, inviteChecksum]);

  // 打开创建对话框时刷新选集列表（可能在设置里刚编辑过）
  useEffect(() => {
    if (dialog === "create") setCollections(loadModCollections());
  }, [dialog]);

  // ⋮ 菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const resetForms = () => {
    abortOps();
    setName("");
    setPassword("");
    setPort(String(ROOM_DEFAULT_PORT));
    setSkipEncrypt(false);
    setAutoApprove(false);
    setPublicOn(false);
    setPublicWss("");
    setTunnel(false);
    setRelayOn(false);
    setRelay("");
    setRelayToken("");
    setSecret("");
    setHost("");
    setJoinPassword("");
    setJoinPort(String(ROOM_DEFAULT_PORT));
    setInviteHosts([]);
    setInviteChecksum("");
    setOffer(null);
    setCacheHit(undefined);
    setErr(null);
  };

  const onCreate = async () => {
    const gen = ++joinGen.current;
    setBusy(true);
    setErr(null);
    const p = Number(port) || ROOM_DEFAULT_PORT;
    const roomName = name.trim() || `群聊-${p}`;
    // 公网 / 隧道 / 中继房间强制加密：忽略「跳过加密」（表单里有对应提示）
    const skip = skipEncrypt && !publicOn && !tunnel && !relayOn;
    const res = await createRoom({
      name: roomName,
      password: password || undefined,
      port: p,
      encrypt: skip ? false : undefined,
      autoApprove: autoApprove || undefined,
      publicWss: publicOn && publicWss.trim() ? publicWss.trim() : undefined,
      tunnel: tunnel || undefined,
      relay: relayOn && relay.trim() ? relay.trim() : undefined,
      relayToken:
        relayOn && relayToken.trim() ? relayToken.trim() : undefined,
    });
    if (gen !== joinGen.current) return;
    if (!res.ok) {
      setBusy(false);
      setErr(res.error ?? "创建失败");
      return;
    }
    // 套用 Mod 选集：单个失败不阻断进群
    const col = collections.find((c) => c.id === collectionId);
    if (res.roomId && col && col.modIds.length) {
      saveLastCollectionId(col.id);
      setProgress("正在套用 Mod 选集…");
      const packs = await listRoomMods();
      const byKey = new Map<string, (typeof packs)[number]>(
        packs.map((pk) => [`${pk.hostApi === 2 ? "k" : "p"}:${pk.id}`, pk]),
      );
      for (const key of col.modIds) {
        if (gen !== joinGen.current) return;
        const pack = byKey.get(key);
        if (!pack) continue;
        if (pack.hostApi === 2) {
          await enableRoomKernelMod(res.roomId, pack.packDir);
        } else {
          await enableRoomMod(res.roomId, pack.packDir);
        }
      }
      setProgress(null);
    } else {
      saveLastCollectionId("");
    }
    setBusy(false);
    resetForms();
    closeRoomDialog();
  };

  const resolveJoinTarget = (): {
    host: string;
    port: number;
    password?: string;
    checksum?: string;
    fingerprint?: string;
    wss: string[];
    candidates: string[];
  } | { error: string } => {
    let h = host.trim();
    let p = Number(joinPort) || ROOM_DEFAULT_PORT;
    let pwd = joinPassword || undefined;
    let checksum: string | undefined;
    let fingerprint: string | undefined;
    let hosts = inviteHosts;
    let wss: string[] = [];

    const secretRaw = secret.trim() || host.trim();
    if (looksLikeRoomInvite(secretRaw)) {
      try {
        const inv = decodeRoomInvite(secretRaw);
        h = inv.host;
        p = inv.port;
        checksum = inv.modChecksum || undefined;
        fingerprint = inv.hostFingerprint || undefined;
        hosts = inv.hosts ?? [];
        wss = inv.wss ?? [];
        setHost(inv.host);
        setJoinPort(String(inv.port));
      } catch (e) {
        return { error: e instanceof Error ? e.message : "邀请码无效" };
      }
    } else if (h.includes(":") && !h.includes("::")) {
      const [hh, pp] = h.split(":");
      if (hh && pp && /^\d+$/.test(pp)) {
        h = hh;
        p = Number(pp);
        setJoinPort(pp);
      }
    }

    if (!h) return { error: "请粘贴邀请码，或填写群主 IP" };
    if (!checksum) checksum = offer?.checksum || undefined;
    const candidates = [h, ...hosts.filter((x) => x && x !== h)];
    return { host: h, port: p, password: pwd, checksum, fingerprint, wss, candidates };
  };

  const onJoin = async () => {
    const gen = ++joinGen.current;
    setBusy(true);
    setErr(null);
    setProgress(null);

    const target = resolveJoinTarget();
    if ("error" in target) {
      setBusy(false);
      setErr(target.error);
      return;
    }

    const primary = joinPrimaryAction({
      inviteChecksum: target.checksum,
      offer,
      cacheHit,
    });
    const needSync = primary === "sync-join";
    const checksum = target.checksum;

    let lastError = "";
    for (const candidate of target.candidates) {
      if (gen !== joinGen.current) return;
      if (needSync) {
        if (!checksum) {
          lastError = "缺少模组校验码";
          break;
        }
        setProgress(t.room.syncing);
        const fetched = await fetchRoomMod({
          host: candidate,
          port: target.port,
          checksum,
          password: target.password,
          hostFingerprint: target.fingerprint,
        });
        if (gen !== joinGen.current) return;
        if (!fetched.ok) {
          lastError = fetched.error ?? "同步失败";
          continue;
        }
      }
      if (gen !== joinGen.current) return;
      setProgress(needSync ? t.room.joining : null);
      const res = await joinRoom({
        host: candidate,
        port: target.port,
        password: target.password,
        modChecksum: checksum,
        hosts: target.candidates,
        wss: target.wss.length ? target.wss : undefined,
        hostFingerprint: target.fingerprint,
      });
      if (gen !== joinGen.current) return;
      if (res.ok) {
        setBusy(false);
        setProgress(null);
        resetForms();
        closeRoomDialog();
        return;
      }
      lastError = res.error ?? "加入失败";
    }
    setBusy(false);
    setProgress(null);
    setErr(lastError || "加入失败");
  };

  return (
    <div className={`sidebar-rooms${open ? " open" : ""}`}>
      <div className="sidebar-rooms-head">
        <button
          type="button"
          className="sidebar-files-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`sidebar-files-chevron${open ? " open" : ""}`}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="sidebar-files-label">群聊</span>
          {rooms.some((r) => r.status === "open") ? (
            <span className="room-dot on" />
          ) : null}
        </button>
        <div className="sidebar-rooms-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="sidebar-rooms-menu-btn"
            aria-label="群聊操作"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <circle cx="8" cy="3" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="13" r="1.5" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="sidebar-rooms-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  resetForms();
                  openRoomDialog("create");
                }}
              >
                创建群聊
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  resetForms();
                  openRoomDialog("join");
                }}
              >
                加入群聊
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="sidebar-rooms-body">
          {reconnectNote ? (
            <p className="room-reconnect-note">{reconnectNote}</p>
          ) : null}

          {lastError && !dialog ? (
            <p className="room-err" style={{ whiteSpace: "pre-wrap" }}>
              {lastError}
            </p>
          ) : null}

          {rooms.length === 0 ? (
            <p className="ft-hint">还没有群聊</p>
          ) : (
            rooms.map((r) => (
              <div key={r.roomId} className="room-list-row">
                <button
                  type="button"
                  className={
                    r.roomId === activeRoomId
                      ? "session-item active"
                      : "session-item"
                  }
                  onClick={() => selectRoom(r.roomId)}
                >
                  <span className="session-title">{r.name}</span>
                  <span className="session-meta">
                    <span>
                      {r.memberCount} 人 ·{" "}
                      {r.offline
                        ? t.room.offline
                        : r.status === "open"
                          ? "开着"
                          : "已结束"}
                      {r.role === "host" ? " · 群主" : ""}
                    </span>
                  </span>
                </button>
                {r.offline ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm room-row-rejoin"
                    title={t.room.rejoin}
                    onClick={(e) => {
                      e.stopPropagation();
                      void rejoinRoom(r.roomId);
                    }}
                  >
                    {t.room.rejoin}
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* Portal to body — sidebar / workspace overflow would clip a nested overlay. */}
      {dialog
        ? createPortal(
            <div
              className="room-modal-overlay"
              role="presentation"
              onClick={() => dismissDialog()}
            >
          <div
            className="room-modal"
            role="dialog"
            aria-label={dialog === "create" ? "创建群聊" : "加入群聊"}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="room-modal-head">
              <h3>{dialog === "create" ? "创建群聊" : "加入群聊"}</h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dismissDialog()}
              >
                ×
              </button>
            </header>

            {dialog === "create" ? (
              <div className="room-modal-body">
                <label className="settings-field">
                  群聊名
                  <input
                    placeholder="可空，默认 群聊-端口"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </label>
                <label className="settings-field">
                  密码（可空）
                  <input
                    type="password"
                    placeholder="可选"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <p className="settings-hint">{t.room.passwordHint}</p>
                <label className="settings-field">
                  端口
                  <input
                    placeholder={String(ROOM_DEFAULT_PORT)}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={skipEncrypt}
                    onChange={(e) => setSkipEncrypt(e.target.checked)}
                  />
                  {t.room.skipEncrypt}
                </label>
                {skipEncrypt ? (
                  <p
                    className={
                      publicOn || tunnel || relayOn
                        ? "room-leave-warn"
                        : "settings-hint"
                    }
                  >
                    {t.room.skipEncryptHint}
                  </p>
                ) : null}
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={autoApprove}
                    onChange={(e) => setAutoApprove(e.target.checked)}
                  />
                  自动放行新设备
                </label>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={publicOn}
                    onChange={(e) => setPublicOn(e.target.checked)}
                  />
                  公网可达
                </label>
                {publicOn ? (
                  <label className="settings-field">
                    <input
                      placeholder={t.room.publicWss}
                      value={publicWss}
                      spellCheck={false}
                      onChange={(e) => setPublicWss(e.target.value)}
                    />
                  </label>
                ) : null}
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={tunnel}
                    onChange={(e) => setTunnel(e.target.checked)}
                  />
                  {t.room.tunnel}
                </label>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={relayOn}
                    onChange={(e) => setRelayOn(e.target.checked)}
                  />
                  {t.room.relay}
                </label>
                {relayOn ? (
                  <>
                    <label className="settings-field">
                      <input
                        placeholder="ws://vps-ip:7600"
                        aria-label={t.room.relayAddress}
                        value={relay}
                        spellCheck={false}
                        onChange={(e) => setRelay(e.target.value)}
                      />
                    </label>
                    <label className="settings-field">
                      <input
                        placeholder={t.room.relayToken}
                        value={relayToken}
                        spellCheck={false}
                        onChange={(e) => setRelayToken(e.target.value)}
                      />
                    </label>
                  </>
                ) : null}
                <label className="settings-field">
                  Mod 选集
                  <select
                    className="select"
                    value={collectionId}
                    onChange={(e) => setCollectionId(e.target.value)}
                  >
                    <option value="">不使用</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}（{c.modIds.length} 个 Mod）
                      </option>
                    ))}
                  </select>
                  {!collections.length ? (
                    <p className="settings-hint">
                      可在「设置 → 群聊设置 → 选集设置」中创建选集
                    </p>
                  ) : null}
                </label>
                <p className="settings-hint">{t.room.createHint}</p>
              </div>
            ) : (
              <div className="room-modal-body">
                <label className="settings-field">
                  邀请码
                  <input
                    placeholder="粘贴 CDR2.… 邀请码"
                    value={secret}
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => {
                      const v = e.target.value;
                      setSecret(v);
                      const inviteErr = joinErrorForInvite(v);
                      if (inviteErr) {
                        // CDR1 / 损坏邀请码：只提示，不自动填、不 join
                        setErr(inviteErr);
                        setInviteHosts([]);
                        setInviteChecksum("");
                        return;
                      }
                      if (looksLikeRoomInvite(v)) {
                        const inv = decodeRoomInvite(v);
                        setHost(inv.host);
                        setJoinPort(String(inv.port));
                        setInviteHosts(inv.hosts ?? []);
                        setInviteChecksum(inv.modChecksum ?? "");
                        setOffer(null);
                        setCacheHit(undefined);
                      } else {
                        setInviteHosts([]);
                        setInviteChecksum("");
                      }
                      setErr(null);
                    }}
                  />
                </label>
                <label className="settings-field">
                  密码
                  <input
                    type="password"
                    placeholder="可空"
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value)}
                  />
                </label>
                <details className="room-join-advanced">
                  <summary>高级：手动填 IP / 端口</summary>
                  <label className="settings-field">
                    群主 IP
                    <input
                      placeholder="127.0.0.1 或局域网 IP"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    端口
                    <input
                      value={joinPort}
                      onChange={(e) => setJoinPort(e.target.value)}
                    />
                  </label>
                </details>
                {inviteChecksum ? (
                  <p className="room-join-hint">
                    {fillTemplate(t.room.needMod, {
                      checksum: inviteChecksum.slice(0, 8),
                    })}
                  </p>
                ) : null}
                {offerHasMod(offer) ? (
                  <>
                    <p className="room-join-meta">
                      {formatModBadge(offer, t.room.modBadge)}
                    </p>
                    {cacheHit ? (
                      <p className="room-join-hint">
                        {fillTemplate(t.room.useLocalMod, {
                          name: offer?.name ?? "",
                          version: offer?.version ?? "",
                        })}
                      </p>
                    ) : (
                      <p className="room-join-hint">
                        {fillTemplate(t.room.missingMod, {
                          name: offer?.name ?? "",
                          version: offer?.version ?? "",
                          size: formatModSize(offer?.size),
                        })}
                      </p>
                    )}
                  </>
                ) : peeking ? (
                  <p className="room-join-hint">{t.room.peeking}</p>
                ) : null}
              </div>
            )}

            {err ? (
              <p className="room-err" style={{ whiteSpace: "pre-wrap" }}>
                {err}
              </p>
            ) : null}

            <footer className="room-modal-foot">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dismissDialog()}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={
                  busy ||
                  (dialog === "join" && !secret.trim() && !host.trim()) ||
                  (dialog === "join" &&
                    Boolean(joinErrorForInvite(secret.trim()))) ||
                  (dialog === "join" && peeking && Boolean(inviteChecksum))
                }
                onClick={() =>
                  void (dialog === "create" ? onCreate() : onJoin())
                }
              >
                {dialog === "create"
                  ? busy
                    ? t.room.creating
                    : t.room.createBtn
                  : busy
                    ? progress ||
                      (joinPrimaryAction({ inviteChecksum, offer, cacheHit }) ===
                      "sync-join"
                        ? t.room.syncing
                        : t.room.joining)
                    : joinPrimaryAction({ inviteChecksum, offer, cacheHit }) ===
                        "sync-join"
                      ? t.room.syncAndJoin
                      : t.room.joinBtn}
              </button>
            </footer>
          </div>
        </div>,
            document.body,
          )
        : null}
    </div>
  );
}
