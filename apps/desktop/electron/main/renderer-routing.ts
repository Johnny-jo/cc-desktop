export type RendererScope =
  | { kind: "main" }
  | { kind: "session"; sessionId: string }
  | { kind: "room"; roomId: string };

/** Main is the overview; detached windows receive only their bound stream. */
export function acceptsSession(
  scope: RendererScope,
  sessionId: string,
  relatedRoomId?: string,
): boolean {
  return (
    scope.kind === "main" ||
    (scope.kind === "session" && scope.sessionId === sessionId) ||
    (Boolean(relatedRoomId) &&
      scope.kind === "room" &&
      scope.roomId === relatedRoomId)
  );
}

export function acceptsRoom(scope: RendererScope, roomId: string): boolean {
  return (
    scope.kind === "main" ||
    (scope.kind === "room" && scope.roomId === roomId)
  );
}
