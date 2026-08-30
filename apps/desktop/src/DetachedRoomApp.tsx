import React, { useEffect } from "react";
import { RoomStage } from "./components/RoomStage";
import { DetachedWindowShell } from "./DetachedWindowShell";
import {
  bindRoomEvents,
  refreshRooms,
  selectRoom,
} from "./state/room-store";
import { detachedWindowRoomId } from "./state/store";

export default function DetachedRoomApp() {
  useEffect(() => {
    const roomId = detachedWindowRoomId();
    if (roomId) selectRoom(roomId);
    void refreshRooms();
    return bindRoomEvents();
  }, []);

  return (
    <DetachedWindowShell>
      {() => <RoomStage />}
    </DetachedWindowShell>
  );
}
