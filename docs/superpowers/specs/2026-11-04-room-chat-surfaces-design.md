# Unified group conversation surfaces

Approved in chat: update both the group message area and composer. Use the existing
single-chat widths, typography, bubble shapes, composer surface and buttons, while
retaining group avatars, sender names and compact reply quotes inspired by the
provided Grok Bot reference.

- Reuse the existing `composer`, `composer-input`, `composer-bar`, `bubble`,
  `bubble-user` and `bubble-assistant` rules rather than copying their values.
- Center message content and the composer against the same `--chat-max` column.
  Keep the timeline scrollbar at the outside edge and the collaboration sidebar
  responsive. Avatars and names remain explicit for each sender.
- Human bubbles use the single-chat surface; assistant prose keeps the single-chat
  open Markdown treatment. Preserve quote/code/attachment styling and live output.
- Add the same functional plus attachment control as single chat, using the
  existing group upload pipeline. Keep @ selection, quoting, recall, send guards,
  clipboard, file limits and multi-Agent routing intact. Textarea grows to the
  same 180px maximum as single chat.
- Verify existing group behavior tests, compare computed single/group styles in
  real Electron at wide/narrow widths and both themes, inspect screenshots, and
  run typecheck/build. UI fixtures use synthetic room data, not a live multi-user
  network session.

Implementation order: shared classes and obsolete-rule cleanup; group-only identity
and quote layout; attachment affordance and textarea growth; behavior/DOM checks.

## Validation

- 172 existing/new group tests passed across RoomStage, RoomTimeline and
  RoomAttachments. The new file-picker tests cover the existing attachment
  pipeline and disabled state while offline.
- Desktop typecheck, production build and `git diff --check` passed.
- `node scripts/verify-room-chat.mjs` compares computed styles against the actual
  single-chat Composer and MessageList in Electron: composer surface, textarea,
  outgoing bubble and assistant Markdown match in both themes.
- The DOM fixture exercised quoting, @ selection, adding a PDF and the resulting
  send payload. At 780px and 420px, the composer stays inside the window, the
  textarea caps at 180px and the send control remains visible. Console errors: 0.
- Screenshots were inspected in light/dark and narrow layouts. These checks use
  synthetic room data and a stubbed IPC boundary; no live peer messages were sent.
