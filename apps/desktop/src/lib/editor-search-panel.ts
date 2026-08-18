import type { EditorView, Panel } from "@codemirror/view";
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
  getSearchQuery,
  selectMatches,
} from "@codemirror/search";
import { runScopeHandlers } from "@codemirror/view";

/**
 * VS Code–style find/replace panel for CodeMirror.
 * top-right floating widget with find row, toggles, replace row, match count.
 */
export function createVscodeSearchPanel(view: EditorView): Panel {
  return new VscodeSearchPanel(view);
}

class VscodeSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private view: EditorView;
  private query: SearchQuery;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseBtn: HTMLButtonElement;
  private wordBtn: HTMLButtonElement;
  private reBtn: HTMLButtonElement;
  private matchInfo: HTMLSpanElement;
  private replaceRow: HTMLElement;
  private replaceToggle: HTMLButtonElement;
  private commit: () => void;

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.commit = () => this.applyQuery();

    this.searchField = el("input", {
      type: "text",
      class: "cm-vs-input",
      placeholder: "查找",
      value: this.query.search,
      "main-field": "true",
      "aria-label": "查找",
    }) as HTMLInputElement;
    this.searchField.addEventListener("input", this.commit);
    this.searchField.addEventListener("keydown", (e) => this.onKey(e));

    this.replaceField = el("input", {
      type: "text",
      class: "cm-vs-input",
      placeholder: "替换",
      value: this.query.replace,
      "aria-label": "替换",
    }) as HTMLInputElement;
    this.replaceField.addEventListener("input", this.commit);
    this.replaceField.addEventListener("keydown", (e) => this.onKey(e));

    this.caseBtn = toggleBtn("Aa", "区分大小写", this.query.caseSensitive, () => {
      this.caseBtn.classList.toggle("on");
      this.commit();
    });
    this.wordBtn = toggleBtn("W", "全词匹配", this.query.wholeWord, () => {
      this.wordBtn.classList.toggle("on");
      this.commit();
    });
    this.reBtn = toggleBtn(".*", "正则表达式", this.query.regexp, () => {
      this.reBtn.classList.toggle("on");
      this.commit();
    });

    this.matchInfo = el("span", { class: "cm-vs-matches" }, ["0 结果"]) as HTMLSpanElement;

    const prevBtn = iconBtn("▲", "上一个 (Shift+Enter)", () => findPrevious(view));
    prevBtn.classList.add("cm-vs-nav");
    const nextBtn = iconBtn("▼", "下一个 (Enter)", () => findNext(view));
    nextBtn.classList.add("cm-vs-nav");
    const closeBtn = iconBtn("×", "关闭 (Esc)", () => closeSearchPanel(view));
    closeBtn.classList.add("cm-vs-close");

    this.replaceToggle = iconBtn("▸", "切换替换", () => {
      const open = this.replaceRow.classList.toggle("open");
      this.replaceToggle.classList.toggle("open", open);
      this.replaceToggle.textContent = open ? "▾" : "▸";
    });
    this.replaceToggle.classList.add("cm-vs-replace-toggle");

    const findRow = el("div", { class: "cm-vs-row" }, [
      this.replaceToggle,
      el("div", { class: "cm-vs-input-wrap" }, [
        this.searchField,
        el("div", { class: "cm-vs-input-toggles" }, [
          this.caseBtn,
          this.wordBtn,
          this.reBtn,
        ]),
      ]),
      this.matchInfo,
      prevBtn,
      nextBtn,
      closeBtn,
    ]);

    const replaceBtn = textBtn("替换", () => replaceNext(view));
    const replaceAllBtn = textBtn("全部替换", () => replaceAll(view));
    const selectAllBtn = textBtn("全选", () => selectMatches(view));

    this.replaceRow = el("div", { class: "cm-vs-row cm-vs-replace-row" }, [
      el("span", { class: "cm-vs-replace-spacer" }, []),
      el("div", { class: "cm-vs-input-wrap" }, [this.replaceField]),
      replaceBtn,
      replaceAllBtn,
      selectAllBtn,
    ]);

    this.dom = el("div", { class: "cm-search cm-vs-search" }, [
      findRow,
      this.replaceRow,
    ]);
    this.dom.addEventListener("keydown", (e) => {
      if (runScopeHandlers(view, e, "search-panel")) e.preventDefault();
    });
  }

  mount() {
    this.searchField.select();
    this.refreshMatchCount();
  }

  update() {
    // keep external query changes in sync
    const q = getSearchQuery(this.view.state);
    if (!q.eq(this.query)) this.setQuery(q);
    this.refreshMatchCount();
  }

  get pos() {
    return 80;
  }

  private setQuery(q: SearchQuery) {
    this.query = q;
    this.searchField.value = q.search;
    this.replaceField.value = q.replace;
    this.caseBtn.classList.toggle("on", q.caseSensitive);
    this.wordBtn.classList.toggle("on", q.wholeWord);
    this.reBtn.classList.toggle("on", q.regexp);
  }

  private applyQuery() {
    const next = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseBtn.classList.contains("on"),
      regexp: this.reBtn.classList.contains("on"),
      wholeWord: this.wordBtn.classList.contains("on"),
      replace: this.replaceField.value,
    });
    if (!next.eq(this.query)) {
      this.query = next;
      this.view.dispatch({ effects: setSearchQuery.of(next) });
    }
    this.refreshMatchCount();
  }

  private refreshMatchCount() {
    const q = getSearchQuery(this.view.state);
    if (!q.valid || !q.search) {
      this.matchInfo.textContent = "无结果";
      this.matchInfo.classList.add("empty");
      return;
    }
    let count = 0;
    const cursor = q.getCursor(this.view.state);
    while (!cursor.next().done) {
      count += 1;
      if (count > 999) break;
    }
    this.matchInfo.classList.toggle("empty", count === 0);
    this.matchInfo.textContent =
      count > 999 ? "999+ 结果" : count === 0 ? "无结果" : `${count} 结果`;
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.target === this.replaceField) {
        replaceNext(this.view);
      } else {
        (e.shiftKey ? findPrevious : findNext)(this.view);
      }
      this.refreshMatchCount();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(this.view);
    }
  }
}

function el(
  tag: string,
  attrs: Record<string, string>,
  children: (Node | string)[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function toggleBtn(
  label: string,
  title: string,
  on: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const b = el(
    "button",
    {
      type: "button",
      class: on ? "cm-vs-toggle on" : "cm-vs-toggle",
      title,
    },
    [label],
  ) as HTMLButtonElement;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

function iconBtn(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el(
    "button",
    { type: "button", class: "cm-vs-iconbtn", title },
    [label],
  ) as HTMLButtonElement;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

function textBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = el(
    "button",
    { type: "button", class: "cm-vs-textbtn", title: label },
    [label],
  ) as HTMLButtonElement;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}
