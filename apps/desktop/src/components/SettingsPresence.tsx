import React from "react";
import { useMotionPresence } from "../hooks/useMotionPresence";

export function SettingsPresence({ open, children }: { open: boolean; children: React.ReactNode }) {
  const mounted = useMotionPresence(open);
  return mounted ? <div className={`settings-presence${open ? "" : " is-exiting"}`} inert={!open}>{children}</div> : null;
}
