import type { SlashCommandItem } from "@claude-desktop/shared";

/** App-local slash commands shown when the user types `/` in the composer. */
export const APP_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    name: "new",
    description: "Start a new chat session",
  },
  {
    name: "clear",
    description: "Same as /new — clear current chat focus",
  },
  {
    name: "model",
    description: "Focus the model picker in the composer",
  },
  {
    name: "diff",
    description: "Toggle the Changes / Diff panel",
  },
  {
    name: "settings",
    description: "Open Settings",
  },
  {
    name: "permission",
    description: "Cycle permission mode (default → acceptEdits → plan)",
  },
  {
    name: "cpa",
    description: "Ensure CPA is ready and sync model list",
  },
  {
    name: "help",
    description: "List available slash commands",
  },
  {
    name: "compact",
    description: "Compress conversation history to reduce context usage",
  },
];

/** Merge app commands with SDK skills (app names win on conflict). */
export function mergeSlashCommands(
  sdkCommands: SlashCommandItem[] = [],
): SlashCommandItem[] {
  const appNames = new Set(APP_SLASH_COMMANDS.map((c) => c.name.toLowerCase()));
  const sdkOnly = sdkCommands.filter(
    (c) => !appNames.has(c.name.toLowerCase()),
  );
  return [...APP_SLASH_COMMANDS, ...sdkOnly];
}

export function filterSlashCommands(
  query: string,
  commands: SlashCommandItem[] = APP_SLASH_COMMANDS,
): SlashCommandItem[] {
  const q = query.replace(/^\//, "").toLowerCase().trim();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().startsWith(q) ||
      c.description.toLowerCase().includes(q),
  );
}

/** Parse leading slash from composer text: "/model foo" → { name: "model", rest: "foo" } */
export function parseLeadingSlash(
  text: string,
): { name: string; rest: string } | null {
  const m = text.match(/^\/([a-zA-Z0-9_-]*)(?:\s+(.*))?$/s);
  if (!m) return null;
  return { name: m[1] ?? "", rest: (m[2] ?? "").trim() };
}
