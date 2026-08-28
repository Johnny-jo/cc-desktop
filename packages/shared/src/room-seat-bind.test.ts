import { describe, expect, it } from "vitest";
import {
  canKickMember,
  canManageSeats,
  canSetMemberRole,
  countOnlineMembers,
  effectiveFilePolicy,
  resolveAiUserId,
  resolveWorkspaceUserId,
} from "./room-seat-bind";

describe("resolveWorkspaceUserId / resolveAiUserId", () => {
  it("prefers the new axes, then executor, then host", () => {
    expect(resolveWorkspaceUserId({}, "host")).toBe("host");
    expect(
      resolveWorkspaceUserId({ executorUserId: "b" }, "host"),
    ).toBe("b");
    expect(
      resolveWorkspaceUserId(
        { workspaceUserId: "w", executorUserId: "b" },
        "host",
      ),
    ).toBe("w");
    expect(resolveAiUserId({ executorUserId: "b" }, "host")).toBe("b");
    expect(
      resolveAiUserId({ aiUserId: "a", workspaceUserId: "w" }, "host"),
    ).toBe("a");
  });
});

describe("roles", () => {
  it("lets host and admin edit seats; only host promotes", () => {
    expect(canManageSeats("host")).toBe(true);
    expect(canManageSeats("admin")).toBe(true);
    expect(canManageSeats("member")).toBe(false);
    expect(canSetMemberRole("host")).toBe(true);
    expect(canSetMemberRole("admin")).toBe(false);
  });

  it("lets admin kick members but not host or other admins", () => {
    expect(canKickMember("host", "member")).toBe(true);
    expect(canKickMember("host", "admin")).toBe(true);
    expect(canKickMember("host", "host")).toBe(false);
    expect(canKickMember("admin", "member")).toBe(true);
    expect(canKickMember("admin", "admin")).toBe(false);
    expect(canKickMember("admin", "host")).toBe(false);
    expect(canKickMember("member", "member")).toBe(false);
  });
});

describe("countOnlineMembers", () => {
  it("treats missing online as present, and skips offline", () => {
    expect(
      countOnlineMembers([{ online: true }, { online: false }, {}]),
    ).toBe(2);
  });
});

describe("effectiveFilePolicy", () => {
  it("skips when the requester is the file owner or missing", () => {
    expect(effectiveFilePolicy("deny", "b", "b")).toBe("skip");
    expect(effectiveFilePolicy("deny", "b", null)).toBe("skip");
    expect(effectiveFilePolicy("allow", "b", "a")).toBe("allow");
    expect(effectiveFilePolicy(undefined, "b", "a")).toBe("ask");
  });
});
