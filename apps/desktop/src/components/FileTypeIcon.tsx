import React from "react";

/** Small vector glyphs keep the explorer consistent across platforms. */
export function FileTypeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  const kind = ["xlsx", "xls", "csv"].includes(ext) ? "sheet"
    : ["ts", "tsx", "js", "jsx", "py", "vue", "html", "css", "ps1", "sh"].includes(ext) ? "code"
    : ["toml", "json", "yaml", "yml", "ini"].includes(ext) ? "config"
    : ext === "md" ? "markdown" : lower.startsWith(".git") ? "git" : "file";
  const label = ({ ts: "TS", tsx: "TS", js: "JS", jsx: "JS", py: "Py", vue: "V", css: "#" } as Record<string, string>)[ext];
  return <svg className={`ft-type-icon ft-type-${kind} ft-ext-${ext}`} viewBox="0 0 16 16" fill="none" aria-hidden>
    {kind === "sheet" ? <><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 6h12M2 10h12M6 2v12" /></>
      : kind === "config" ? <><path d="m8 1 2 2 3 .5.5 3L15 8l-1.5 1.5-.5 3-3 .5-2 2-2-2-3-.5-.5-3L1 8l1.5-1.5.5-3L6 3Z" /><circle cx="8" cy="8" r="2.5" /></>
      : kind === "markdown" ? <><circle cx="8" cy="8" r="6" /><path d="M8 7v5M8 4v1" /></>
      : kind === "git" ? <><path d="m8 1 7 7-7 7-7-7Z M5 4l6 6M8 7v5" /><circle cx="5" cy="4" r=".6" /><circle cx="11" cy="10" r=".6" /></>
      : kind === "code" ? label ? <text x="8" y="11" textAnchor="middle" stroke="none" fill="currentColor" fontSize="10" fontWeight="700">{label}</text> : <path d="m6 4-4 4 4 4m4-8 4 4-4 4" />
      : <><path d="M4 1.5h5L12 5v9.5H4Z M9 1.5V5h3M6 8h4M6 11h4" /></>}
  </svg>;
}
