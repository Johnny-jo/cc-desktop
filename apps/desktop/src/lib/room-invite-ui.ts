import { decodeRoomInvite, looksLikeRoomInvite } from "@claude-desktop/shared";

/**
 * Error to show next to the join dialog's invite input, or null when the text
 * is not an invite (plain host/IP) or decodes fine. CDR1 codes surface the
 * legacy-upgrade message from decodeRoomInvite; nothing is auto-filled.
 */
export function joinErrorForInvite(text: string): string | null {
  if (!looksLikeRoomInvite(text)) return null;
  try {
    decodeRoomInvite(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "邀请码无效";
  }
}

/** abcd…ef — invite modal / approval rows show a short host fingerprint. */
export function shortFingerprint(fp: string): string {
  const clean = fp.trim();
  if (clean.length <= 8) return clean;
  return `${clean.slice(0, 4)}…${clean.slice(-2)}`;
}
