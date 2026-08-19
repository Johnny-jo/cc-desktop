/**
 * Inline session-change decorations for the CodeMirror file editor
 * (Cursor / Trae style): added lines get a green tint + gutter bar, deleted
 * lines are shown as red struck-through blocks above their anchor line.
 *
 * Data source: the session FileChange hunks (unified diff text) emitted by
 * the main-process DiffTracker. Line numbers come from parseHunkForDisplay.
 */
import { StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  groupDiffDisplayRows,
  parseHunkForDisplay,
} from "@claude-desktop/shared";

export type DiffChangeRun = {
  /** 1-based first new-file line in this run (anchor if dels-only). */
  startNewNo: number;
  /** 1-based last new-file line in this run. */
  endNewNo: number;
  dels: string[];
};

export type DiffLineMarks = {
  /** 1-based line numbers in the current (new) file that were added/changed. */
  added: Set<number>;
  /** Anchor new-file line number → deleted lines shown before it (Infinity = EOF). */
  delsBefore: Map<number, string[]>;
  /** Adjacent −/+ runs for block decorations. */
  runs: DiffChangeRun[];
};

function stripDelPrefix(text: string): string {
  return text.replace(/^-/, "");
}

function nextAnchorAfter(
  groups: ReturnType<typeof groupDiffDisplayRows>,
  from: number,
): number {
  for (let j = from; j < groups.length; j++) {
    const n = groups[j]!;
    if (n.kind === "lead" && n.row.newNo != null) return n.row.newNo;
    if (n.kind === "change") {
      const addNo = n.adds.find((a) => a.newNo != null)?.newNo;
      if (addNo != null) return addNo;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** Same anchor rule as mergeFullTextWithHunks: a deleted line belongs just
 * before the next hunk row that carries a new-file line number. */
export function lineMarksFromHunks(hunks: string): DiffLineMarks {
  const rows = parseHunkForDisplay(hunks, Number.MAX_SAFE_INTEGER);
  const groups = groupDiffDisplayRows(rows);
  const added = new Set<number>();
  const delsBefore = new Map<number, string[]>();
  const runs: DiffChangeRun[] = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (g.kind !== "change") continue;
    const delTexts = g.dels.map((d) => stripDelPrefix(d.text));
    const addNos = g.adds
      .map((a) => a.newNo)
      .filter((n): n is number => n != null);
    for (const no of addNos) added.add(no);
    const anchor = addNos.length ? Math.min(...addNos) : nextAnchorAfter(groups, i + 1);
    if (delTexts.length) {
      const list = delsBefore.get(anchor) ?? [];
      list.push(...delTexts);
      delsBefore.set(anchor, list);
    }
    runs.push({
      startNewNo: addNos.length ? Math.min(...addNos) : anchor,
      endNewNo: addNos.length ? Math.max(...addNos) : anchor,
      dels: delTexts,
    });
  }
  return { added, delsBefore, runs };
}

export const setDiffMarks = StateEffect.define<DiffLineMarks | null>();

class DelLinesWidget extends WidgetType {
  constructor(
    readonly lines: string[],
    readonly joined = false,
  ) {
    super();
  }

  override eq(other: DelLinesWidget): boolean {
    return (
      other.joined === this.joined &&
      other.lines.length === this.lines.length &&
      other.lines.every((l, i) => l === this.lines[i])
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = this.joined
      ? "cm-diff-del-block cm-diff-del-joined"
      : "cm-diff-del-block";
    for (const line of this.lines) {
      const div = document.createElement("div");
      div.className = "cm-diff-del-line";
      div.textContent = line || " ";
      wrap.appendChild(div);
    }
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function runForAddedLine(
  marks: DiffLineMarks,
  no: number,
): DiffChangeRun | undefined {
  return marks.runs.find(
    (r) => r.startNewNo <= no && no <= r.endNewNo && marks.added.has(no),
  );
}

function buildDecos(doc: Text, marks: DiffLineMarks): DecorationSet {
  const ranges: { from: number; deco: Decoration }[] = [];
  const lineCount = doc.lines;
  const joinedAnchors = new Set(
    marks.runs
      .filter((r) => r.dels.length > 0 && marks.added.has(r.startNewNo))
      .map((r) => r.startNewNo),
  );
  for (const no of marks.added) {
    if (no < 1 || no > lineCount) continue;
    const run = runForAddedLine(marks, no);
    const cls = ["cm-diff-add"];
    if (run && no === run.startNewNo) cls.push("cm-diff-run-first");
    if (run && no === run.endNewNo) cls.push("cm-diff-run-last");
    if (run && no === run.startNewNo && run.dels.length) {
      cls.push("cm-diff-run-after-del");
    }
    ranges.push({
      from: doc.line(no).from,
      deco: Decoration.line({ class: cls.join(" ") }),
    });
  }
  for (const [anchor, lines] of marks.delsBefore) {
    const from =
      anchor === Number.POSITIVE_INFINITY
        ? doc.length
        : anchor >= 1 && anchor <= lineCount
          ? doc.line(anchor).from
          : null;
    if (from == null) continue;
    ranges.push({
      from,
      deco: Decoration.widget({
        widget: new DelLinesWidget(lines, joinedAnchors.has(anchor)),
        block: true,
        side: -1,
      }),
    });
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from)),
    true,
  );
}

export const diffDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco;
    if (tr.docChanged) next = next.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDiffMarks)) {
        next = e.value ? buildDecos(tr.state.doc, e.value) : Decoration.none;
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});
