import type { EditorState } from "@codemirror/state";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";

export type Heading = { level: number; text: string; line: number };

/** Heading text as it reads in the preview: no emphasis markers, links reduced to their text. */
function plain(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, "$1$2")
    .trim();
}

/**
 * Headings from the markdown syntax tree, so `#` lines inside code blocks
 * don't count. Uses whatever the editor has parsed so far rather than
 * forcing a full parse, which could stall typing in a very large document.
 */
export function headings(state: EditorState): Heading[] {
  const tree = syntaxTree(state);
  const out: Heading[] = [];
  tree.iterate({
    enter(node) {
      const m = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!m) return;
      const line = state.doc.lineAt(node.from);
      let text = line.text;
      text = m[1] === "ATX" ? text.replace(/^\s*#{1,6}\s*/, "").replace(/\s+#+\s*$/, "") : text;
      out.push({ level: Number(m[2]), text: plain(text) || "(untitled)", line: line.number });
      return false;
    },
  });
  return out;
}

export type OutlineHost = {
  state(): EditorState;
  /** First source line visible at the top of the editor or preview. */
  topLine(): number;
  reveal(line: number): void;
};

/** The sidebar's Outline panel: the document's headings, tracking the scroll position. */
export function createOutline(el: HTMLElement, host: OutlineHost) {
  let items: Heading[] = [];
  let current = -1;
  let retry = 0;
  let retries = 0;

  function render() {
    const state = host.state();
    items = headings(state);
    current = -1;
    // The editor parses large documents in the background; pick up the rest when it has.
    clearTimeout(retry);
    if (syntaxTreeAvailable(state, state.doc.length)) retries = 0;
    else if (retries++ < 20) retry = window.setTimeout(render, 300);
    if (items.length === 0) {
      el.replaceChildren(Object.assign(document.createElement("div"), { className: "sb-empty", textContent: "No headings" }));
      return;
    }
    const min = Math.min(...items.map((h) => h.level));
    el.replaceChildren(
      ...items.map((h) => {
        const row = document.createElement("div");
        row.className = `sb-item ol-item ol-h${h.level}`;
        row.setAttribute("role", "treeitem");
        row.style.paddingLeft = `${10 + (h.level - min) * 14}px`;
        row.title = h.text;
        row.append(Object.assign(document.createElement("span"), { className: "sb-name", textContent: h.text }));
        row.addEventListener("click", () => host.reveal(h.line));
        return row;
      }),
    );
    highlight();
  }

  /** Mark the heading of the section currently at the top of the view. */
  function highlight() {
    if (items.length === 0) return;
    const top = host.topLine();
    let i = -1;
    while (i + 1 < items.length && items[i + 1].line <= top) i++;
    if (i === current) return;
    el.children[current]?.classList.remove("active");
    current = i;
    const row = el.children[i] as HTMLElement | undefined;
    row?.classList.add("active");
    row?.scrollIntoView({ block: "nearest" });
  }

  return { render, highlight };
}
