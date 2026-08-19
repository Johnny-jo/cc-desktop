# Diff change runs — adjacent −/+ as one block

Date: 2026-08-19

## Goal

Show session diffs as **blocks**, not isolated tinted lines. Only merge rows that
are adjacent in display order. A context / hunk-header / meta line always splits.

Applies to:

- Changes panel (`DiffView`) — both diff-only and full-text modes
- File editor inline decorations (`editor-diff-deco.ts`)

## Grouping

`groupDiffDisplayRows(rows)` walks `DiffDisplayRow[]` and emits:

- `{ kind: "lead", row }` — `ctx` / `hunk` / `meta` (passthrough)
- `{ kind: "change", dels, adds }` — maximal run of `del` and/or `add`

A replacement (dels then adds, no ctx between) is **one** change group.
Two replacements separated by ctx are **two** groups.
A single added or deleted line is still a one-line group.

Does **not** change hunk generation (`lineDiff` / `buildEditHunk`).

## Surfaces

**DiffView:** wrap each change group in `.diff-change-run` (red block then green
block, shared rounded outline, no gap). Gutters unchanged.

**Editor:** extend `lineMarksFromHunks` with `runs: { startNewNo, endNewNo, dels }[]`.
Deleted ghost widget stays above the first new line of the run (or EOF). Consecutive
added lines get `cm-diff-add` plus first/last classes so CSS fuses the red widget
to the green lines without wrapping document lines in a widget.

## Out of scope

- Folding / collapsing hunks
- Changing unified-diff text
- Git gutter
