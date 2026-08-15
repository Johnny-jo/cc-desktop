import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ROOM_DEFAULT_PORT,
  decodeRoomInvite,
  looksLikeRoomInvite,
  type ModOfferPayload,
} from "@claude-desktop/shared";
import {
  formatModBadge,
  formatModSize,
  joinPrimaryAction,
  offerHasMod,
} from "../lib/room-mod-ui";
import {
  closeRoomDialog,
  createRoom,
  enableRoomMod,
  fetchRoomMod,
  hasRoomMod,
  joinRoom,
  leaveActiveRoom,
  listRoomMods,
  openRoomDialog,
  peekRoom,
  selectRoom,
  useRoomStore,
  type RoomModPack,
} from "../state/room-store";

export function RoomSidebar() {
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
  const [packs, setPacks] = useState<RoomModPack[]>([]);
  const [packDir, setPackDir] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
    if (dialog !== "create") return;
    let cancelled = false;
    void listRoomMods().then((list) => {
      if (!cancelled) setPacks(list);
    });
    return () => {
      cancelled = true;
    };
  }, [dialog]);

  useEffect(() => {
    if (dialog !== "join") return;
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
      setOffer(null);
      setCacheHit(undefined);
      setPeeking(false);
      return;
    }
    const candidates = [h, ...extras.filter((x) => x && x !== h)];
    const gen = ++peekGen.current;
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

  const resetForms = () => {
    abortOps();
    setName("");
    setPassword("");
    setPort(String(ROOM_DEFAULT_PORT));
    setSecret("");
    setHost("");
    setJoinPassword("");
    setJoinPort(String(ROOM_DEFAULT_PORT));
    setInviteHosts([]);
    setInviteChecksum("");
    setOffer(null);
    setCacheHit(undefined);
    setPacks([]);
    setPackDir("");
    setErr(null);
  };

  const onCreate = async () => {
    const gen = ++joinGen.current;
    setBusy(true);
    setErr(null);
    const p = Number(port) || ROOM_DEFAULT_PORT;
    const roomName = name.trim() || `房间-${p}`;
    const res = await createRoom({
      name: roomName,
      password: password || undefined,
      port: p,
    });
    if (gen !== joinGen.current) return;
    if (!res.ok) {
      setBusy(false);
      setErr(res.error ?? "创建失败");
      return;
    }
    if (packDir && res.roomId) {
      const enabled = await enableRoomMod(res.roomId, packDir);
      if (gen !== joinGen.current) return;
      if (!enabled.ok) {
        setBusy(false);
        setErr(enabled.error ?? "启用模组失败");
        return;
      }
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
    candidates: string[];
  } | { error: string } => {
    let h = host.trim();
    let p = Number(joinPort) || ROOM_DEFAULT_PORT;
    let pwd = joinPassword || undefined;
    let checksum = offer?.checksum || inviteChecksum || undefined;
    let hosts = inviteHosts;

    const secretRaw = secret.trim() || host.trim();
    if (looksLikeRoomInvite(secretRaw)) {
      try {
        const inv = decodeRoomInvite(secretRaw);
        h = inv.host;
        p = inv.port;
        pwd = inv.password || pwd;
        checksum = inv.modChecksum || checksum;
        hosts = inv.hosts ?? [];
        setHost(inv.host);
        setJoinPort(String(inv.port));
        if (inv.password) setJoinPassword(inv.password);
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

    if (!h) return { error: "请粘贴邀请码，或填写房主 IP" };
    const candidates = [h, ...hosts.filter((x) => x && x !== h)];
    return { host: h, port: p, password: pwd, checksum, candidates };
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
    const checksum = target.checksum || offer?.checksum;

    let lastError = "";
    for (const candidate of target.candidates) {
      if (gen !== joinGen.current) return;
      if (needSync) {
        if (!checksum) {
          lastError = "缺少模组校验码";
          break;
        }
        setProgress("同步中…");
        const fetched = await fetchRoomMod({
          host: candidate,
          port: target.port,
          checksum,
        });
        if (gen !== joinGen.current) return;
        if (!fetched.ok) {
          lastError = fetched.error ?? "同步失败";
          continue;
        }
      }
      if (gen !== joinGen.current) return;
      setProgress(needSync ? "加入中…" : null);
      const res = await joinRoom({
        host: candidate,
        port: target.port,
        password: target.password,
        modChecksum: checksum,
        hosts: target.candidates,
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
        <span className="sidebar-files-label">房间</span>
        {rooms.some((r) => r.status === "open") ? (
          <span className="room-dot on" />
        ) : null}
      </button>

      {open ? (
        <div className="sidebar-rooms-body">
          <div className="sidebar-rooms-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                resetForms();
                openRoomDialog("create");
              }}
            >
              + 创建房间
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                resetForms();
                openRoomDialog("join");
              }}
            >
              加入房间
            </button>
            {activeRoomId ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title="退出当前房间"
                onClick={() => void leaveActiveRoom()}
              >
                退出
              </button>
            ) : null}
          </div>

          {reconnectNote ? (
            <p className="room-reconnect-note">{reconnectNote}</p>
          ) : null}

          {lastError && !dialog ? (
            <p className="room-err" style={{ whiteSpace: "pre-wrap" }}>
              {lastError}
            </p>
          ) : null}

          {rooms.length === 0 ? (
            <p className="ft-hint">还没有房间</p>
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
                      {r.status === "open" ? "开着" : "已结束"}
                      {r.role === "host" ? " · 房主" : ""}
                    </span>
                  </span>
                </button>
                {r.roomId === activeRoomId ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm room-row-leave"
                    title={r.role === "host" ? "解散房间" : "退出房间"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void leaveActiveRoom();
                    }}
                  >
                    退出
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
            aria-label={dialog === "create" ? "创建房间" : "加入房间"}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="room-modal-head">
              <h3>{dialog === "create" ? "创建房间" : "加入房间"}</h3>
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
                  房间名
                  <input
                    placeholder="可空，默认 房间-端口"
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
                <label className="settings-field">
                  端口
                  <input
                    placeholder={String(ROOM_DEFAULT_PORT)}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  玩法模组（可选）
                  <select
                    className="select"
                    value={packDir}
                    onChange={(e) => setPackDir(e.target.value)}
                  >
                    <option value="">不使用模组</option>
                    {packs.map((pack) => (
                      <option key={`${pack.source}:${pack.packDir}`} value={pack.packDir}>
                        {pack.name} ({pack.id}@{pack.version}
                        {pack.source === "cache" ? " · 缓存" : ""})
                      </option>
                    ))}
                  </select>
                </label>
                <p className="settings-hint">
                  创建后本机在 0.0.0.0:端口 监听。对方用「邀请码」加入；防火墙需放行该
                  TCP 端口。
                </p>
              </div>
            ) : (
              <div className="room-modal-body">
                <label className="settings-field">
                  邀请码
                  <input
                    placeholder="粘贴 CDR1.… 邀请码"
                    value={secret}
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => {
                      const v = e.target.value;
                      setSecret(v);
                      if (looksLikeRoomInvite(v)) {
                        try {
                          const inv = decodeRoomInvite(v);
                          setHost(inv.host);
                          setJoinPort(String(inv.port));
                          if (inv.password) setJoinPassword(inv.password);
                          setInviteHosts(inv.hosts ?? []);
                          setInviteChecksum(inv.modChecksum ?? "");
                          if (inv.modChecksum) {
                            void hasRoomMod(inv.modChecksum).then(setCacheHit);
                          } else {
                            setCacheHit(undefined);
                          }
                          setErr(null);
                        } catch {
                          // incomplete
                        }
                      } else {
                        setInviteHosts([]);
                        setInviteChecksum("");
                      }
                    }}
                  />
                </label>
                <details className="room-join-advanced">
                  <summary>高级：手动填 IP / 端口</summary>
                  <label className="settings-field">
                    房主 IP
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
                  <label className="settings-field">
                    密码
                    <input
                      type="password"
                      value={joinPassword}
                      onChange={(e) => setJoinPassword(e.target.value)}
                    />
                  </label>
                </details>
                {inviteChecksum ? (
                  <p className="room-join-hint">
                    此房间需要模组（校验 {inviteChecksum.slice(0, 8)}）
                  </p>
                ) : null}
                {offerHasMod(offer) ? (
                  <>
                    <p className="room-join-meta">{formatModBadge(offer)}</p>
                    {cacheHit ? (
                      <p className="room-join-hint">
                        将使用本地模组「{offer?.name}」v{offer?.version}
                      </p>
                    ) : (
                      <p className="room-join-hint">
                        缺少模组「{offer?.name}」v{offer?.version}（约{" "}
                        {formatModSize(offer?.size)}
                        ）。将从房主同步后再加入。
                      </p>
                    )}
                  </>
                ) : peeking ? (
                  <p className="room-join-hint">正在查询房间模组…</p>
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
                  (dialog === "join" && !secret.trim() && !host.trim())
                }
                onClick={() =>
                  void (dialog === "create" ? onCreate() : onJoin())
                }
              >
                {dialog === "create"
                  ? busy
                    ? "创建中…"
                    : "创建并开口"
                  : busy
                    ? progress ||
                      (joinPrimaryAction({ inviteChecksum, offer, cacheHit }) ===
                      "sync-join"
                        ? "同步中…"
                        : "加入中…")
                    : joinPrimaryAction({ inviteChecksum, offer, cacheHit }) ===
                        "sync-join"
                      ? "同步下载并加入"
                      : "加入"}
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
