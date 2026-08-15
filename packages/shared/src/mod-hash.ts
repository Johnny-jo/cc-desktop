import { createHash } from "node:crypto";

export function hashModFiles(manifestSource: string, hostJsSource: string): string {
  return createHash("sha256")
    .update(manifestSource, "utf8")
    .update(hostJsSource, "utf8")
    .digest("hex");
}
