import fs from "node:fs";
import path from "node:path";
import type {
  RoomListItem,
  RoomSnapshot,
  RoomTimelineItem,
} from "@claude-desktop/shared";

export type StoredRoom = {
  roomId: string;
  name: string;
  status: "open" | "ended";
  role: "host" | "member";
  port: number;
  inviteHost: string;
  /** For guest rejoin */
  join?: {
    host: string;
    hosts?: string[];
    port: number;
    password?: string;
    modChecksum?: string;
    secret?: string;
    hostFingerprint?: string;
    /** wss:// relay endpoints from the CDR2 invite (T1/T2). */
    wss?: string[];
  };
  memberCount: number;
  updatedAt: number;
  /** Guest identity, reused on rejoin so the host keeps seats */
  localUserId?: string;
  /** Guest dropped — kept locally, rejoinable */
  offline?: boolean;
  items: RoomTimelineItem[];
  /** Last known snapshot fields for offline browse */
  seats?: RoomSnapshot["seats"];
  members?: RoomSnapshot["members"];
  autoApprove?: boolean;
  hasPassword?: boolean;
  /** Whether room frames were AEAD-encrypted (transport posture at persist time). */
  encrypt?: boolean;
  /** Host device fingerprint learned at join / hosting time. */
  hostFingerprint?: string;
  requireMods?: boolean;
  modChecksum?: string;
  hostLabel?: string;
};

type IndexFile = {
  version: 1;
  rooms: StoredRoom[];
};

/**
 * Disk persistence for rooms + timeline (under userData/rooms/).
 */
export class RoomArchive {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(userDataDir: string) {
    this.root = path.join(userDataDir, "rooms");
    this.indexPath = path.join(this.root, "index.json");
    fs.mkdirSync(this.root, { recursive: true });
  }

  loadIndex(): StoredRoom[] {
    try {
      if (!fs.existsSync(this.indexPath)) return [];
      const raw = fs.readFileSync(this.indexPath, "utf8");
      const data = JSON.parse(raw) as IndexFile;
      if (!Array.isArray(data.rooms)) return [];
      return data.rooms.map((r) => this.normalize(r));
    } catch {
      return [];
    }
  }

  saveRoom(room: StoredRoom): void {
    const list = this.loadIndex().filter((r) => r.roomId !== room.roomId);
    list.unshift(this.normalize(room));
    // Cap history
    const trimmed = list.slice(0, 50);
    this.writeIndex(trimmed);
    try {
      const file = path.join(this.root, `${room.roomId}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, room: this.normalize(room) }, null, 2),
        "utf8",
      );
    } catch {
      // non-fatal
    }
  }

  removeRoom(roomId: string): void {
    const list = this.loadIndex().filter((r) => r.roomId !== roomId);
    this.writeIndex(list);
    try {
      const file = path.join(this.root, `${roomId}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }

  loadRoom(roomId: string): StoredRoom | null {
    try {
      const file = path.join(this.root, `${roomId}.json`);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8");
        const data = JSON.parse(raw) as { room?: StoredRoom };
        if (data.room) return this.normalize(data.room);
      }
    } catch {
      // fall through
    }
    return this.loadIndex().find((r) => r.roomId === roomId) ?? null;
  }

  toListItems(rooms: StoredRoom[]): RoomListItem[] {
    return rooms.map((r) => ({
      roomId: r.roomId,
      name: r.name,
      status: r.status,
      role: r.role,
      memberCount: r.memberCount,
      port: r.port,
      inviteHost: r.inviteHost,
      ...(r.offline ? { offline: true } : {}),
    }));
  }

  private writeIndex(rooms: StoredRoom[]): void {
    const payload: IndexFile = { version: 1, rooms };
    fs.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private normalize(r: StoredRoom): StoredRoom {
    return {
      roomId: String(r.roomId),
      name: String(r.name ?? "群聊"),
      status: r.status === "open" ? "open" : "ended",
      role: r.role === "host" ? "host" : "member",
      port: Number(r.port) || 18765,
      inviteHost: String(r.inviteHost ?? ""),
      memberCount: Number(r.memberCount) || 0,
      updatedAt: Number(r.updatedAt) || Date.now(),
      items: Array.isArray(r.items) ? r.items : [],
      ...(r.localUserId ? { localUserId: r.localUserId } : {}),
      ...(r.offline ? { offline: true } : {}),
      ...(r.join ? { join: r.join } : {}),
      ...(r.seats ? { seats: r.seats } : {}),
      ...(r.members ? { members: r.members } : {}),
      ...(r.autoApprove != null ? { autoApprove: r.autoApprove } : {}),
      ...(r.hasPassword != null ? { hasPassword: r.hasPassword } : {}),
      ...(r.encrypt != null ? { encrypt: r.encrypt } : {}),
      ...(r.hostFingerprint ? { hostFingerprint: r.hostFingerprint } : {}),
      ...(r.requireMods != null ? { requireMods: r.requireMods } : {}),
      ...(r.modChecksum ? { modChecksum: r.modChecksum } : {}),
      ...(r.hostLabel ? { hostLabel: r.hostLabel } : {}),
    };
  }
}
