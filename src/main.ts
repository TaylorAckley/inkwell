import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save, ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import hljs from "highlight.js/lib/common";
import { editorTheme, markdownHighlight } from "./editor-theme";
import { prefs, fileName, dirName, samePath, isInside, relativePath } from "./prefs";
import { createSidebar } from "./sidebar";
import { createOutline } from "./outline";
import { createSearch } from "./search";
import { fuzzy, openPalette, type PaletteItem } from "./palette";
import { formatKeymap } from "./format";
import { IMAGE_FILE, altText, linkTarget, pastedImage, saveImage } from "./images";
import { enhance, RICH_LANGUAGES } from "./rich";
import { showMenu, showMenuAt, type MenuItem } from "./menu";
import { copy, editorItems, loadEditors, pathItems, reportError, run, toast } from "./actions";
import { copyRich, previewHtml, selectionIn, standaloneHtml } from "./export";
import { WELCOME } from "./welcome";

type Mode = "edit" | "split" | "preview";
type Theme = "light" | "dark";
type Tab = "files" | "outline" | "search";
/** A place in the document: 1-based line, plus an optional UTF-16 column and selection length. */
type At = { line: number; col?: number; len?: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appWindow = getCurrentWindow();

const workspace = $("workspace");
const editorPane = $("editor-pane");
const previewPane = $("preview-pane");
const preview = $("preview");
const splitter = $("splitter");

// ---------------------------------------------------------------------------
// Document state

const doc = {
  path: null as string | null,
  savedText: "",
  dirty: false,
  crlf: false,
};

/** Never equal to real text, so a document whose file was deleted stays dirty. */
const ORPHANED = "\u0000orphaned";

function updateTitle() {
  const name = fileName(doc.path);
  $("doc-title").textContent = name;
  $("dirty-dot").classList.toggle("on", doc.dirty);
  $("st-path").textContent = doc.path ?? "Not saved";
  $("st-eol").textContent = doc.crlf ? "CRLF" : "LF";
  void appWindow.setTitle(`${doc.dirty ? "• " : ""}${name} — Inkwell`);
}

function refreshDirty(text: string) {
  const dirty = text.length !== doc.savedText.length || text !== doc.savedText;
  if (dirty !== doc.dirty) {
    doc.dirty = dirty;
    updateTitle();
  }
}

// ---------------------------------------------------------------------------
// Per-file cursor and scroll position, so reopening a file picks up where you left off

type Position = { top: number; anchor: number; head: number };
const MAX_POSITIONS = 60;
const positions = prefs.get<Record<string, Position>>("positions", {});
let positionTimer = 0;

function savePosition() {
  clearTimeout(positionTimer);
  if (!doc.path) return;
  const key = doc.path.toLowerCase();
  const { anchor, head } = view.state.selection.main;
  delete positions[key]; // re-insert so the most recent entry is last
  positions[key] = { top: Math.round(view.scrollDOM.scrollTop), anchor, head };
  const keys = Object.keys(positions);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete positions[k];
  prefs.set("positions", positions);
}

function queueSavePosition() {
  clearTimeout(positionTimer);
  positionTimer = window.setTimeout(savePosition, 400);
}

function restorePosition(path: string) {
  const pos = positions[path.toLowerCase()];
  if (!pos) return;
  const len = view.state.doc.length;
  view.dispatch({ selection: { anchor: Math.min(pos.anchor, len), head: Math.min(pos.head, len) } });
  lastScrollSource = "editor";
  requestAnimationFrame(() => (view.scrollDOM.scrollTop = pos.top));
}

// ---------------------------------------------------------------------------
// Editor

function editorExtensions() {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    placeholder("Start writing…"),
    // Includes the markdown keymap: Enter continues lists, tasks and quotes;
    // Backspace removes an empty list marker.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlight),
    editorTheme,
    keymap.of([...formatKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.domEventHandlers({ paste: pasteImage }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        scheduleRender();
        queueOutline();
      }
      if (u.selectionSet || u.docChanged) updateCursorStatus();
      if (u.selectionSet) queueSavePosition();
      if (u.heightChanged || u.geometryChanged) pairs = null;
    }),
  ];
}

const view = new EditorView({
  parent: editorPane,
  state: EditorState.create({ doc: "", extensions: editorExtensions() }),
});

/** Replace the document. `at` jumps to a place instead of restoring the last position. */
function setDocument(text: string, path: string | null, at?: At) {
  savePosition(); // for the document being replaced
  doc.crlf = text.includes("\r\n");
  const normalized = doc.crlf ? text.replace(/\r\n/g, "\n") : text;
  doc.path = path;
  doc.savedText = normalized;
  doc.dirty = false;
  // A fresh state also resets undo history, which is what you want on open.
  view.setState(EditorState.create({ doc: normalized, extensions: editorExtensions() }));
  view.scrollDOM.scrollTop = 0;
  previewPane.scrollTop = 0;
  if (at) void reveal(at);
  else if (path) restorePosition(path);
  prefs.set("lastFile", path);
  updateTitle();
  updateCursorStatus();
  scheduleRender();
  queueOutline();
  void invoke("watch_file", { path });
  sidebar.setActive(path);
}

/** Select a place in the document and scroll it to the top of the editor (or preview). */
async function reveal(at: At) {
  const d = view.state.doc;
  const line = d.line(Math.min(Math.max(1, at.line), d.lines));
  const from = Math.min(line.from + (at.col ?? 0), line.to);
  const to = Math.min(from + (at.len ?? 0), line.to);
  lastScrollSource = "editor";
  view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 48 }) });
  if (mode !== "preview") return view.focus();
  if (previewStale) await render();
  scrollPreviewTo(line.number);
}

/** Scroll the preview to the block rendered from source line `line`. */
function scrollPreviewTo(line: number) {
  let target: HTMLElement | null = null;
  for (const el of preview.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
    if (parseInt(el.dataset.sourcepos!, 10) > line) break;
    target = el;
  }
  const offset = target ? target.getBoundingClientRect().top - previewPane.getBoundingClientRect().top - 16 : -Infinity;
  previewPane.scrollTop = Math.max(0, previewPane.scrollTop + offset);
}

/** The source line at the top of whichever pane the reader is looking at. */
function topLine(): number {
  if (mode === "preview") {
    const top = previewPane.getBoundingClientRect().top + 24;
    let line = 1;
    for (const el of preview.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
      if (el.getBoundingClientRect().top > top) break;
      line = parseInt(el.dataset.sourcepos!, 10);
    }
    return line;
  }
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentPadding.top + 24);
  return view.state.doc.lineAt(block.from).number;
}

/** Bring in an external edit as a minimal change, so scroll position, cursor and undo history survive. */
function applyExternalText(text: string) {
  doc.crlf = text.includes("\r\n");
  const next = doc.crlf ? text.replace(/\r\n/g, "\n") : text;
  const cur = view.state.doc.toString();
  let start = 0;
  const max = Math.min(cur.length, next.length);
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--;
    endNext--;
  }
  doc.savedText = next;
  doc.dirty = false;
  if (start !== endCur || start !== endNext) {
    view.dispatch({ changes: { from: start, to: endCur, insert: next.slice(start, endNext) } });
  }
  updateTitle();
}

let externalPrompt = false;
void listen<string>("file-changed", async (e) => {
  if (!samePath(e.payload, doc.path) || externalPrompt) return;
  const path = doc.path!;
  if (doc.dirty) {
    externalPrompt = true;
    const reload = await ask(`${fileName(path)} changed on disk. Reload it and lose your unsaved changes?`, {
      title: "Inkwell",
      kind: "warning",
      okLabel: "Reload",
      cancelLabel: "Keep mine",
    });
    externalPrompt = false;
    if (!reload) return;
  }
  try {
    const text = await invoke<string>("read_file", { path });
    if (samePath(path, doc.path)) applyExternalText(text);
  } catch {
    /* deleted or locked mid-write; the next change event will retry */
  }
});

function updateCursorStatus() {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  $("st-pos").textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}

// ---------------------------------------------------------------------------
// Preview rendering

let renderQueued = false;
let renderSeq = 0;
let previewStale = true;
/** While exporting, diagrams render in the light theme to match the printed page. */
let exporting = false;

function scheduleRender() {
  previewStale = true;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    void render();
  });
}

/** Render the preview. `force` renders even when the preview is hidden (for export). */
async function render(force = false) {
  const text = view.state.doc.toString();
  refreshDirty(text);
  const words = text.match(/\S+/g)?.length ?? 0;
  $("st-words").textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;

  if (mode === "edit" && !force) return; // rendered lazily when the preview is shown
  const seq = ++renderSeq;
  const html = await invoke<string>("render_markdown", { source: text });
  if (seq !== renderSeq) return; // a newer render superseded this one

  preview.innerHTML = html;
  previewStale = false;
  resolveImages();
  highlightCode();
  pairs = null;
  await enhance(preview, currentTheme(), () => seq === renderSeq);
  if (seq !== renderSeq) return;
  addCopyButtons();
  pairs = null;
  if (mode === "split" && lastScrollSource === "editor") syncScroll("editor");
}

function resolveImages() {
  if (!doc.path) return;
  const base = dirName(doc.path);
  for (const img of preview.querySelectorAll<HTMLImageElement>("img[src]")) {
    const src = img.getAttribute("src")!;
    if (/^(https?:|data:|asset:)/i.test(src)) continue;
    const abs = /^([a-z]:[\\/]|[\\/]{2})/i.test(src) ? src : `${base}\\${src.replace(/^\.?[\\/]/, "")}`;
    img.src = convertFileSrc(decodeURI(abs).replace(/\//g, "\\"));
  }
}

const highlightCache = new Map<string, string>();

function highlightCode() {
  for (const code of preview.querySelectorAll<HTMLElement>("pre > code")) {
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
    if (!lang || RICH_LANGUAGES.has(lang) || !hljs.getLanguage(lang)) continue;
    const source = code.textContent ?? "";
    const key = `${lang}\0${source}`;
    let out = highlightCache.get(key);
    if (out === undefined) {
      out = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
      if (highlightCache.size > 500) highlightCache.clear();
      highlightCache.set(key, out);
    }
    code.innerHTML = out;
    code.classList.add("hljs");
  }
}

function addCopyButtons() {
  for (const pre of preview.querySelectorAll<HTMLElement>("pre")) {
    if (!pre.querySelector(":scope > code")) continue;
    const b = document.createElement("button");
    b.className = "code-copy";
    b.title = "Copy code";
    b.innerHTML = '<span class="glyph">&#xE8C8;</span>';
    pre.append(b);
  }
}

// Images change preview height after load, which shifts every scroll anchor.
preview.addEventListener("load", () => (pairs = null), true);

// ---------------------------------------------------------------------------
// Scroll sync
//
// Each preview block carries data-sourcepos from comrak. We pair the editor's
// pixel offset for that source line with the block's offset in the preview,
// then interpolate linearly between pairs in either direction.

type Pair = [editorY: number, previewY: number];
let pairs: Pair[] | null = null;
let lastScrollSource: "editor" | "preview" = "editor";
const expected = { editor: -1, preview: -1 };

function buildPairs(): Pair[] {
  const es = view.scrollDOM;
  const eMax = Math.max(0, es.scrollHeight - es.clientHeight);
  const pMax = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  const pOrigin = previewPane.getBoundingClientRect().top - previewPane.scrollTop;
  const padTop = view.documentPadding.top;
  const lines = view.state.doc.lines;

  const out: Pair[] = [[0, 0]];
  let lastLine = 0;
  for (const el of preview.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
    const line = parseInt(el.dataset.sourcepos!, 10);
    if (!(line > lastLine) || line > lines) continue;
    const e = view.lineBlockAt(view.state.doc.line(line).from).top + padTop - 24;
    const p = el.getBoundingClientRect().top - pOrigin - 24;
    const [le, lp] = out[out.length - 1];
    if (e <= le || p <= lp) continue; // keep the mapping monotonic
    if (e >= eMax || p >= pMax) break;
    out.push([e, p]);
    lastLine = line;
  }
  out.push([eMax, pMax]);
  return out;
}

function mapScroll(y: number, from: 0 | 1): number {
  const P = (pairs ??= buildPairs());
  const to = from === 0 ? 1 : 0;
  let lo = 1;
  let hi = P.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (P[mid][from] < y) lo = mid + 1;
    else hi = mid;
  }
  const a = P[lo - 1];
  const b = P[lo];
  const span = b[from] - a[from];
  const t = span > 0 ? Math.min(1, Math.max(0, (y - a[from]) / span)) : 0;
  return a[to] + (b[to] - a[to]) * t;
}

function syncScroll(source: "editor" | "preview") {
  if (mode !== "split") return;
  if (source === "editor") {
    const y = Math.round(mapScroll(view.scrollDOM.scrollTop, 0));
    expected.preview = y;
    previewPane.scrollTop = y;
  } else {
    const y = Math.round(mapScroll(previewPane.scrollTop, 1));
    expected.editor = y;
    view.scrollDOM.scrollTop = y;
  }
}

function onScroll(source: "editor" | "preview", el: HTMLElement) {
  if (source === "editor") queueSavePosition();
  queueOutlineHighlight();
  // Ignore the scroll event caused by our own programmatic sync.
  if (Math.abs(el.scrollTop - expected[source]) <= 1) {
    expected[source] = -1;
    return;
  }
  lastScrollSource = source;
  syncScroll(source);
}

view.scrollDOM.addEventListener("scroll", () => onScroll("editor", view.scrollDOM), { passive: true });
previewPane.addEventListener("scroll", () => onScroll("preview", previewPane), { passive: true });
new ResizeObserver(() => (pairs = null)).observe(workspace);

// ---------------------------------------------------------------------------
// View modes & splitter

let mode: Mode = prefs.get<Mode>("mode", "split");

function setMode(next: Mode) {
  mode = next;
  workspace.dataset.mode = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
    b.classList.toggle("active", b.dataset.mode === next);
  }
  prefs.set("mode", next);
  pairs = null;
  if (next !== "edit" && previewStale) scheduleRender();
  if (next === "preview") previewPane.focus();
  else view.focus();
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}

function setSplit(ratio: number) {
  const r = Math.min(0.8, Math.max(0.2, ratio));
  workspace.style.setProperty("--split", `${r * 100}%`);
  return r;
}
let splitRatio = setSplit(prefs.get("split", 0.5));

splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  workspace.classList.add("resizing");
  const rect = workspace.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    splitRatio = setSplit((ev.clientX - rect.left) / rect.width);
  };
  const up = () => {
    splitter.removeEventListener("pointermove", move);
    workspace.classList.remove("resizing");
    prefs.set("split", splitRatio);
    pairs = null;
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up, { once: true });
});
splitter.addEventListener("dblclick", () => prefs.set("split", (splitRatio = setSplit(0.5))));

// ---------------------------------------------------------------------------
// Theme & zoom

function systemTheme(): Theme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let themePref = prefs.get<Theme | null>("theme", null);

function currentTheme(): Theme {
  return exporting ? "light" : (themePref ?? systemTheme());
}

function applyTheme() {
  const theme = currentTheme();
  document.documentElement.dataset.theme = theme;
  $("theme-glyph").innerHTML = theme === "dark" ? "&#xE706;" : "&#xE708;";
  void appWindow.setTheme(theme); // keeps the Mica tint in step with the app
  scheduleRender(); // diagrams are themed at render time
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themePref ?? applyTheme());

function toggleTheme() {
  themePref = (themePref ?? systemTheme()) === "dark" ? "light" : "dark";
  prefs.set("theme", themePref);
  applyTheme();
}

let zoom = prefs.get("zoom", 1);
function setZoom(z: number) {
  zoom = Math.round(Math.min(2, Math.max(0.6, z)) * 10) / 10;
  document.documentElement.style.setProperty("--zoom", String(zoom));
  prefs.set("zoom", zoom);
  pairs = null;
  view.requestMeasure();
}

// ---------------------------------------------------------------------------
// File operations

async function confirmDiscard(): Promise<boolean> {
  if (!doc.dirty) return true;
  return ask(`Discard unsaved changes to ${fileName(doc.path)}?`, {
    title: "Inkwell",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Cancel",
  });
}

async function openPath(path: string, opts: { quiet?: boolean; at?: At } = {}) {
  if (!(await confirmDiscard())) return false;
  try {
    setDocument(await invoke<string>("read_file", { path }), path, opts.at);
    return true;
  } catch (err) {
    sidebar.removeRecent(path);
    if (!opts.quiet) await message(String(err), { title: "Inkwell", kind: "error" });
    return false;
  }
}

async function openDialog() {
  const path = await open({
    multiple: false,
    directory: false,
    defaultPath: doc.path ? dirName(doc.path) : undefined,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof path === "string") await openPath(path);
}

async function saveDocument(saveAs = false): Promise<boolean> {
  let path = doc.path;
  if (saveAs || !path) {
    path = await save({
      defaultPath: doc.path ?? "Untitled.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!path) return false;
  }
  const text = view.state.doc.toString();
  try {
    await invoke("write_file", { path, contents: doc.crlf ? text.replace(/\n/g, "\r\n") : text });
  } catch (err) {
    await message(String(err), { title: "Inkwell", kind: "error" });
    return false;
  }
  const pathChanged = path !== doc.path;
  doc.path = path;
  doc.savedText = text;
  doc.dirty = false;
  updateTitle();
  search.refresh();
  if (pathChanged) {
    scheduleRender(); // relative image paths may now resolve
    void invoke("watch_file", { path });
    prefs.set("lastFile", path);
    sidebar.setActive(path);
  }
  return true;
}

async function newDocument() {
  if (await confirmDiscard()) setDocument("", null);
}

const sidebar = createSidebar({
  open: (path) => {
    if (!samePath(path, doc.path)) void openPath(path);
  },
  currentPath: () => doc.path,
  renamed: (from, to) => {
    if (!doc.path || !isInside(doc.path, from)) return;
    doc.path = to + doc.path.slice(from.length);
    prefs.set("lastFile", doc.path);
    void invoke("watch_file", { path: doc.path });
    updateTitle();
    scheduleRender(); // relative image paths
  },
  deleted: (path) => {
    if (!doc.path || !isInside(doc.path, path)) return;
    // Keep the text, but as an unsaved document: Ctrl+S asks where to put it.
    doc.path = null;
    doc.savedText = ORPHANED;
    doc.dirty = true;
    prefs.set("lastFile", null);
    void invoke("watch_file", { path: null });
    updateTitle();
  },
});

// ---------------------------------------------------------------------------
// Sidebar panels: files, outline, folder search

let tab = prefs.get<Tab>("sidebarTab", "files");

const outline = createOutline($("outline"), {
  state: () => view.state,
  topLine,
  reveal: (line) => void reveal({ line }),
});

const search = createSearch({
  root: () => sidebar.root(),
  openAt: (path, line, col, len) => {
    const at = { line, col, len };
    if (samePath(path, doc.path)) void reveal(at);
    else void openPath(path, { at });
  },
});

const outlineShown = () => tab === "outline" && sidebar.visible();

function showTab(next: Tab) {
  tab = next;
  prefs.set("sidebarTab", next);
  for (const b of document.querySelectorAll<HTMLElement>(".sb-tab")) {
    b.classList.toggle("active", b.dataset.tab === next);
    b.setAttribute("aria-selected", String(b.dataset.tab === next));
  }
  for (const p of document.querySelectorAll<HTMLElement>(".sb-panel")) p.hidden = p.dataset.panel !== next;
  if (outlineShown()) outline.render();
}

for (const b of document.querySelectorAll<HTMLElement>(".sb-tab")) {
  b.addEventListener("click", () => showTab(b.dataset.tab as Tab));
}

function toggleSidebar() {
  sidebar.toggle();
  if (outlineShown()) outline.render();
}

let outlineTimer = 0;
function queueOutline() {
  clearTimeout(outlineTimer);
  if (outlineShown()) outlineTimer = window.setTimeout(outline.render, 250);
}

let outlineFrame = 0;
function queueOutlineHighlight() {
  if (outlineFrame || !outlineShown()) return;
  outlineFrame = requestAnimationFrame(() => {
    outlineFrame = 0;
    outline.highlight();
  });
}

function showOutline() {
  sidebar.show();
  showTab("outline");
}

function searchFolder() {
  sidebar.show();
  showTab("search");
  const sel = view.state.selection.main;
  search.focus(view.hasFocus ? view.state.sliceDoc(sel.from, sel.to) : undefined);
}

// ---------------------------------------------------------------------------
// Quick open (Ctrl+P): fuzzy-find any markdown file in the folder

let fileCache: { root: string; files: string[] } | null = null;

function quickOpenItems(query: string, root: string | null, files: string[]): PaletteItem[] {
  const recent = sidebar.recent();
  const seen = new Set<string>(doc.path ? [doc.path.toLowerCase()] : []);
  const paths = [...recent, ...files].filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
  const scored: { score: number; item: PaletteItem }[] = [];
  paths.forEach((path, i) => {
    const name = fileName(path);
    const rel = root && isInside(path, root) ? relativePath(root, path) : path;
    const dir = rel.slice(0, Math.max(0, rel.length - name.length - 1));
    const item: PaletteItem = { label: name, detail: dir, run: () => openPath(path) };
    let score = -i; // no query: recent files first, then alphabetical
    if (query.trim()) {
      const byName = fuzzy(query, name);
      const byPath = byName ? null : fuzzy(query, rel);
      if (byName) {
        score = byName.score + 20;
        item.labelMarks = byName.indices;
      } else if (byPath) {
        const nameStart = rel.length - name.length;
        score = byPath.score;
        item.labelMarks = byPath.indices.filter((x) => x >= nameStart).map((x) => x - nameStart);
        item.detailMarks = byPath.indices.filter((x) => x < dir.length);
      } else return;
      if (i < recent.length) score += 3;
    }
    scored.push({ score, item });
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}

async function quickOpen() {
  const root = sidebar.root() ?? (doc.path ? dirName(doc.path) : null);
  let files = root && fileCache && samePath(fileCache.root, root) ? fileCache.files : [];
  const palette = openPalette({
    placeholder: root ? `Go to file in ${fileName(root)}` : "Go to a recent file",
    empty: "No matching files",
    items: (q) => quickOpenItems(q, root, files),
  });
  if (!root) return;
  const fresh = await invoke<string[]>("list_markdown", { root });
  fileCache = { root, files: fresh };
  if (fresh.join("\n") !== files.join("\n")) {
    files = fresh;
    palette.update();
  }
}

// ---------------------------------------------------------------------------
// Images: paste a screenshot into ./assets, or drop image files to link them

function insertText(text: string) {
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.paste" });
  view.focus();
}

function pasteImage(e: ClipboardEvent) {
  const file = pastedImage(e.clipboardData);
  if (!file) return false;
  e.preventDefault();
  if (!doc.path) {
    toast("Save the document first to paste images");
    return true;
  }
  saveImage(file, dirName(doc.path)).then((rel) => {
    const sel = view.state.selection.main;
    const alt = view.state.sliceDoc(sel.from, sel.to).replace(/[[\]\n]/g, "");
    insertText(`![${alt}](${linkTarget(rel)})`);
    toast(`Saved ${rel}`);
  }, reportError);
  return true;
}

function linkImages(paths: string[]) {
  if (!doc.path) return toast("Save the document first to link images");
  const base = dirName(doc.path);
  insertText(paths.map((p) => `![${altText(p)}](${linkTarget(relativePath(base, p))})`).join("\n"));
}

// ---------------------------------------------------------------------------
// Export & rich copy

function withExtension(path: string | null, ext: string) {
  return (path ?? "Untitled.md").replace(/\.[^.\\/]*$/, "") + `.${ext}`;
}

/** Render the preview with export styling, even if it's currently hidden. */
async function prepareExport() {
  exporting = true;
  await render(true);
  await Promise.all([...preview.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  await document.fonts.ready;
}

function finishExport() {
  exporting = false;
  scheduleRender();
}

async function exportPdf() {
  const path = await save({ defaultPath: withExtension(doc.path, "pdf"), filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!path) return;
  try {
    await prepareExport();
    await invoke("export_pdf", { path });
    toast(`Exported ${fileName(path)}`);
  } catch (err) {
    reportError(err);
  } finally {
    finishExport();
  }
}

async function exportHtml() {
  const path = await save({ defaultPath: withExtension(doc.path, "html"), filters: [{ name: "HTML", extensions: ["html"] }] });
  if (!path) return;
  try {
    await prepareExport();
    const html = await standaloneHtml(preview, fileName(doc.path).replace(/\.[^.]+$/, ""));
    await invoke("write_file", { path, contents: html });
    toast(`Exported ${fileName(path)}`);
  } catch (err) {
    reportError(err);
  } finally {
    finishExport();
  }
}

async function ensurePreview() {
  if (previewStale || mode === "edit") await render(true);
}

async function copyDocumentRich() {
  try {
    await ensurePreview();
    await copyRich(await previewHtml(preview), preview.innerText);
    toast("Copied as rich text");
  } catch (err) {
    reportError(err);
  }
}

async function copyDocumentHtml() {
  await ensurePreview();
  copy(await previewHtml(preview), "HTML");
}

// ---------------------------------------------------------------------------
// Menus

function documentItems(): MenuItem[] {
  return doc.path ? pathItems(doc.path, { dir: false, root: sidebar.root(), doc: null }) : [];
}

function previewMenu(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const sel = selectionIn(preview);
  const link = target.closest("a[href]")?.getAttribute("href");
  const img = target.closest("img")?.getAttribute("src");
  const code = target.closest("pre")?.querySelector("code")?.textContent;
  const heading = target.closest("h1, h2, h3, h4, h5, h6");
  const anchor = heading?.querySelector("a.anchor")?.id;

  const items: MenuItem[] = [];
  if (sel) {
    items.push(
      { label: "Copy", shortcut: "Ctrl+C", action: () => copy(sel.text, "selection") },
      { label: "Copy as rich text", action: () => copyRich(sel.html, sel.text).then(() => toast("Copied as rich text"), reportError) },
      { label: "Copy as HTML", action: () => copy(sel.html, "HTML") },
      "-",
    );
  }
  if (link && !link.startsWith("#")) items.push({ label: "Copy link address", action: () => copy(link, "link") });
  if (img) items.push({ label: "Copy image address", action: () => copy(img.startsWith("data:") ? img : decodeURI(img), "image address") });
  if (code !== undefined && code !== null) items.push({ label: "Copy code", action: () => copy(code, "code") });
  if (heading && anchor) {
    const text = heading.textContent?.trim() ?? anchor;
    items.push({ label: "Copy link to heading", action: () => copy(`[${text}](#${anchor})`, "heading link") });
  }
  items.push(
    "-",
    { label: "Copy document as Markdown", action: () => copy(view.state.doc.toString(), "Markdown") },
    { label: "Copy document as rich text", action: copyDocumentRich },
    { label: "Copy document as HTML", action: copyDocumentHtml },
    "-",
    { label: "Export as PDF…", shortcut: "Ctrl+Shift+E", action: exportPdf },
    { label: "Export as HTML…", action: exportHtml },
  );
  if (doc.path) items.push("-", ...documentItems());
  showMenu(items, e.clientX, e.clientY);
}

preview.parentElement!.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  previewMenu(e);
});

$("doc-title").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showMenu(
    doc.path ? documentItems() : [{ label: "Save as…", shortcut: "Ctrl+Shift+S", action: () => saveDocument(true) }],
    e.clientX,
    e.clientY,
  );
});

function moreMenu(): MenuItem[] {
  return [
    { label: "New document", shortcut: "Ctrl+N", action: newDocument },
    { label: "New file in folder", shortcut: "Ctrl+Alt+N", action: newFileInFolder },
    { label: "Open file…", shortcut: "Ctrl+O", action: openDialog },
    { label: "Open folder…", action: () => $("btn-open-folder").click() },
    "-",
    { label: "Go to file…", shortcut: "Ctrl+P", action: quickOpen },
    { label: "Search in folder", shortcut: "Ctrl+Shift+F", action: searchFolder },
    { label: "Outline", shortcut: "Ctrl+Shift+O", action: showOutline },
    "-",
    { label: "Save", shortcut: "Ctrl+S", action: () => saveDocument() },
    { label: "Save as…", shortcut: "Ctrl+Shift+S", action: () => saveDocument(true) },
    "-",
    { label: "Export as PDF…", shortcut: "Ctrl+Shift+E", action: exportPdf },
    { label: "Export as HTML…", action: exportHtml },
    { label: "Copy as rich text", action: copyDocumentRich },
    "-",
    ...(doc.path
      ? [
          { label: "Reveal in File Explorer", action: () => run("reveal_path", { path: doc.path }) },
          ...editorItems(doc.path),
          "-" as const,
        ]
      : []),
    { label: "Toggle sidebar", shortcut: "Ctrl+\\", action: toggleSidebar },
    { label: "Toggle theme", shortcut: "Ctrl+Shift+L", action: toggleTheme },
  ];
}

function newFileInFolder() {
  if (!sidebar.newFileHere()) void newDocument();
}

$("btn-more").addEventListener("click", (e) => showMenuAt(moreMenu(), e.currentTarget as HTMLElement));

// The browser's own menu (Back, Refresh, Print…) means nothing here. The
// editor and text inputs keep theirs for cut/copy/paste.
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest(".cm-editor, input, textarea")) e.preventDefault();
});

$("btn-sidebar").addEventListener("click", toggleSidebar);
$("btn-open").addEventListener("click", () => void openDialog());
$("btn-save").addEventListener("click", () => void saveDocument());
$("btn-theme").addEventListener("click", toggleTheme);

// ---------------------------------------------------------------------------
// Preview clicks: code copy buttons and links

preview.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest<HTMLButtonElement>(".code-copy");
  if (copyBtn) {
    const code = copyBtn.parentElement?.querySelector("code")?.textContent ?? "";
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.classList.add("done");
      copyBtn.innerHTML = '<span class="glyph">&#xE73E;</span>';
      setTimeout(() => {
        copyBtn.classList.remove("done");
        copyBtn.innerHTML = '<span class="glyph">&#xE8C8;</span>';
      }, 1200);
    }, reportError);
    return;
  }

  const a = target.closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  if (href.startsWith("#")) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: "start" });
  } else if (/^(https?:|mailto:)/i.test(href)) {
    void openUrl(href);
  } else if (doc.path && /\.(md|markdown|mdown|mkd)(#.*)?$/i.test(href)) {
    const rel = decodeURI(href.replace(/#.*$/, "")).replace(/\//g, "\\");
    void openPath(/^[a-z]:\\/i.test(rel) ? rel : `${dirName(doc.path)}\\${rel.replace(/^\.\\/, "")}`);
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts

window.addEventListener(
  "keydown",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const handle = (fn: () => unknown) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (e.altKey) {
      if (k === "n") handle(newFileInFolder);
      return;
    }
    // In the editor, Ctrl+B is bold (see format.ts); elsewhere it toggles the sidebar.
    const inEditor = !!(e.target as HTMLElement | null)?.closest?.(".cm-editor");
    if (k === "o" && e.shiftKey) handle(showOutline);
    else if (k === "f" && e.shiftKey) handle(searchFolder);
    else if (k === "p" && !e.shiftKey) handle(quickOpen);
    else if (k === "o") handle(openDialog);
    else if (k === "s") handle(() => saveDocument(e.shiftKey));
    else if (k === "n") handle(newDocument);
    else if (k === "\\" || (k === "b" && !e.shiftKey && !inEditor)) handle(toggleSidebar);
    else if (k === "e" && e.shiftKey) handle(exportPdf);
    else if (k === "1") handle(() => setMode("edit"));
    else if (k === "2") handle(() => setMode("split"));
    else if (k === "3") handle(() => setMode("preview"));
    else if (k === "l" && e.shiftKey) handle(toggleTheme);
    else if (k === "=" || k === "+") handle(() => setZoom(zoom + 0.1));
    else if (k === "-") handle(() => setZoom(zoom - 0.1));
    else if (k === "0") handle(() => setZoom(1));
  },
  true,
);

// ---------------------------------------------------------------------------
// Window chrome

$("win-min").addEventListener("click", () => void appWindow.minimize());
$("win-max").addEventListener("click", () => void appWindow.toggleMaximize());
$("win-close").addEventListener("click", () => void appWindow.close());

async function refreshMaxGlyph() {
  const max = await appWindow.isMaximized();
  $("max-glyph").innerHTML = max ? "&#xE923;" : "&#xE922;";
  document.documentElement.classList.toggle("maximized", max);
}
void appWindow.onResized(() => void refreshMaxGlyph());

void appWindow.onCloseRequested(async (e) => {
  savePosition();
  if (!(await confirmDiscard())) e.preventDefault();
});

void getCurrentWebview().onDragDropEvent((e) => {
  if (e.payload.type === "over") workspace.classList.add("drop-target");
  else workspace.classList.remove("drop-target");
  if (e.payload.type !== "drop" || e.payload.paths.length === 0) return;
  const images = e.payload.paths.filter((p) => IMAGE_FILE.test(p));
  if (images.length === e.payload.paths.length) linkImages(images);
  else void openPath(e.payload.paths.find((p) => !IMAGE_FILE.test(p))!);
});

// A second launch (double-clicking another file) forwards its file here.
void listen<string>("open-file", (e) => {
  if (!samePath(e.payload, doc.path)) void openPath(e.payload);
});

// ---------------------------------------------------------------------------
// Startup

applyTheme();
setZoom(zoom);
setMode(mode);
showTab(tab);
void refreshMaxGlyph();
void loadEditors();

const initial = await invoke<string | null>("initial_file");
const lastFile = prefs.get<string | null>("lastFile", null);
if (initial) await openPath(initial);
else if (!(lastFile && (await openPath(lastFile, { quiet: true })))) setDocument(WELCOME, null);
view.focus();
