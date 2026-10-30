// A command-palette style picker: a text box over a filtered list. Used for
// quick open (Ctrl+P). Keyboard: arrows to move, Enter to pick, Esc to close.

export type PaletteItem = {
  label: string;
  detail?: string;
  /** Indices into `label` / `detail` to highlight as matched. */
  labelMarks?: number[];
  detailMarks?: number[];
  run: () => unknown;
};

export type Palette = { update(): void; close(): void };

const MAX_ROWS = 80;
let current: Palette | null = null;

/**
 * Subsequence match of `query` in `text`, scored so that consecutive
 * characters and matches at the start of words rank higher. Null when
 * `query` isn't a subsequence of `text`.
 */
export function fuzzy(query: string, text: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    // Prefer the next word start containing this character, if it comes before
    // the next plain occurrence would leave the rest unmatched.
    let i = t.indexOf(ch, from);
    if (i < 0) return null;
    for (let j = i; j < t.length; j++) {
      if (t[j] === ch && (j === 0 || /[\\/\-_. ]/.test(t[j - 1]))) {
        if (j === i || isSubsequence(q.slice(indices.length + 1), t, j + 1)) i = j;
        break;
      }
    }
    const prev = indices[indices.length - 1];
    if (prev !== undefined && i === prev + 1) score += 6;
    if (i === 0 || /[\\/\-_. ]/.test(t[i - 1])) score += 8;
    score -= Math.min(i - from, 12) * 0.3;
    indices.push(i);
    from = i + 1;
  }
  return { score: score - t.length * 0.02, indices };
}

function isSubsequence(q: string, t: string, from: number) {
  for (const ch of q) {
    from = t.indexOf(ch, from);
    if (from < 0) return false;
    from++;
  }
  return true;
}

function marked(text: string, marks: number[] | undefined) {
  const span = document.createElement("span");
  if (!marks?.length) {
    span.textContent = text;
    return span;
  }
  const set = new Set(marks);
  let run = "";
  let inMark = false;
  const flush = () => {
    if (!run) return;
    span.append(inMark ? Object.assign(document.createElement("mark"), { textContent: run }) : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) {
      flush();
      inMark = m;
    }
    run += text[i];
  }
  flush();
  return span;
}

export function openPalette(opts: { placeholder: string; empty: string; items: (query: string) => PaletteItem[] }): Palette {
  current?.close();
  const restoreFocus = document.activeElement;
  const backdrop = Object.assign(document.createElement("div"), { className: "palette-backdrop" });
  const box = Object.assign(document.createElement("div"), { className: "palette" });
  box.setAttribute("role", "dialog");
  const input = Object.assign(document.createElement("input"), { placeholder: opts.placeholder, spellcheck: false });
  input.setAttribute("role", "combobox");
  const list = Object.assign(document.createElement("div"), { className: "pl-list" });
  list.setAttribute("role", "listbox");
  box.append(input, list);
  document.body.append(backdrop, box);

  let items: PaletteItem[] = [];
  let selected = 0;

  function select(i: number) {
    const rows = list.children;
    rows[selected]?.classList.remove("selected");
    selected = Math.max(0, Math.min(items.length - 1, i));
    const row = rows[selected] as HTMLElement | undefined;
    row?.classList.add("selected");
    row?.scrollIntoView({ block: "nearest" });
  }

  function update() {
    items = opts.items(input.value).slice(0, MAX_ROWS);
    selected = 0;
    if (items.length === 0) {
      list.replaceChildren(Object.assign(document.createElement("div"), { className: "pl-empty", textContent: opts.empty }));
      return;
    }
    list.replaceChildren(
      ...items.map((item, i) => {
        const row = document.createElement("div");
        row.className = "pl-item";
        row.setAttribute("role", "option");
        const label = marked(item.label, item.labelMarks);
        label.className = "pl-label";
        row.append(label);
        if (item.detail) {
          const detail = marked(item.detail, item.detailMarks);
          detail.className = "pl-detail";
          row.append(detail);
        }
        row.addEventListener("pointermove", () => selected !== i && select(i));
        row.addEventListener("click", () => pick(i));
        return row;
      }),
    );
    select(0);
  }

  function close(refocus = true) {
    if (current !== palette) return;
    current = null;
    backdrop.remove();
    box.remove();
    if (refocus && restoreFocus instanceof HTMLElement) restoreFocus.focus({ preventScroll: true });
  }

  function pick(i: number) {
    const item = items[i];
    if (!item) return;
    close();
    void item.run();
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") select(selected + 1);
    else if (e.key === "ArrowUp") select(selected - 1);
    else if (e.key === "PageDown") select(selected + 10);
    else if (e.key === "PageUp") select(selected - 10);
    else if (e.key === "Enter") pick(selected);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  });
  backdrop.addEventListener("pointerdown", () => close());

  const palette: Palette = { update, close: () => close() };
  current = palette;
  update();
  input.focus();
  return palette;
}
