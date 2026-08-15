import type { ModOfferPayload } from "@claude-desktop/shared";

export type JoinPrimaryAction = "join" | "sync-join";

export type JoinPrimaryInput = {
  inviteChecksum?: string;
  offer?: Pick<ModOfferPayload, "checksum"> | null;
  cacheHit?: boolean;
};

export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

export function joinPrimaryAction(input: JoinPrimaryInput): JoinPrimaryAction {
  const invite = input.inviteChecksum?.trim() ?? "";
  const offerChecksum = input.offer?.checksum?.trim() ?? "";
  const offerMatchesInvite = !invite || !offerChecksum || invite === offerChecksum;
  if (offerMatchesInvite && offerChecksum) {
    return input.cacheHit === true ? "join" : "sync-join";
  }
  if (invite && input.cacheHit === false) return "sync-join";
  return "join";
}

export function formatModBadge(
  offer?: Pick<ModOfferPayload, "id" | "version" | "checksum"> | null,
  template = "模组：{id}@{version} · {checksum}",
): string {
  if (!offer) return "";
  const id = offer.id?.trim() || "?";
  const version = offer.version?.trim() || "?";
  const short = (offer.checksum ?? "").trim().slice(0, 8);
  if (id === "?" && version === "?" && !short) return "";
  return fillTemplate(template, { id, version, checksum: short });
}

export function preferredPlaySeatId(
  seats: { id: string; takenOverBy?: string | null }[],
  seatViews: Record<string, unknown>,
  localUserId?: string | null,
): string | null {
  if (localUserId) {
    const taken = seats.find(
      (s) => s.takenOverBy === localUserId && seatViews[s.id] !== undefined,
    );
    if (taken) return taken.id;
  }
  return Object.keys(seatViews)[0] ?? null;
}

export function formatModSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type ModViewShape = {
  title: string;
  phase: string;
  lines: string[];
  badges?: { label: string; tone: string }[];
};

export function asModView(value: unknown): ModViewShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.phase !== "string") return null;
  if (!Array.isArray(o.lines) || o.lines.some((l) => typeof l !== "string")) {
    return null;
  }
  let badges: { label: string; tone: string }[] | undefined;
  if (o.badges !== undefined) {
    if (!Array.isArray(o.badges)) return null;
    badges = [];
    for (const b of o.badges) {
      if (!b || typeof b !== "object") return null;
      const rec = b as { label?: unknown; tone?: unknown };
      if (typeof rec.label !== "string") return null;
      badges.push({
        label: rec.label,
        tone: typeof rec.tone === "string" ? rec.tone : "",
      });
    }
  }
  return {
    title: o.title,
    phase: o.phase,
    lines: o.lines as string[],
    ...(badges ? { badges } : {}),
  };
}

export type ModActionSchema = { params?: unknown; hint?: string };

export function normalizeActions(
  raw: unknown,
): Record<string, ModActionSchema> {
  const out: Record<string, ModActionSchema> = {};
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (typeof a === "string" && a) out[a] = {};
      else if (
        a &&
        typeof a === "object" &&
        typeof (a as { name?: unknown }).name === "string"
      ) {
        const o = a as { name: string; params?: unknown; hint?: string };
        out[o.name] = { params: o.params, hint: o.hint };
      }
    }
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name) continue;
    if (value && typeof value === "object") {
      const o = value as { params?: unknown; hint?: string };
      out[name] = { params: o.params, hint: o.hint };
    } else {
      out[name] = {};
    }
  }
  return out;
}

export type ActionField = {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  enumValues?: string[];
  required: boolean;
};

export function actionFields(params: unknown): ActionField[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const schema = params as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const props = schema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  const fields: ActionField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const spec =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { type?: unknown; enum?: unknown })
        : {};
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      fields.push({
        name,
        type: "enum",
        enumValues: spec.enum.map((v) => String(v)),
        required: required.has(name),
      });
      continue;
    }
    if (spec.type === "number" || spec.type === "integer") {
      fields.push({ name, type: "number", required: required.has(name) });
    } else if (spec.type === "boolean") {
      fields.push({ name, type: "boolean", required: required.has(name) });
    } else {
      fields.push({ name, type: "string", required: required.has(name) });
    }
  }
  return fields;
}

export function offerHasMod(
  offer?: Pick<ModOfferPayload, "checksum"> | null,
): boolean {
  return Boolean(offer?.checksum);
}
