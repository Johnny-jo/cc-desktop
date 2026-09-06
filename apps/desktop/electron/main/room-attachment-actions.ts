import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ROOM_ATTACHMENT_LIMITS, parseRoomAttachments, type IpcInvokeMap, IPC } from "@claude-desktop/shared";
import type { RoomService } from "./room-service";

type Args = IpcInvokeMap[typeof IPC.roomAttachment]["args"][0];
type Result = IpcInvokeMap[typeof IPC.roomAttachment]["result"];
const IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
let active = 0;

/** Native picker is the only source of destination paths; never auto-open files. */
export async function performRoomAttachmentAction(
  rooms: Pick<RoomService, "get" | "getAttachment">,
  args: Args,
  choosePath: (name: string) => Promise<string | undefined>,
): Promise<Result> {
  if (!args || ![args.roomId, args.itemId, args.attachmentId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128) || (args.action !== "save" && args.action !== "preview")) return { ok: false, error: "附件操作无效" };
  if (active >= 2) return { ok: false, error: "附件处理中，请稍后重试" };
  active++;
  let temporary: string | undefined;
  try {
    const visible = () => rooms.get(args.roomId)?.items.find(i => i.id === args.itemId && !i.recalled)?.attachments?.find(a => a.id === args.attachmentId);
    const ref = visible();
    if (!ref || !parseRoomAttachments([ref])) throw new Error("附件不存在或已撤回");
    if (args.action === "preview" && (!IMAGES.has(ref.mimeType) || ref.size > ROOM_ATTACHMENT_LIMITS.modelTextBytes)) throw new Error("仅支持预览 5 MB 内的 PNG、JPEG、GIF 或 WebP 图片，请使用保存");
    let destination: string | undefined;
    if (args.action === "save") {
      const safeName = ref.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "") || "attachment";
      destination = await choosePath(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safeName) ? `_${safeName}` : safeName);
      if (!destination) return { ok: true, cancelled: true };
    }
    if (!visible()) throw new Error("附件已撤回");
    const loaded = await rooms.getAttachment(args.roomId, args.itemId, args.attachmentId);
    if (!loaded.ok || !loaded.attachment) throw new Error(loaded.error ?? "附件下载失败");
    const stat = await fs.stat(loaded.attachment.path);
    if (!stat.isFile() || stat.size !== ref.size) throw new Error("附件大小校验失败");
    const bytes = await fs.readFile(loaded.attachment.path);
    if (bytes.length !== ref.size || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("附件内容校验失败");
    if (!visible()) throw new Error("附件已撤回");
    if (!destination) return { ok: true, dataUrl: `data:${ref.mimeType};base64,${bytes.toString("base64")}` };
    temporary = path.join(path.dirname(destination), `.room-download-${randomUUID()}.part`);
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    if (!visible()) throw new Error("附件已撤回");
    await fs.rename(temporary, destination);
    temporary = undefined;
    return { ok: true, saved: true };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "附件操作失败" }; }
  finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    active--;
  }
}
