import type {
  RoomFilePolicy,
  RoomRole,
  RoomSeat,
} from "./room-protocol";

/** 工作目录落在谁身上：workspace → 老 executor → 房主。 */
export function resolveWorkspaceUserId(
  seat: Pick<RoomSeat, "workspaceUserId" | "executorUserId">,
  hostUserId: string,
): string {
  return seat.workspaceUserId || seat.executorUserId || hostUserId;
}

/** AI 来源：aiUserId → 工作目录主人 → 房主。 */
export function resolveAiUserId(
  seat: Pick<RoomSeat, "aiUserId" | "workspaceUserId" | "executorUserId">,
  hostUserId: string,
): string {
  return seat.aiUserId || resolveWorkspaceUserId(seat, hostUserId);
}

export function canManageSeats(role: RoomRole | undefined | null): boolean {
  return role === "host" || role === "admin";
}

/** 房主可踢任何人（除房主）；管理员只能踢普通成员。 */
export function canKickMember(
  actorRole: RoomRole | undefined | null,
  targetRole: RoomRole | undefined | null,
): boolean {
  if (targetRole === "host") return false;
  if (actorRole === "host") return true;
  if (actorRole === "admin") return targetRole !== "admin";
  return false;
}

export function canSetMemberRole(actorRole: RoomRole | undefined | null): boolean {
  return actorRole === "host";
}

/**
 * 文件策略只拦「别人」动我的项目。自己喊自己的席位、或请求人就是文件主人 → skip。
 */
export function memberIsOnline(m: { online?: boolean } | undefined | null): boolean {
  return m?.online !== false;
}

export function countOnlineMembers(
  members: Array<{ online?: boolean }>,
): number {
  return members.filter((m) => m.online !== false).length;
}

export function effectiveFilePolicy(
  policy: RoomFilePolicy | undefined,
  workspaceUserId: string,
  requesterUserId: string | null | undefined,
): RoomFilePolicy | "skip" {
  if (!requesterUserId || requesterUserId === workspaceUserId) return "skip";
  return policy ?? "ask";
}
