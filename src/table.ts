// Markdown table help: Tab and Shift+Tab move between cells, lining the
// columns up as they go; Tab in the last cell adds a row.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

type Align = "left" | "center" | "right" | null;

/** A row's cells, split on pipes that aren't escaped (GFM wants `\|` even inside code). */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      cell += s[i] + s[++i];
    } else if (s[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += s[i];
  }
  cells.push(cell.trim());
  return cells;
}

const DELIMITER_CELL = /^:?-+:?$/;

function alignOf(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

function delimiter(align: Align, width: number) {
  const dashes = "-".repeat(Math.max(1, width - (align === "center" ? 2 : align ? 1 : 0)));
  return align === "center" ? `:${dashes}:` : align === "right" ? `${dashes}:` : align === "left" ? `:${dashes}` : dashes;
}

function pad(text: string, width: number, align: Align) {
  const space = width - text.length;
  if (align === "right") return " ".repeat(space) + text;
  if (align === "center") return " ".repeat(Math.floor(space / 2)) + text + " ".repeat(Math.ceil(space / 2));
  return text + " ".repeat(space);
}

/**
 * Line up a table's columns. `rows` are split cells; row 1 is the delimiter
 * row. Short rows get empty cells so every row has every column.
 */
export function formatRows(rows: string[][]): string[] {
  const columns = Math.max(...rows.map((r) => r.length));
  const aligns = Array.from({ length: columns }, (_, i) => alignOf(rows[1]?.[i] ?? ""));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(3, ...rows.map((r, n) => (n === 1 ? 0 : (r[i] ?? "").length))),
  );
  return rows.map((r, n) => {
    const cells = widths.map((w, i) => (n === 1 ? delimiter(aligns[i], w) : pad(r[i] ?? "", w, aligns[i])));
    return `| ${cells.join(" | ")} |`;
  });
}

/** A table from plain rows of cells, with the first row as its header. */
export function tableFromCells(rows: string[][]): string {
  const columns = Math.max(...rows.map((r) => r.length));
  return formatRows([rows[0], Array<string>(columns).fill("---"), ...rows.slice(1)]).join("\n");
}

/** The lines of the table around `pos`, if it's in one and nothing but indentation comes before it. */
function tableAt(state: EditorState, pos: number): { first: number; last: number; indent: string } | null {
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== "Table") continue;
      const line = state.doc.lineAt(node.from);
      const before = line.text.slice(0, node.from - line.from);
      if (before.trim()) return null; // a list marker shares the first row
      return { first: line.number, last: state.doc.lineAt(node.to).number, indent: before };
    }
  }
  return null;
}

/** Which cell `col` (an offset into the line) falls in. */
function cellIndex(line: string, col: number) {
  const before = line.slice(0, col);
  const lead = /^\s*\|/.test(line) ? 1 : 0;
  let pipes = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "\\") i++;
    else if (before[i] === "|") pipes++;
  }
  return Math.max(0, pipes - lead);
}

/** Where cell `c` of a formatted row starts and ends (its text, without padding). */
function cellRange(line: string, c: number): { from: number; to: number } {
  let pipes = -1;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] !== "|") continue;
    pipes++;
    if (pipes === c) start = i + 1;
    if (pipes === c + 1) {
      const text = line.slice(start, i);
      const from = start + (text.length - text.trimStart().length);
      const to = Math.max(from, start + text.trimEnd().length);
      // An empty cell puts the cursor after the space following the pipe.
      return text.trim() ? { from, to } : { from: start + 1, to: start + 1 };
    }
  }
  return { from: line.length, to: line.length };
}

function moveCell(dir: 1 | -1) {
  return (view: EditorView) => {
    const { state } = view;
    if (state.readOnly || state.selection.ranges.length > 1) return false;
    const head = state.selection.main.head;
    const table = tableAt(state, head);
    if (!table) return false;

    const lines: string[] = [];
    for (let n = table.first; n <= table.last; n++) lines.push(state.doc.line(n).text);
    const rows = lines.map(splitRow);
    if (rows.length < 2 || !rows[1].every((c) => DELIMITER_CELL.test(c))) return false;

    const cursorLine = state.doc.lineAt(head);
    let row = cursorLine.number - table.first;
    let col = cellIndex(cursorLine.text, head - cursorLine.from);
    const columns = Math.max(...rows.map((r) => r.length));
    col = Math.min(col, columns - 1);

    // Step to the next (or previous) cell, skipping the delimiter row.
    col += dir;
    if (col >= columns) {
      col = 0;
      row++;
    } else if (col < 0) {
      col = columns - 1;
      row--;
    }
    if (row === 1) row += dir;
    if (row < 0) return true; // already in the first cell
    if (row >= rows.length) rows.push(Array<string>(columns).fill(""));

    const formatted = formatRows(rows).map((l) => table.indent + l); // a table in a list stays in it
    const from = state.doc.line(table.first).from;
    const to = state.doc.line(table.last).to;
    const offset = formatted.slice(0, row).reduce((n, l) => n + l.length + 1, 0);
    const cell = cellRange(formatted[row], col);
    view.dispatch({
      changes: { from, to, insert: formatted.join("\n") },
      selection: EditorSelection.range(from + offset + cell.from, from + offset + cell.to),
      scrollIntoView: true,
      userEvent: "input.format",
    });
    return true;
  };
}

export const tableKeymap: KeyBinding[] = [
  { key: "Tab", run: moveCell(1) },
  { key: "Shift-Tab", run: moveCell(-1) },
];
