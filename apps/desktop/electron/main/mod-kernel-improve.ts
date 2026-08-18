import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compileKernelActivate, ModKernel, type KernelManifest, type KernelRoomView, type RoomKv } from "./mod-kernel";

export type KernelAutonomy = 0 | 1 | 2;

export type ImproveDecision = "pending" | "apply" | "reject";

const emptyRoom: KernelRoomView = { id: "trial", seats: [] };

export function sameCapabilityBoundary(a: KernelManifest, b: KernelManifest): boolean {
  const norm = (xs: string[]) => [...xs].sort().join("\0");
  return (
    a.id === b.id &&
    norm(a.inject) === norm(b.inject) &&
    norm(a.provides) === norm(b.provides) &&
    norm(a.permissions) === norm(b.permissions) &&
    norm(a.hooks) === norm(b.hooks)
  );
}

export function trialKernelSource(
  manifest: KernelManifest,
  source: string,
  storage?: RoomKv,
): { ok: true; provides: string[] } | { ok: false; error: string } {
  try {
    const activate = compileKernelActivate(source);
    const kernel = new ModKernel(storage);
    const graph = kernel.start([{ manifest, activate }], emptyRoom);
    void kernel.dispose();
    const failed = graph.failed.find((p) => p.id === manifest.id);
    if (failed) return { ok: false, error: failed.failedReason ?? "trial failed" };
    const pending = graph.pending.find((p) => p.id === manifest.id);
    if (pending) return { ok: false, error: pending.pendingReason ?? "trial pending" };
    const active = graph.active.find((p) => p.id === manifest.id);
    if (!active) return { ok: false, error: "trial not active" };
    return { ok: true, provides: [...active.provides] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function decideImproveApply(opts: {
  autonomy: KernelAutonomy;
  trialOk: boolean;
  currentProvides: string[];
  nextProvides: string[];
}): ImproveDecision {
  if (!opts.trialOk) return "reject";
  if (opts.autonomy === 0) return "pending";
  if (opts.autonomy === 1) {
    const a = [...opts.currentProvides].sort().join("\0");
    const b = [...opts.nextProvides].sort().join("\0");
    return a === b ? "apply" : "pending";
  }
  return "apply";
}

export type KernelProposal = {
  id: string;
  packId: string;
  modJs: string;
  at: number;
  note?: string;
  status: "pending" | "applied" | "rejected" | "failed";
  decision: ImproveDecision;
  error?: string;
};

export type KernelRevision = {
  packId: string;
  checksum: string;
  manifestSource: string;
  modJs: string;
  at: number;
};

export type KernelLiveSource = {
  packId: string;
  modJs: string;
  at: number;
};

export type ImproveSnapshot = {
  autonomy: KernelAutonomy;
  proposals: KernelProposal[];
  revisions: KernelRevision[];
  lives: KernelLiveSource[];
};

const MAX_REV = 8;
const MAX_PROP = 20;
const MAX_LIVE = 20;

export class KernelImproveStore {
  autonomy: KernelAutonomy = 0;
  proposals: KernelProposal[] = [];
  revisions: KernelRevision[] = [];
  lives: KernelLiveSource[] = [];

  constructor(private readonly filePath: string) {
    this.read();
  }

  snapshot(): ImproveSnapshot {
    return {
      autonomy: this.autonomy,
      proposals: this.proposals.map((p) => ({ ...p })),
      revisions: this.revisions.map((r) => ({ ...r })),
      lives: this.lives.map((l) => ({ ...l })),
    };
  }

  setAutonomy(level: KernelAutonomy): void {
    this.autonomy = level;
    this.write();
  }

  addProposal(p: Omit<KernelProposal, "id" | "at"> & { id?: string; at?: number }): KernelProposal {
    const item: KernelProposal = {
      id: p.id ?? randomUUID(),
      packId: p.packId,
      modJs: p.modJs,
      at: p.at ?? Date.now(),
      status: p.status,
      decision: p.decision,
      ...(p.note ? { note: p.note } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
    this.proposals.unshift(item);
    this.proposals = this.proposals.slice(0, MAX_PROP);
    this.write();
    return item;
  }

  updateProposal(id: string, patch: Partial<KernelProposal>): KernelProposal | null {
    const cur = this.proposals.find((p) => p.id === id);
    if (!cur) return null;
    Object.assign(cur, patch);
    this.write();
    return cur;
  }

  pushRevision(rev: KernelRevision): void {
    this.revisions.unshift(rev);
    this.revisions = this.revisions.slice(0, MAX_REV);
    this.write();
  }

  lastRevision(packId: string): KernelRevision | undefined {
    return this.revisions.find((r) => r.packId === packId);
  }

  setLive(packId: string, modJs: string): void {
    this.lives = [
      { packId, modJs, at: Date.now() },
      ...this.lives.filter((l) => l.packId !== packId),
    ].slice(0, MAX_LIVE);
    this.write();
  }

  liveSource(packId: string): string | undefined {
    return this.lives.find((l) => l.packId === packId)?.modJs;
  }

  private read(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<ImproveSnapshot>;
      if (raw.autonomy === 0 || raw.autonomy === 1 || raw.autonomy === 2) {
        this.autonomy = raw.autonomy;
      }
      if (Array.isArray(raw.proposals)) this.proposals = raw.proposals;
      if (Array.isArray(raw.revisions)) this.revisions = raw.revisions;
      if (Array.isArray(raw.lives)) this.lives = raw.lives;
    } catch {
      // empty
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot()), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
