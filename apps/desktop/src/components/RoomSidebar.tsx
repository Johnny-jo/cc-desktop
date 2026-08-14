import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ROOM_DEFAULT_PORT,
  decodeRoomInvite,
  looksLikeRoomInvite,
} from "@claude-desktop/shared";
import {
  closeRoomDialog,
  createRoom,
  joinRoom,
  leaveActiveRoom,
  openRoomDialog,
  selectRoom,
  useRoomStore,
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

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) closeRoomDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, busy]);

  const resetForms = () => {
    setName("");
    setPassword("");
    setPort(String(ROOM_DEFAULT_PORT));
    setSecret("");
    setHost("");
    setJoinPassword("");
    setJoinPort(String(ROOM_DEFAULT_PORT));
    setErr(null);
  };

  const onCreate = async () => {
    setBusy(true);
    setErr(null);
    const p = Number(port) || ROOM_DEFAULT_PORT;
    const roomName = name.trim() || `房间-${p}`;
    const res = await createRoom({
      name: roomName,
      password: password || undefined,
      port: p,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error ?? "创建失败");
      return;
    }
    resetForms();
    closeRoomDialog();
  };

  const onJoin = async () => {
    setBusy(true);
    setErr(null);

    let h = host.trim();
    let p = Number(joinPort) || ROOM_DEFAULT_PORT;
    let pwd = joinPassword || undefined;
    let modChecksum: string | undefined;
    let hosts: string[] | undefined;

    const secretRaw = secret.trim() || host.trim();
    if (looksLikeRoomInvite(secretRaw)) {
      try {
        const inv = decodeRoomInvite(secretRaw);
        h = inv.host;
        p = inv.port;
        pwd = inv.password || pwd;
        modChecksum = inv.modChecksum;
        hosts = inv.hosts;
        setHost(inv.host);
        setJoinPort(String(inv.port));
        if (inv.password) setJoinPassword(inv.password);
      } catch (e) {
        setBusy(false);
        setErr(e instanceof Error ? e.message : "邀请码无效");
        return;
      }
    } else if (h.includes(":") && !h.includes("::")) {
      const [hh, pp] = h.split(":");
      if (hh && pp && /^\d+$/.test(pp)) {
        h = hh;
        p = Number(pp);
        setJoinPort(pp);
      }
    }

    if (!h) {
      setBusy(false);
      setErr("请粘贴邀请码，或填写房主 IP");
      return;
    }

    const candidates = [h, ...(hosts ?? []).filter((x) => x && x !== h)];
    let lastError = "";
    for (const candidate of candidates) {
      const res = await joinRoom({
        host: candidate,
        port: p,
        password: pwd,
        modChecksum,
        hosts: candidates,
      });
      if (res.ok) {
        setBusy(false);
        resetForms();
        closeRoomDialog();
        return;
      }
      lastError = res.error ?? "加入失败";
    }
    setBusy(false);
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
              onClick={() => {
                if (!busy) closeRoomDialog();
              }}
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
                disabled={busy}
                onClick={() => closeRoomDialog()}
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
                          setErr(null);
                        } catch {
                          // incomplete
                        }
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
                disabled={busy}
                onClick={() => closeRoomDialog()}
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
                {busy
                  ? dialog === "create"
                    ? "创建中…"
                    : "加入中…"
                  : dialog === "create"
                    ? "创建并开口"
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
