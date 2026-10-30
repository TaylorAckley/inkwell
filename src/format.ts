// Markdown formatting commands for the editor, bound to GitHub's shortcuts:
// Ctrl+B bold, Ctrl+I italic, Ctrl+E code, Ctrl+K link, Ctrl+Shift+X
// strikethrough, Ctrl+Shift+7/8 numbered/bulleted list, Ctrl+Shift+. quote.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";

/** Wrap each selection in `marker`, or unwrap it if it's already wrapped. */
function toggleWrap(marker: string) {
  return (view: EditorView) => {
    const { state } = view;
    const m = marker.length;
    const tr = state.changeByRange((range) => {
      let { from, to } = range;
      // Already wrapped, with the markers just outside the selection (or around the cursor).
      if (state.sliceDoc(from - m, from) === marker && state.sliceDoc(to, to + m) === marker) {
        return {
          changes: [
            { from: from - m, to: from },
            { from: to, to: to + m },
          ],
          range: EditorSelection.range(range.anchor - m, range.head - m),
        };
      }
      // Already wrapped, with the markers inside the selection.
      const text = state.sliceDoc(from, to);
      if (text.length >= 2 * m && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: [
            { from, to: from + m },
            { from: to - m, to },
          ],
          range: EditorSelection.range(from, to - 2 * m),
        };
      }
      // A bare cursor formats the word it's in.
      let cursor = -1;
      if (from === to) {
        const word = state.wordAt(from);
        if (word) {
          cursor = from;
          ({ from, to } = word);
        }
      }
      const changes = [
        { from, insert: marker },
        { from: to, insert: marker },
      ];
      if (cursor >= 0) return { changes, range: EditorSelection.cursor(cursor + m) };
      return { changes, range: EditorSelection.range(from + m, to + m) };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

/** `[text](|)`, or `[|](url)` when the selection is itself a URL. */
function insertLink(view: EditorView) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^(https?:\/\/|mailto:)\S+$/i.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + (text ? insert.length - 1 : 1)),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  return true;
}

type LineKind = "quote" | "bullet" | "ordered";

const PREFIX: Record<LineKind, RegExp> = {
  quote: /^(\s*)> ?/,
  bullet: /^(\s*)[-*+] (\[[ xX]\] )?/, // a task's checkbox goes with its bullet
  ordered: /^(\s*)\d+[.)] /,
};
/** Any list marker, so switching list type replaces the old marker. */
const ANY_LIST = /^(\s*)(?:[-*+]|\d+[.)]) /;

/** Toggle a quote or list marker on every selected line. */
function toggleLines(kind: LineKind) {
  return (view: EditorView) => {
    const { state } = view;
    const numbers = new Set<number>();
    for (const r of state.selection.ranges) {
      const last = state.doc.lineAt(r.to).number;
      for (let n = state.doc.lineAt(r.from).number; n <= last; n++) numbers.add(n);
    }
    const lines = [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n));
    const content = lines.filter((l) => l.text.trim());
    if (content.length === 0 && lines.length > 1) return false;
    const re = PREFIX[kind];
    const remove = content.length > 0 && content.every((l) => re.test(l.text));

    const changes: ChangeSpec[] = [];
    let n = 1;
    for (const line of lines) {
      if (!line.text.trim() && lines.length > 1) continue;
      if (remove) {
        const m = re.exec(line.text)!;
        changes.push({ from: line.from + m[1].length, to: line.from + m[0].length });
        continue;
      }
      const marker = kind === "quote" ? "> " : kind === "bullet" ? "- " : `${n++}. `;
      const existing = kind === "quote" ? null : ANY_LIST.exec(line.text);
      if (existing) {
        changes.push({ from: line.from + existing[1].length, to: line.from + existing[0].length, insert: marker });
      } else {
        const indent = /^\s*/.exec(line.text)![0].length;
        changes.push({ from: line.from + indent, insert: marker });
      }
    }
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

export const formatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleWrap("**") },
  { key: "Mod-i", run: toggleWrap("_") },
  { key: "Mod-e", run: toggleWrap("`") },
  { key: "Mod-Shift-x", run: toggleWrap("~~") },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-Shift-7", run: toggleLines("ordered") },
  { key: "Mod-Shift-8", run: toggleLines("bullet") },
  { key: "Mod-Shift-.", run: toggleLines("quote") },
];
