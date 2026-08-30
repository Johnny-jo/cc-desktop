import fs from "node:fs";
import path from "node:path";
import type {
  RoomListItem,
  RoomPath,
  RoomSnapshot,
  RoomTimelineItem,
} from "@claude-desktop/shared";
import { AppDatabase } from "./app-database";

export type StoredRoom = {
  roomId: string;
  name: string;
  status: "open" | "ended";
  role: "host" | "member";
  port: number;
  inviteHost: string;
  join?: {
    host: string;
    hosts?: string[];
    port: number;
    password?: string;
    modChecksum?: string;
    secret?: string;
    hostFingerprint?: string;
    wss?: string[];
    path?: RoomPath;
  };
  memberCount: number;
  updatedAt: number;
  localUserId?: string;
  offline?: boolean;
  items: RoomTimelineItem[];
  seats?: RoomSnapshot["seats"];
  members?: RoomSnapshot["members"];
  autoApprove?: boolean;
  hasPassword?: boolean;
  encrypt?: boolean;
  hostFingerprint?: string;
  requireMods?: boolean;
  modChecksum?: string;
  hostLabel?: string;
  password?: string;
  publicWss?: string;
  tunnel?: boolean;
  relay?: string;
  relayToken?: string;
  relayRoomId?: string;
  knownDevices?: Array<{ fp: string; name: string; userId?: string }>;
  blacklist?: string[];
};

type IndexFile = {
  version: 1;
  rooms: StoredRoom[];
};

const LEGACY_MIGRATION_KEY = "migration.rooms-json-v1";

/** Room metadata + timeline persistence, backed by SQLite in Electron 43+. */
export class RoomArchive {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(
    userDataDir: string,
    public readonly database: AppDatabase | null = AppDatabase.open(userDataDir),
  ) {
    this.root = path.join(userDataDir, "rooms");
    this.indexPath = path.join(this.root, "index.json");
    fs.mkdirSync(this.root, { recursive: true });
    this.migrateLegacyRooms();
  }

  loadIndex(): StoredRoom[] {
    if (this.database) {
      return this.database
        .loadRooms<StoredRoom>()
        .map((room) => this.normalize(room));
    }
    return this.loadLegacyIndex();
  }

  saveRoom(room: StoredRoom): void {
    const normalized = this.normalize(room);
    if (this.database) {
      this.database.saveRoom(normalized);
      return;
    }
    const list = this.loadLegacyIndex().filter((item) => item.roomId !== room.roomId);
    list.unshift(normalized);
    const trimmed = list.slice(0, 50);
    this.writeLegacyIndex(trimmed);
    try {
      fs.writeFileSync(
        this.roomFile(room.roomId),
        JSON.stringify({ version: 1, room: normalized }, null, 2),
        "utf8",
      );
    } catch {
      // non-fatal
    }
  }

  removeRoom(roomId: string): void {
    this.database?.removeRoom(roomId);
    // Also remove the legacy copy so deleting the DB cannot resurrect a room.
    if (fs.existsSync(this.indexPath)) {
      const list = this.loadLegacyIndex().filter((room) => room.roomId !== roomId);
      this.writeLegacyIndex(list);
    }
    try {
      const file = this.roomFile(roomId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }

  loadRoom(roomId: string): StoredRoom | null {
    if (this.database) {
      const room = this.database.loadRoom<StoredRoom>(roomId);
      return room ? this.normalize(room) : null;
    }
    return (
      this.loadLegacyRoom(roomId) ??
      this.loadLegacyIndex().find((room) => room.roomId === roomId) ??
      null
    );
  }

  toListItems(rooms: StoredRoom[]): RoomListItem[] {
    return rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      status: room.status,
      role: room.role,
      memberCount: room.memberCount,
      port: room.port,
      inviteHost: room.inviteHost,
      ...(room.offline ? { offline: true } : {}),
    }));
  }

  close(): void {
    this.database?.close();
  }

  private migrateLegacyRooms(): void {
    if (!this.database || this.database.getMeta(LEGACY_MIGRATION_KEY)) return;
    try {
      const byId = new Map(
        this.loadLegacyIndex().map((room) => [room.roomId, room]),
      );
      for (const file of fs.readdirSync(this.root)) {
        if (file === "index.json" || !file.endsWith(".json")) continue;
        const roomId = file.slice(0, -5);
        const room = this.loadLegacyRoom(roomId);
        const previous = byId.get(roomId);
        if (room && (!previous || room.updatedAt >= previous.updatedAt)) {
          byId.set(roomId, room);
        }
      }
      for (const room of [...byId.values()]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(-50)) {
        this.database.saveRoom(this.normalize(room));
      }
      this.database.setMeta(LEGACY_MIGRATION_KEY, String(Date.now()));
    } catch {
      // Leave the marker unset so a later launch can retry safely.
    }
  }

  private loadLegacyIndex(): StoredRoom[] {
    try {
      if (!fs.existsSync(this.indexPath)) return [];
      const data = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as IndexFile;
      return Array.isArray(data.rooms)
        ? data.rooms.map((room) => this.normalize(room))
        : [];
    } catch {
      return [];
    }
  }

  private loadLegacyRoom(roomId: string): StoredRoom | null {
    try {
      const file = this.roomFile(roomId);
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
        room?: StoredRoom;
      };
      return data.room ? this.normalize(data.room) : null;
    } catch {
      return null;
    }
  }

  private writeLegacyIndex(rooms: StoredRoom[]): void {
    const payload: IndexFile = { version: 1, rooms };
    fs.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private roomFile(roomId: string): string {
    return path.join(this.root, `${roomId}.json`);
  }

  private normalize(room: StoredRoom): StoredRoom {
    return {
      roomId: String(room.roomId),
      name: String(room.name ?? "群聊"),
      status: room.status === "open" ? "open" : "ended",
      role: room.role === "host" ? "host" : "member",
      port: Number(room.port) || 18765,
      inviteHost: String(room.inviteHost ?? ""),
      memberCount: Number(room.memberCount) || 0,
      updatedAt: Number(room.updatedAt) || Date.now(),
      items: Array.isArray(room.items) ? room.items : [],
      ...(room.localUserId ? { localUserId: room.localUserId } : {}),
      ...(room.offline ? { offline: true } : {}),
      ...(room.join ? { join: room.join } : {}),
      ...(room.seats ? { seats: room.seats } : {}),
      ...(room.members ? { members: room.members } : {}),
      ...(room.autoApprove != null ? { autoApprove: room.autoApprove } : {}),
      ...(room.hasPassword != null ? { hasPassword: room.hasPassword } : {}),
      ...(room.encrypt != null ? { encrypt: room.encrypt } : {}),
      ...(room.hostFingerprint ? { hostFingerprint: room.hostFingerprint } : {}),
      ...(room.requireMods != null ? { requireMods: room.requireMods } : {}),
      ...(room.modChecksum ? { modChecksum: room.modChecksum } : {}),
      ...(room.hostLabel ? { hostLabel: room.hostLabel } : {}),
      ...(room.password ? { password: room.password } : {}),
      ...(room.publicWss ? { publicWss: room.publicWss } : {}),
      ...(room.tunnel ? { tunnel: true } : {}),
      ...(room.relay ? { relay: room.relay } : {}),
      ...(room.relayToken ? { relayToken: room.relayToken } : {}),
      ...(room.relayRoomId ? { relayRoomId: room.relayRoomId } : {}),
      ...(Array.isArray(room.knownDevices) && room.knownDevices.length
        ? {
            knownDevices: room.knownDevices
              .filter(
                (device) =>
                  device &&
                  typeof device.fp === "string" &&
                  device.fp &&
                  typeof device.name === "string",
              )
              .map((device) => ({
                fp: device.fp,
                name: device.name,
                ...(device.userId ? { userId: device.userId } : {}),
              })),
          }
        : {}),
      ...(Array.isArray(room.blacklist) && room.blacklist.length
        ? {
            blacklist: room.blacklist.filter(
              (fingerprint) => typeof fingerprint === "string" && fingerprint,
            ),
          }
        : {}),
    };
  }
}
