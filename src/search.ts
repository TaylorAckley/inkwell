import { invoke } from "@tauri-apps/api/core";
import { fileName, dirName, relativePath } from "./prefs";

type Hit = { path: string; line: number; col: number; len: number; text: string; offset: number };
type Result = { hits: Hit[]; files: number; truncated: boolean };

export type SearchHost = {
  root(): string | null;
  /** Open `path` with the match at (line, column, length) selected. */
  openAt(path: string, line: number, col: number, len: number): void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Context shown before the match, so the match stays visible in a narrow sidebar. */
const LEAD = 24;

/** The sidebar's Search panel: text search across every markdown file in the folder. */
export function createSearch(host: SearchHost) {
  const input = $<HTMLInputElement>("search-input");
  const caseBtn = $<HTMLButtonElement>("search-case");
  const status = $("search-status");
  const results = $("search-results");

  let matchCase = false;
  let timer = 0;
  let seq = 0;

  function setStatus(text: string) {
    status.textContent = text;
    status.hidden = !text;
  }

  function hitRow(hit: Hit) {
    const row = document.createElement("div");
    row.className = "sb-item sr-hit";
    row.title = `Line ${hit.line}`;
    // Trim leading indentation, then keep a little context before the match.
    const indent = hit.text.length - hit.text.trimStart().length;
    const start = Math.max(indent, hit.col - LEAD);
    const before = (start > indent || hit.offset > 0 ? "…" : "") + hit.text.slice(start, hit.col);
    const text = document.createElement("span");
    text.className = "sr-text";
    text.append(
      before,
      Object.assign(document.createElement("mark"), { textContent: hit.text.slice(hit.col, hit.col + hit.len) }),
      hit.text.slice(hit.col + hit.len),
    );
    const line = Object.assign(document.createElement("span"), { className: "sr-line", textContent: String(hit.line) });
    row.append(text, line);
    row.addEventListener("click", () => host.openAt(hit.path, hit.line, hit.offset + hit.col, hit.len));
    return row;
  }

  function render(result: Result, root: string) {
    const rows: HTMLElement[] = [];
    let last = "";
    const files = new Set(result.hits.map((h) => h.path)).size;
    for (const hit of result.hits) {
      if (hit.path !== last) {
        last = hit.path;
        const head = document.createElement("div");
        head.className = "sb-item sr-file";
        head.title = hit.path;
        const name = Object.assign(document.createElement("span"), { className: "sb-name", textContent: fileName(hit.path) });
        const rel = relativePath(root, dirName(hit.path));
        const where = Object.assign(document.createElement("span"), { className: "sb-meta", textContent: rel === "." ? "" : rel });
        head.append(Object.assign(document.createElement("span"), { className: "glyph sb-icon", innerHTML: "&#xE8A5;" }), name, where);
        head.addEventListener("click", () => host.openAt(hit.path, hit.line, hit.offset + hit.col, hit.len));
        rows.push(head);
      }
      rows.push(hitRow(hit));
    }
    results.replaceChildren(...rows);
    const n = result.hits.length;
    if (n === 0) setStatus(`No results in ${result.files.toLocaleString()} files`);
    else if (result.truncated) setStatus(`First ${n.toLocaleString()} results in ${files.toLocaleString()} files`);
    else setStatus(`${n.toLocaleString()} ${n === 1 ? "result" : "results"} in ${files.toLocaleString()} ${files === 1 ? "file" : "files"}`);
  }

  async function run() {
    const query = input.value;
    const root = host.root();
    const mySeq = ++seq;
    if (!root) {
      results.replaceChildren();
      return setStatus("Open a folder to search it");
    }
    if (query.trim().length < 2) {
      results.replaceChildren();
      return setStatus(query ? "Type at least 2 characters" : "");
    }
    setStatus("Searching…");
    const result = await invoke<Result>("search_folder", { root, query, matchCase });
    if (mySeq === seq) render(result, root);
  }

  function schedule(delay = 220) {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(), delay);
  }

  input.addEventListener("input", () => schedule());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep F2 / Delete from reaching the file tree
    if (e.key === "Enter") schedule(0);
    else if (e.key === "Escape" && input.value) {
      input.value = "";
      schedule(0);
    }
  });
  caseBtn.addEventListener("click", () => {
    matchCase = !matchCase;
    caseBtn.classList.toggle("on", matchCase);
    caseBtn.setAttribute("aria-pressed", String(matchCase));
    schedule(0);
  });
  setStatus("");

  return {
    /** Focus the box, seeded with `text` (e.g. the editor selection) if given. */
    focus(text?: string) {
      if (text && !text.includes("\n")) {
        input.value = text;
        schedule(0);
      }
      input.focus();
      input.select();
    },
    /** Re-run after the folder changes or files are saved. */
    refresh: () => input.value && schedule(0),
  };
}
