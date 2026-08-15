import { describe, expect, it } from "vitest";
import {
  actionFields,
  asModView,
  formatModBadge,
  formatModSize,
  joinPrimaryAction,
  normalizeActions,
  offerHasMod,
} from "./room-mod-ui";

describe("joinPrimaryAction", () => {
  it("stays join when there is no checksum / empty offer", () => {
    expect(joinPrimaryAction({})).toBe("join");
    expect(joinPrimaryAction({ offer: { checksum: "" } })).toBe("join");
    expect(joinPrimaryAction({ offer: null, cacheHit: false })).toBe("join");
  });

  it("joins when the offer is cached", () => {
    expect(
      joinPrimaryAction({
        offer: { checksum: "abc12345deadbeef" },
        cacheHit: true,
      }),
    ).toBe("join");
  });

  it("sync-joins when the offer is missing locally", () => {
    expect(
      joinPrimaryAction({
        offer: { checksum: "abc12345deadbeef" },
        cacheHit: false,
      }),
    ).toBe("sync-join");
  });

  it("sync-joins when offer is known but cache has not been confirmed", () => {
    expect(
      joinPrimaryAction({
        offer: { checksum: "abc12345deadbeef" },
      }),
    ).toBe("sync-join");
  });

  it("sync-joins from invite checksum only after a cache miss", () => {
    expect(
      joinPrimaryAction({
        inviteChecksum: "abc12345deadbeef",
        cacheHit: false,
      }),
    ).toBe("sync-join");
    expect(
      joinPrimaryAction({
        inviteChecksum: "abc12345deadbeef",
        cacheHit: true,
      }),
    ).toBe("join");
  });
});

describe("formatModBadge", () => {
  it("formats id@version and the first 8 checksum chars", () => {
    expect(
      formatModBadge({
        id: "werewolf",
        version: "1.0.0",
        checksum: "abcdef0123456789",
      }),
    ).toBe("模组：werewolf@1.0.0 · abcdef01");
  });

  it("returns empty when nothing is set", () => {
    expect(formatModBadge(null)).toBe("");
    expect(formatModBadge({ id: "", version: "", checksum: "" })).toBe("");
  });
});

describe("formatModSize", () => {
  it("rounds bytes up to KB", () => {
    expect(formatModSize(0)).toBe("0 KB");
    expect(formatModSize(800)).toBe("800 B");
    expect(formatModSize(2048)).toBe("2 KB");
  });
});

describe("asModView / actions helpers", () => {
  it("accepts a well-formed view and rejects missing keys", () => {
    expect(
      asModView({
        title: "投票",
        phase: "vote",
        lines: ["motion"],
        badges: [{ label: "voter", tone: "role" }],
      }),
    ).toEqual({
      title: "投票",
      phase: "vote",
      lines: ["motion"],
      badges: [{ label: "voter", tone: "role" }],
    });
    expect(asModView({ n: 1, phase: "play" })).toBeNull();
  });

  it("normalizes object and array action lists", () => {
    expect(normalizeActions([{ name: "inc" }])).toEqual({ inc: {} });
    expect(
      normalizeActions({
        vote: {
          params: { type: "object", properties: { choice: { enum: ["yes"] } } },
          hint: "Cast",
        },
      }),
    ).toEqual({
      vote: {
        params: { type: "object", properties: { choice: { enum: ["yes"] } } },
        hint: "Cast",
      },
    });
  });

  it("maps JSON Schema properties to form fields", () => {
    expect(
      actionFields({
        type: "object",
        properties: {
          choice: { type: "string", enum: ["yes", "no"] },
          text: { type: "string" },
          n: { type: "number" },
          ok: { type: "boolean" },
        },
        required: ["choice", "text"],
      }),
    ).toEqual([
      {
        name: "choice",
        type: "enum",
        enumValues: ["yes", "no"],
        required: true,
      },
      { name: "text", type: "string", required: true },
      { name: "n", type: "number", required: false },
      { name: "ok", type: "boolean", required: false },
    ]);
  });

  it("detects a real offer checksum", () => {
    expect(offerHasMod({ checksum: "ab" })).toBe(true);
    expect(offerHasMod({ checksum: "" })).toBe(false);
  });
});
