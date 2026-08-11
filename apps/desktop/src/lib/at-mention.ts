/**
 * Parse a trailing `@query` token from composer text for file-mention
 * autocomplete. Returns the query plus the start index of the `@` so the
 * caller can replace the token with the selected path.
 *
 * The `@` only triggers when it is at the start of the text or preceded by
 * whitespace — this avoids misfiring on emails like `user@host`.
 */
export type AtMention = {
  /** The partial path typed after `@` (may be empty). */
  query: string;
  /** Index of the `@` character in the original text. */
  start: number;
  /** Index just past the end of the query (== text length when trailing). */
  end: number;
};

export function parseTrailingAt(text: string): AtMention | null {
  // Find the last `@` that begins a token (start-of-text or after whitespace).
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "@") continue;
    const prev = i === 0 ? "" : text[i - 1];
    if (i > 0 && prev !== " " && prev !== "\n" && prev !== "\t") {
      // `@` glued to a non-space char (e.g. email) — not a mention trigger.
      return null;
    }
    const query = text.slice(i + 1);
    // The query runs to end of text and must not itself contain whitespace or
    // another `@` (which would mean the user already completed this token).
    if (/[\s@]/.test(query)) return null;
    return { query, start: i, end: text.length };
  }
  return null;
}
