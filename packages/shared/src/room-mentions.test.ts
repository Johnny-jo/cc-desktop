import { describe, expect, it } from "vitest";
import { findRoomMentionedSeats } from "./room-mentions";

const seats = [
  { id: "human", name: "小林", kind: "human" },
  { id: "short", name: "开发", kind: "agent" },
  { id: "dev", name: "开发助手", kind: "agent" },
  { id: "review", name: "审查助手", kind: "agent" },
  { id: "space", name: "Code Review", kind: "agent" },
] as const;

describe("room mentions", () => {
  it("keeps all explicit targets in message order and deduplicates", () => {
    expect(findRoomMentionedSeats("@小林 @开发助手 @审查助手 @开发助手", seats).map(s => s.id))
      .toEqual(["human", "dev", "review"]);
  });
  it("prefers complete long names and permits punctuation or spaces", () => {
    expect(findRoomMentionedSeats("请看：@开发助手，@Code Review。", seats).map(s => s.id))
      .toEqual(["dev", "space"]);
  });
  it("does not treat email addresses or partial names as commands", () => {
    expect(findRoomMentionedSeats("mail@开发助手.example @开发助手Plus @开发助手们", seats))
      .toEqual([]);
  });
  it("treats regex syntax in a name literally", () => {
    expect(findRoomMentionedSeats("@C++ @dev[1]", [
      { id: "cpp", name: "C++" }, { id: "dev", name: "dev[1]" },
    ]).map(s => s.id)).toEqual(["cpp", "dev"]);
  });
});
