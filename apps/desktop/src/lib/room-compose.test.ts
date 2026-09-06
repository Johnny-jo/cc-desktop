import { describe, expect, it } from "vitest";
import { resolveRoomComposeTargets } from "./room-compose";

const seats = [
  { id: "me", name: "我", kind: "human", occupantUserId: "u1" },
  { id: "lin", name: "小林", kind: "human", occupantUserId: "u2" },
  { id: "dev", name: "开发助手", kind: "agent", occupantUserId: null },
  { id: "review", name: "审查助手", kind: "agent", occupantUserId: null },
] as const;

describe("room composer targets", () => {
  it("sends mixed mentions as one human message without selecting a recipient first", () => {
    expect(resolveRoomComposeTargets("@小林 @开发助手 @审查助手 ", seats, "u1", null, [
      { seatId: "lin", start: 0, end: 3 },
      { seatId: "dev", start: 4, end: 9 },
      { seatId: "review", start: 10, end: 15 },
    ]))
      .toEqual({ sendSeatId: "me", stopSeatIds: ["dev", "review"] });
  });
  it("keeps the human sender despite historical Agent selection", () => {
    expect(resolveRoomComposeTargets("do work", seats, "u1", "dev"))
      .toEqual({ sendSeatId: "me", stopSeatIds: ["dev"] });
    expect(resolveRoomComposeTargets("hello", seats, "u1", null).sendSeatId).toBe("me");
  });
  it("human mentions do not mask the explicitly selected stop target", () => {
    expect(resolveRoomComposeTargets("@小林 /stop", seats, "u1", "dev", [
      { seatId: "lin", start: 0, end: 3 },
    ]))
      .toEqual({ sendSeatId: "me", stopSeatIds: ["dev"] });
  });
  it("stops only distinct explicitly mentioned Agents", () => {
    expect(resolveRoomComposeTargets("@审查助手 @审查助手 /stop", seats, "u1", "dev", [
      { seatId: "review", start: 0, end: 5 },
      { seatId: "review", start: 6, end: 11 },
    ]).stopSeatIds)
      .toEqual(["review"]);
  });
  it("ignores typed or pasted names and damaged trailing spaces", () => {
    expect(resolveRoomComposeTargets("@审查助手 /stop", seats, "u1", null).stopSeatIds).toEqual([]);
    expect(resolveRoomComposeTargets("@审查助手\n/stop", seats, "u1", null, [
      { seatId: "review", start: 0, end: 5 },
    ]).stopSeatIds).toEqual([]);
  });
  it("never impersonates an Agent when my human seat is missing", () => {
    expect(resolveRoomComposeTargets("hello", seats, undefined, "dev").sendSeatId).toBeUndefined();
  });
});
