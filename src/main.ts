import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save, ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Compartment, EditorState } from "@codemirror/state";
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

import { editorTheme, markdownHighlight } from "./editor-theme";
import { prefs, fileName, dirName, samePath, isInside, relativePath } from "./prefs";
import { createSidebar } from "./sidebar";
import { createTabStrip } from "./tabs";
import { openSettings } from "./ai";
import { createAiEdit } from "./aiedit";
import { createAsk } from "./ask";
import { createDesign } from "./design";
import { createOutline } from "./outline";
import { createSearch } from "./search";
import { fuzzy, openPalette, type PaletteItem } from "./palette";
import { formatKeymap } from "./format";
import { pasteLink, richPaste } from "./paste";
import { tableKeymap } from "./table";
import { IMAGE_FILE, altText, linkTarget, pastedImage, saveImage } from "./images";
import { enhance, RICH_LANGUAGES, within } from "./rich";
import { patchBlocks, settle } from "./patch";
import { showMenu, showMenuAt, type MenuItem } from "./menu";
import { copy, editorItems, loadEditors, pathItems, reportError, run, toast } from "./actions";
import { copyRich, previewHtml, selectionIn, standaloneHtml } from "./export";
import { WELCOME } from "./welcome";
import { kindOf, logExtensions, type Kind } from "./plaintext";
import { startUpdates } from "./updater";

type Mode = "edit" | "split" | "preview";
type Theme = "light" | "dark";
type Panel = "files" | "outline" | "search" | "ask";
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
// Documents: one per tab
//
// There is a single editor view. The active document's state lives in it;
// background documents keep their EditorState (text, undo history, cursor),
// so switching tabs is a state swap. Restored tabs have no state until they
// are first shown, so a long session costs nothing at startup.

type Doc = {
  id: number;
  path: string | null;
  /** Null until first shown. Stale for the active document: the view holds its state. */
  state: EditorState | null;
  savedText: string;
  dirty: boolean;
  crlf: boolean;
  /** Markdown gets the preview; plain text and logs are editor-only. */
  kind: Kind;
  /** The file wasn't UTF-8, so saving would change its bytes: view only. */
  readOnly: boolean;
  /** Temporary tab: the next file opened with a single click replaces it. */
  preview: boolean;
  scroll: { editor: number; preview: number } | null;
  /** Names this document's unsaved edits in the hot-exit store; kept across restarts. */
  key: string;
  /** Unsaved text from the last run, put into the editor when the document is first shown. */
  backup: string | null;
};

let docs: Doc[] = [];
/** Most recently used first, for Ctrl+Tab and for choosing the tab to show after a close. */
let mru: Doc[] = [];
let nextDocId = 1;
/** Paths of closed tabs, most recent last, for Ctrl+Shift+T. */
const closedPaths: string[] = [];

/** Never equal to real text, so a document whose file was deleted stays dirty. */
const ORPHANED = "\u0000orphaned";

function makeDoc(path: string | null, preview = false): Doc {
  const kind = kindOf(path);
  return {
    id: nextDocId++,
    path,
    state: null,
    savedText: "",
    dirty: false,
    crlf: false,
    kind,
    readOnly: false,
    preview,
    scroll: null,
    key: crypto.randomUUID(),
    backup: null,
  };
}

/** Placeholder until the first real document is shown; never in `docs`. */
let doc: Doc = makeDoc(null);

/** A file's text as read_file returns it; `exact` is false if it wasn't UTF-8. */
type FileText = { text: string; exact: boolean };
const readFile = (path: string) => invoke<FileText>("read_file", { path });

function loadText(d: Doc, file: FileText) {
  const { text } = file;
  d.crlf = text.includes("\r\n");
  d.savedText = d.crlf ? text.replace(/\r\n/g, "\n") : text;
  d.dirty = false;
  d.readOnly = !file.exact;
  // A fresh state also starts a fresh undo history.
  d.state = EditorState.create({ doc: d.savedText, extensions: editorExtensions(d) });
}

/** Put last run's unsaved text into a just-loaded document, as an edit Ctrl+Z can undo. */
function applyBackup(d: Doc) {
  if (d.backup === null || !d.state) return;
  d.state = d.state.update({ changes: { from: 0, to: d.state.doc.length, insert: d.backup } }).state;
  d.dirty = d.backup !== d.savedText;
  d.backup = null;
}

const isPlain = (d: Doc) => d.kind !== "markdown";

/** Apply a change of kind or read-only status to a document's editor, keeping its text and undo history. */
function reconfigure(d: Doc) {
  const effects = kindConf.reconfigure(kindExtensions(d));
  if (d === doc) view.dispatch({ effects });
  else if (d.state) d.state = d.state.update({ effects }).state;
}

/** A document's current state, whether it's showing or in the background. */
function stateOf(d: Doc): EditorState | null {
  return d === doc ? view.state : d.state;
}

function updateTitle() {
  const name = fileName(doc.path);
  $("doc-title").textContent = name;
  $("dirty-dot").classList.toggle("on", doc.dirty);
  $("st-path").textContent = doc.path ?? "Not saved";
  $("st-eol").textContent = [doc.kind === "log" ? "Log" : doc.kind === "text" ? "Plain text" : "", doc.crlf ? "CRLF" : "LF", doc.readOnly ? "Read-only (not UTF-8)" : ""]
    .filter(Boolean)
    .join("  ·  ");
  void appWindow.setTitle(`${doc.dirty ? "• " : ""}${name} — Inkwell`);
}

function refreshDirty(text: string) {
  const dirty = text.length !== doc.savedText.length || text !== doc.savedText;
  if (dirty !== doc.dirty) {
    doc.dirty = dirty;
    if (dirty) doc.preview = false; // editing keeps a preview tab
    updateTitle();
    renderTabs();
    saveSession();
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

/** What differs between markdown, plain text and logs; swapped in place when Save As changes the kind. */
const kindConf = new Compartment();

function kindExtensions(d: Doc) {
  const readOnly = d.readOnly ? [EditorState.readOnly.of(true)] : [];
  if (d.kind === "log") return [...logExtensions, readOnly];
  if (d.kind === "text") return [EditorView.lineWrapping, readOnly];
  return [
    EditorView.lineWrapping,
    // Includes the markdown keymap: Enter continues lists, tasks and quotes;
    // Backspace removes an empty list marker.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlight),
    indentOnInput(),
    closeBrackets(),
    keymap.of([...tableKeymap, ...formatKeymap, ...closeBracketsKeymap]),
    readOnly,
  ];
}

function editorExtensions(d: Doc) {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    placeholder("Start writing…"),
    kindConf.of(kindExtensions(d)),
    editorTheme,
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.domEventHandlers({ paste: onPaste }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        scheduleRender();
        queueOutline();
        queueKeepUnsaved();
      }
      if (u.selectionSet || u.docChanged) updateCursorStatus();
      if (u.selectionSet) queueSavePosition();
    }),
  ];
}

const view = new EditorView({
  parent: editorPane,
  state: EditorState.create({ doc: "", extensions: editorExtensions(doc) }),
});

/** Preview scroll to restore once the incoming tab's preview has rendered. */
let pendingPreviewScroll: number | null = null;

/**
 * Show a document. Loads it first if it has never been shown; a file that
 * can no longer be read closes its tab. `at` jumps to a place instead of
 * restoring where the document was left.
 */
let activateSeq = 0;

async function activate(d: Doc, at?: At): Promise<boolean> {
  const seq = ++activateSeq;
  if (!d.state) {
    if (!d.path) {
      const baseline = d.savedText; // a deleted file's document stays dirty, even if emptied
      loadText(d, { text: "", exact: true });
      d.savedText = baseline;
    } else {
      let file: FileText | null = null;
      try {
        file = await readFile(d.path);
      } catch {
        if (!d.state && d.backup === null) {
          if (docs.includes(d)) {
            toast(`Couldn't open ${fileName(d.path)}`);
            sidebar.removeRecent(d.path);
            removeDoc(d);
          }
          return false;
        }
      }
      // Another activation of this document may have finished first; its state has the edits.
      if (!d.state && file) loadText(d, file);
      else if (!d.state) {
        // Gone, but its unsaved edits survive: keep them, and Ctrl+S puts the file back.
        loadText(d, { text: "", exact: true });
        d.savedText = ORPHANED;
      }
    }
    applyBackup(d);
  }
  if (!docs.includes(d)) return false; // closed while loading
  if (seq !== activateSeq) return false; // another tab was chosen while this one loaded
  if (d === doc) {
    if (at) void reveal(at);
    return true;
  }

  // Park the outgoing document.
  savePosition();
  doc.state = view.state;
  doc.scroll = { editor: view.scrollDOM.scrollTop, preview: previewPane.scrollTop };

  aiEdit.close(); // a pending suggestion belongs to the outgoing document
  doc = d;
  if (!cycle) touchMru(d);
  view.setState(d.state!);
  applyLayout();
  view.scrollDOM.scrollTop = 0;
  previewPane.scrollTop = 0;
  pendingPreviewScroll = null;
  if (at) void reveal(at);
  else if (d.scroll) {
    const { editor, preview: previewTop } = d.scroll;
    lastScrollSource = shownMode() === "preview" ? "preview" : "editor";
    pendingPreviewScroll = previewTop;
    requestAnimationFrame(() => (view.scrollDOM.scrollTop = editor));
  } else if (d.path) restorePosition(d.path);

  updateTitle();
  updateCursorStatus();
  scheduleRender();
  queueOutline();
  sidebar.setActive(d.path);
  documentsChanged();
  return true;
}

function touchMru(d: Doc) {
  mru = [d, ...mru.filter((x) => x !== d)];
}

/** Tab strip, file watcher and saved session all follow the set of open documents. */
function documentsChanged() {
  renderTabs();
  void invoke("watch_files", { paths: docs.filter((d) => d.path && d.state).map((d) => d.path) });
  saveSession();
}

// ---------------------------------------------------------------------------
// Session and hot exit: open tabs, and their unsaved edits, survive quitting,
// crashes and update restarts. Tabs are saved in preferences; unsaved text,
// which can be large, goes to a file through the Rust side, keyed by `Doc.key`.

/** A saved document is its path; one with unsaved edits also names its kept text. */
type SessionTab = string | { path: string | null; key: string };
/** `active` is a tab index (older versions saved the active path). */
type Session = { tabs: SessionTab[]; active: number | string | null };

function saveSession() {
  const kept = docs.filter((d) => d.path || d.dirty);
  const tabs: SessionTab[] = kept.map((d) => (d.dirty ? { path: d.path, key: d.key } : d.path!));
  const active = kept.indexOf(doc);
  prefs.set("session", { tabs, active: active >= 0 ? active : null } satisfies Session);
  queueKeepUnsaved();
}

let keepTimer = 0;
let keptNothing = false;
/** The latest write. Writes run one at a time, so an older snapshot can't land last. */
let keeping: Promise<void> = Promise.resolve();

function queueKeepUnsaved() {
  clearTimeout(keepTimer);
  keepTimer = window.setTimeout(() => void keepUnsaved().catch(() => {}), 800);
}

/** Write every unsaved document's text to the hot-exit store, after any write in progress. */
function keepUnsaved() {
  clearTimeout(keepTimer);
  return (keeping = keeping.catch(() => {}).then(writeUnsaved));
}

async function writeUnsaved() {
  const unsaved: Record<string, string> = {};
  for (const d of docs) {
    if (!d.dirty) continue;
    const text = stateOf(d)?.doc.toString() ?? d.backup;
    if (text !== null) unsaved[d.key] = text;
  }
  const empty = Object.keys(unsaved).length === 0;
  if (empty && keptNothing) return;
  await invoke("write_unsaved", { contents: JSON.stringify(unsaved) });
  keptNothing = empty;
}

/** Add a document after the active tab, or in place of `replace`. */
function insertDoc(d: Doc, replace: Doc | null) {
  const i = replace ? docs.indexOf(replace) : -1;
  if (i >= 0) {
    docs[i] = d;
    mru = mru.filter((x) => x !== replace);
  } else {
    docs.splice(docs.indexOf(doc) + 1, 0, d);
  }
}

/** Drop a document without asking, showing another if it was active. */
function removeDoc(d: Doc) {
  const i = docs.indexOf(d);
  if (i < 0) return;
  docs.splice(i, 1);
  mru = mru.filter((x) => x !== d);
  if (d.path) {
    closedPaths.push(d.path);
    if (closedPaths.length > 30) closedPaths.shift();
  }
  if (docs.length === 0) docs.push(makeDoc(null));
  if (d === doc) void activate(mru[0] ?? docs[Math.min(i, docs.length - 1)]);
  else documentsChanged();
}

/** An untitled, unedited document (like the welcome page) has nothing to lose. */
const disposable = (d: Doc) => !d.path && !d.dirty;

/** Select a place in the document and scroll it to the top of the editor (or preview). */
async function reveal(at: At) {
  const d = view.state.doc;
  const line = d.line(Math.min(Math.max(1, at.line), d.lines));
  const from = Math.min(line.from + (at.col ?? 0), line.to);
  const to = Math.min(from + (at.len ?? 0), line.to);
  lastScrollSource = "editor";
  view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 48 }) });
  if (shownMode() !== "preview") return view.focus();
  if (previewStale) await render();
  scrollPreviewTo(line.number);
}

/** Scroll the preview to the block rendered from source line `line`. */
function scrollPreviewTo(line: number) {
  const B = getBlocks();
  const target = B[lastAtOrBelow(B.length, (i) => B[i].line, line)]?.el;
  const offset = target ? target.getBoundingClientRect().top - previewPane.getBoundingClientRect().top - 16 : -Infinity;
  previewPane.scrollTop = Math.max(0, previewPane.scrollTop + offset);
}

/** The source line at the top of whichever pane the reader is looking at. */
function topLine(): number {
  if (shownMode() === "preview") {
    // Binary search, so only a handful of blocks are measured per scroll frame.
    const top = previewPane.getBoundingClientRect().top + 24;
    const B = getBlocks();
    return B[lastAtOrBelow(B.length, (i) => B[i].el.getBoundingClientRect().top, top)]?.line ?? 1;
  }
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentPadding.top + 24);
  return view.state.doc.lineAt(block.from).number;
}

/** Whether the end of the document is on screen, so a growing log should keep following it. */
function endInView() {
  const last = view.lineBlockAt(view.state.doc.length);
  return last.bottom + view.documentPadding.top <= view.scrollDOM.scrollTop + view.scrollDOM.clientHeight + 4;
}

/**
 * Bring in an external edit as a minimal change, so scroll position, cursor
 * and undo history survive. Works for background tabs too. A log scrolled to
 * its end keeps following new lines, like tail -f.
 */
function applyExternalText(d: Doc, file: FileText) {
  const state = stateOf(d);
  if (!state) return;
  const { text } = file;
  const follow = d === doc && d.kind === "log" && endInView();
  d.crlf = text.includes("\r\n");
  const next = d.crlf ? text.replace(/\r\n/g, "\n") : text;
  const cur = state.doc.toString();
  let start = 0;
  const max = Math.min(cur.length, next.length);
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--;
    endNext--;
  }
  d.savedText = next;
  if (d.dirty) {
    d.dirty = false;
    saveSession();
  }
  if (start !== endCur || start !== endNext) {
    const changes = { from: start, to: endCur, insert: next.slice(start, endNext) };
    if (d === doc) view.dispatch({ changes });
    else d.state = state.update({ changes }).state;
  }
  if (d.readOnly !== !file.exact) {
    d.readOnly = !file.exact;
    reconfigure(d);
  }
  if (follow) view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }) });
  if (d === doc) updateTitle();
  renderTabs();
}

const externalPrompts = new Set<number>();
void listen<string>("file-changed", async (e) => {
  const d = docs.find((x) => samePath(x.path, e.payload));
  if (!d || !d.state || externalPrompts.has(d.id)) return;
  const path = d.path!;
  if (d.dirty) {
    externalPrompts.add(d.id);
    const reload = await ask(`${fileName(path)} changed on disk. Reload it and lose your unsaved changes?`, {
      title: "Inkwell",
      kind: "warning",
      okLabel: "Reload",
      cancelLabel: "Keep mine",
    });
    externalPrompts.delete(d.id);
    if (!reload) return;
  }
  try {
    const file = await readFile(path);
    if (docs.includes(d) && samePath(path, d.path)) applyExternalText(d, file);
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
/** How long the last render took, so big documents render less often while typing. */
let lastRenderMs = 0;
/** What the preview's blocks were rendered for; a change means rebuilding them all. */
let renderedFor = "";

function scheduleRender() {
  previewStale = true;
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    renderQueued = false;
    void render();
  };
  // Small documents render every frame; slow ones let keystrokes batch up.
  if (lastRenderMs > 30) setTimeout(run, Math.min(400, lastRenderMs * 2));
  else requestAnimationFrame(run);
}

/** Render the preview. `force` renders even when the preview is hidden (for export). */
async function render(force = false) {
  const text = view.state.doc.toString();
  refreshDirty(text);
  const words = text.match(/\S+/g)?.length ?? 0;
  $("st-words").textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;

  if ((shownMode() === "edit" || isPlain(doc)) && !force) return; // rendered lazily when the preview is shown
  const started = performance.now();
  const seq = ++renderSeq;
  const isCurrent = () => seq === renderSeq;
  const html = await invoke<string>("render_markdown", { source: text });
  if (!isCurrent()) return; // a newer render superseded this one

  // Diagrams are themed and images resolved per document: rebuild on a change.
  const target = `${currentTheme()}|${doc.id}|${doc.path}`;
  if (target !== renderedFor) {
    preview.replaceChildren();
    renderedFor = target;
  }
  const { start, inserted, keys } = patchBlocks(preview, html);
  previewStale = false;
  blocks = null;
  resolveImages(inserted);
  await highlightCode(inserted);
  if (!isCurrent()) return;
  await enhance(inserted, currentTheme(), isCurrent);
  if (!isCurrent()) return;
  addCopyButtons(inserted);
  // Enhancing may have swapped a block for a new element (a diagram), so
  // settle whatever now sits at each inserted position.
  for (let i = 0; i < keys.length; i++) {
    const el = preview.children[start + i];
    if (el) settle(el, keys[i]);
  }
  lastRenderMs = performance.now() - started;
  if (pendingPreviewScroll !== null && shownMode() === "preview") previewPane.scrollTop = pendingPreviewScroll;
  pendingPreviewScroll = null;
  if (shownMode() === "split" && lastScrollSource === "editor") syncScroll("editor");
}

function resolveImages(roots: HTMLElement[]) {
  if (!doc.path) return;
  const base = dirName(doc.path);
  for (const img of within<HTMLImageElement>(roots, "img[src]")) {
    const src = img.getAttribute("src")!;
    if (/^(https?:|data:|asset:)/i.test(src)) continue;
    const abs = /^([a-z]:[\\/]|[\\/]{2})/i.test(src) ? src : `${base}\\${src.replace(/^\.?[\\/]/, "")}`;
    img.src = convertFileSrc(decodeURI(abs).replace(/\//g, "\\"));
  }
}

const highlightCache = new Map<string, string>();
type Hljs = typeof import("highlight.js/lib/common").default;
let hljsLoad: Promise<Hljs> | null = null;

/** Syntax-highlight code blocks. highlight.js loads on first use, not at startup. */
async function highlightCode(roots: HTMLElement[]) {
  const codes = within(roots, "pre > code").flatMap((code) => {
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
    return lang && !RICH_LANGUAGES.has(lang) ? [{ code, lang }] : [];
  });
  if (codes.length === 0) return;
  const hljs = await (hljsLoad ??= import("highlight.js/lib/common").then((m) => m.default));
  for (const { code, lang } of codes) {
    if (!hljs.getLanguage(lang)) continue;
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

function addCopyButtons(roots: HTMLElement[]) {
  for (const pre of within(roots, "pre")) {
    if (!pre.isConnected || !pre.querySelector(":scope > code")) continue;
    const b = document.createElement("button");
    b.className = "code-copy";
    b.title = "Copy code";
    b.innerHTML = '<span class="glyph">&#xE8C8;</span>';
    pre.append(b);
  }
}

// ---------------------------------------------------------------------------
// Scroll sync
//
// Each preview block carries data-sourcepos from comrak. To map a scroll
// position, find the two blocks on either side of it (binary search) and
// interpolate between their offsets in the editor and the preview. Only
// those few blocks are measured, so a render never triggers a pass over the
// whole preview.

type Block = { el: HTMLElement; line: number };
/** Preview blocks with increasing source lines; rebuilt (cheaply) after each render. */
let blocks: Block[] | null = null;
let lastScrollSource: "editor" | "preview" = "editor";
const expected = { editor: -1, preview: -1 };
/** Keep the block a little below the top edge rather than flush against it. */
const SYNC_MARGIN = 24;

function getBlocks(): Block[] {
  if (blocks) return blocks;
  const out: Block[] = [];
  const lines = view.state.doc.lines;
  let last = 0;
  for (const el of preview.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
    const line = parseInt(el.dataset.sourcepos!, 10);
    if (line > last && line <= lines) {
      out.push({ el, line });
      last = line;
    }
  }
  return (blocks = out);
}

/** Last index in [0, n) whose value is <= y (or -1), for values that rise with the index. */
function lastAtOrBelow(n: number, value: (i: number) => number, y: number) {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (value(mid) <= y) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function mapScroll(y: number, from: "editor" | "preview"): number {
  const B = getBlocks();
  const es = view.scrollDOM;
  const eMax = Math.max(0, es.scrollHeight - es.clientHeight);
  const pMax = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  const origin = previewPane.getBoundingClientRect().top - previewPane.scrollTop;
  const padTop = view.documentPadding.top;
  // A block that can't reach the top of either pane maps to the very end, so
  // both panes arrive at their bottoms together.
  const at = (i: number): [number, number] => {
    if (i < 0) return [0, 0];
    if (i >= B.length) return [eMax, pMax];
    const e = view.lineBlockAt(view.state.doc.line(B[i].line).from).top + padTop - SYNC_MARGIN;
    const p = B[i].el.getBoundingClientRect().top - origin - SYNC_MARGIN;
    return e >= eMax || p >= pMax ? [eMax, pMax] : [e, p];
  };
  const side = from === "editor" ? 0 : 1;
  const other = 1 - side;
  const i = lastAtOrBelow(B.length, (k) => at(k)[side], y);
  const a = at(i);
  const b = at(i + 1);
  const span = b[side] - a[side];
  const t = span > 0 ? Math.min(1, Math.max(0, (y - a[side]) / span)) : 0;
  const out = a[other] + (b[other] - a[other]) * t;
  return Math.min(Math.max(0, out), from === "editor" ? pMax : eMax);
}

function syncScroll(source: "editor" | "preview") {
  if (shownMode() !== "split") return;
  if (source === "editor") {
    const y = Math.round(mapScroll(view.scrollDOM.scrollTop, "editor"));
    expected.preview = y;
    previewPane.scrollTop = y;
  } else {
    const y = Math.round(mapScroll(previewPane.scrollTop, "preview"));
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

// ---------------------------------------------------------------------------
// View modes & splitter

let mode: Mode = prefs.get<Mode>("mode", "split");

/** The layout on screen: plain text and logs are always editor-only, whatever the chosen mode. */
function shownMode(): Mode {
  return isPlain(doc) ? "edit" : mode;
}

function applyLayout() {
  const shown = shownMode();
  workspace.dataset.mode = shown;
  const segmented = document.querySelector<HTMLElement>(".segmented")!;
  segmented.classList.toggle("disabled", isPlain(doc));
  segmented.title = isPlain(doc) ? "Plain text files have no preview" : "";
  for (const b of segmented.querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("active", b.dataset.mode === shown);
    b.disabled = isPlain(doc);
  }
}

function setMode(next: Mode) {
  mode = next;
  prefs.set("mode", next);
  applyLayout();
  if (shownMode() !== "edit" && previewStale) scheduleRender();
  if (shownMode() === "preview") previewPane.focus();
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
  view.requestMeasure();
}

// ---------------------------------------------------------------------------
// File operations

/**
 * Open a file in a tab, or switch to it if it's already open. `preview`
 * opens it in the temporary tab (for single clicks), replacing whatever the
 * temporary tab showed.
 */
async function openPath(path: string, opts: { quiet?: boolean; at?: At; preview?: boolean } = {}) {
  const existing = docs.find((d) => samePath(d.path, path));
  if (existing) {
    if (!opts.preview && existing.preview) {
      existing.preview = false;
      renderTabs();
    }
    return activate(existing, opts.at);
  }
  let file: FileText;
  try {
    file = await readFile(path);
  } catch (err) {
    sidebar.removeRecent(path);
    if (!opts.quiet) await message(String(err), { title: "Inkwell", kind: "error" });
    return false;
  }
  if (docs.some((d) => samePath(d.path, path))) return openPath(path, opts); // opened meanwhile
  const d = makeDoc(path, !!opts.preview);
  loadText(d, file);
  const replace = (opts.preview && docs.find((x) => x.preview && !x.dirty)) || (disposable(doc) && docs.includes(doc) ? doc : null);
  insertDoc(d, replace);
  return activate(d, opts.at);
}

/** Save/Don't save/Cancel for one document. True when it's fine to let it go. */
async function confirmClose(d: Doc): Promise<boolean> {
  if (!d.dirty) return true;
  if (d !== doc) await activate(d); // show what's being asked about
  const choice = await message(`Save changes to ${fileName(d.path)}?`, {
    title: "Inkwell",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't save", cancel: "Cancel" },
  });
  if (choice === "Save" || choice === "Yes") return saveDoc(d);
  return choice === "Don't save" || choice === "No";
}

async function closeDoc(d: Doc) {
  if (await confirmClose(d)) {
    if (d === doc) savePosition();
    removeDoc(d);
  }
}

/** Close several tabs, stopping if the user cancels one. */
async function closeDocs(list: Doc[]) {
  for (const d of list) {
    if (!docs.includes(d)) continue;
    if (!(await confirmClose(d))) return;
    removeDoc(d);
  }
}

async function reopenClosed() {
  while (closedPaths.length) {
    const path = closedPaths.pop()!;
    if (!docs.some((d) => samePath(d.path, path)) && (await openPath(path, { quiet: true }))) return;
  }
}

async function openDialog() {
  const path = await open({
    multiple: false,
    directory: false,
    defaultPath: doc.path ? dirName(doc.path) : undefined,
    filters: [
      { name: "Documents", extensions: ["md", "markdown", "mdown", "mkd", "txt", "log"] },
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
      { name: "Text and logs", extensions: ["txt", "log"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof path === "string") await openPath(path);
}

/** Save a document (asking where, if it's new or `saveAs`). False if cancelled or failed. */
async function saveDoc(d: Doc, saveAs = false): Promise<boolean> {
  if (!stateOf(d) && d.backup !== null && !(await activate(d))) return false; // edits restored from last run
  const state = stateOf(d);
  if (!state) return true; // never shown, so never edited
  if (d.readOnly) {
    toast(`${fileName(d.path)} isn't UTF-8, so it's open read-only`);
    return false;
  }
  let path = d.path;
  if (saveAs || !path) {
    if (d !== doc) await activate(d);
    const markdownFilter = { name: "Markdown", extensions: ["md", "markdown"] };
    const textFilter = { name: "Plain text", extensions: ["txt", "log"] };
    path = await save({
      defaultPath: d.path ?? "Untitled.md",
      filters: isPlain(d) ? [textFilter, markdownFilter] : [markdownFilter, textFilter],
    });
    if (!path) return false;
  }
  const text = (stateOf(d) ?? state).doc.toString();
  try {
    await invoke("write_file", { path, contents: d.crlf ? text.replace(/\n/g, "\r\n") : text });
  } catch (err) {
    await message(String(err), { title: "Inkwell", kind: "error" });
    return false;
  }
  const pathChanged = path !== d.path;
  d.path = path;
  if (kindOf(path) !== d.kind) {
    d.kind = kindOf(path);
    reconfigure(d);
    if (d === doc) applyLayout();
  }
  d.savedText = text;
  d.dirty = false;
  d.preview = false;
  if (d === doc) updateTitle();
  search.refresh();
  if (pathChanged) {
    // Saved over a file that's open in another tab: this tab now stands for it.
    const twin = docs.find((x) => x !== d && samePath(x.path, path));
    if (twin && !twin.dirty) removeDoc(twin);
    if (d === doc) {
      scheduleRender(); // relative image paths may now resolve
      sidebar.setActive(path);
    }
  }
  documentsChanged();
  return true;
}

const saveDocument = (saveAs = false) => saveDoc(doc, saveAs);

async function newDocument() {
  const d = makeDoc(null);
  insertDoc(d, null);
  await activate(d);
  view.focus();
}

const sidebar = createSidebar({
  open: (path, keep) => void openPath(path, { preview: !keep }),
  currentPath: () => doc.path,
  renamed: (from, to) => {
    let changed = false;
    for (const d of docs) {
      if (!d.path || !isInside(d.path, from)) continue;
      d.path = to + d.path.slice(from.length);
      changed = true;
    }
    if (!changed) return;
    updateTitle();
    scheduleRender(); // relative image paths
    documentsChanged();
  },
  deleted: (path) => {
    let changed = false;
    for (const d of [...docs]) {
      if (!d.path || !isInside(d.path, path)) continue;
      if (!d.state && d.backup === null) {
        removeDoc(d); // never shown, so there's nothing to keep
        continue;
      }
      // Keep the text, but as an unsaved document: Ctrl+S asks where to put it.
      d.path = null;
      d.savedText = ORPHANED;
      d.dirty = true;
      d.preview = false;
      changed = true;
    }
    if (!changed) return;
    updateTitle();
    documentsChanged();
  },
});

// ---------------------------------------------------------------------------
// Tab strip

const tabStrip = createTabStrip($("tabbar"), {
  activate: (id) => {
    const d = docs.find((x) => x.id === id);
    if (d) void activate(d);
  },
  close: (id) => {
    const d = docs.find((x) => x.id === id);
    if (d) void closeDoc(d);
  },
  keep: (id) => {
    const d = docs.find((x) => x.id === id);
    if (d?.preview) {
      d.preview = false;
      renderTabs();
    }
  },
  move: (id, to) => {
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    docs = docs.filter((x) => x !== d);
    docs.splice(to, 0, d);
    documentsChanged();
  },
  menu: (id, e) => {
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    const i = docs.indexOf(d);
    const items: MenuItem[] = [
      { label: "Close", shortcut: "Ctrl+W", action: () => closeDoc(d) },
      { label: "Close others", disabled: docs.length < 2, action: () => closeDocs(docs.filter((x) => x !== d)) },
      { label: "Close to the right", disabled: i === docs.length - 1, action: () => closeDocs(docs.slice(i + 1)) },
      { label: "Close saved", action: () => closeDocs(docs.filter((x) => !x.dirty)) },
      { label: "Close all", action: () => closeDocs([...docs]) },
    ];
    if (d.preview) {
      items.push("-", {
        label: "Keep open",
        action: () => {
          d.preview = false;
          renderTabs();
        },
      });
    }
    if (d.path) items.push("-", ...pathItems(d.path, { dir: false, root: sidebar.root(), doc: doc.path }));
    showMenu(items, e.clientX, e.clientY);
  },
});

function renderTabs() {
  const counts = new Map<string, number>();
  for (const d of docs) {
    const name = fileName(d.path).toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  tabStrip.render(
    docs.map((d) => ({
      id: d.id,
      name: fileName(d.path),
      hint: d.path && counts.get(fileName(d.path).toLowerCase())! > 1 ? fileName(dirName(d.path)) : "",
      title: d.path ?? "Not saved",
      dirty: d.dirty,
      preview: d.preview,
      active: d === doc,
    })),
  );
}

/** Ctrl+Tab walks the most-recently-used order while Ctrl is held, like Alt+Tab. */
let cycle: { order: Doc[]; i: number } | null = null;

function cycleTabs(back: boolean) {
  if (docs.length < 2) return;
  cycle ??= { order: [...mru], i: 0 };
  const n = cycle.order.length;
  cycle.i = (cycle.i + (back ? -1 : 1) + n) % n;
  void activate(cycle.order[cycle.i]);
}

window.addEventListener("keyup", (e) => {
  if (e.key === "Control" && cycle) {
    cycle = null;
    touchMru(doc);
  }
});
window.addEventListener("blur", () => {
  if (cycle) {
    cycle = null;
    touchMru(doc);
  }
});

function stepTab(delta: number) {
  const i = docs.indexOf(doc);
  if (docs.length > 1) void activate(docs[(i + delta + docs.length) % docs.length]);
}

// ---------------------------------------------------------------------------
// Sidebar panels: files, outline, folder search

let panel = prefs.get<Panel>("sidebarTab", "files");

const outline = createOutline($("outline"), {
  state: () => view.state,
  topLine,
  reveal: (line) => void reveal({ line }),
});

const search = createSearch({
  root: () => sidebar.root(),
  openAt: (path, line, col, len) => void openPath(path, { at: { line, col, len }, preview: true }),
});

const outlineShown = () => panel === "outline" && sidebar.visible();

function showPanel(next: Panel) {
  panel = next;
  prefs.set("sidebarTab", next);
  for (const b of document.querySelectorAll<HTMLElement>(".sb-tab")) {
    b.classList.toggle("active", b.dataset.tab === next);
    b.setAttribute("aria-selected", String(b.dataset.tab === next));
  }
  for (const p of document.querySelectorAll<HTMLElement>(".sb-panel")) p.hidden = p.dataset.panel !== next;
  // A conversation needs more room than a file list.
  $("body").classList.toggle("sidebar-wide", next === "ask");
  if (outlineShown()) outline.render();
}

for (const b of document.querySelectorAll<HTMLElement>(".sb-tab")) {
  b.addEventListener("click", () => showPanel(b.dataset.tab as Panel));
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
  showPanel("outline");
}

function searchFolder() {
  sidebar.show();
  showPanel("search");
  const sel = view.state.selection.main;
  search.focus(view.hasFocus ? view.state.sliceDoc(sel.from, sel.to) : undefined);
}

// ---------------------------------------------------------------------------
// Claude: Ctrl+J edits, the Ask panel and the page designer

const selectedText = () => {
  const sel = view.state.selection.main;
  return view.state.sliceDoc(sel.from, sel.to);
};

const askPanel = createAsk({
  docText: () => view.state.doc.toString(),
  docName: () => fileName(doc.path).replace(/"/g, "'"),
  selection: selectedText,
  insert: (text) => {
    view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.ai" });
    view.focus();
  },
});

function showAsk(question?: string) {
  sidebar.show();
  showPanel("ask");
  askPanel.focus(question);
}

const aiEdit = createAiEdit({
  view: () => view,
  docName: () => fileName(doc.path).replace(/"/g, "'"),
  ask: (question) => showAsk(question),
});

const design = createDesign({
  docText: () => view.state.doc.toString(),
  docPath: () => doc.path,
});

// ---------------------------------------------------------------------------
// Quick open (Ctrl+P): fuzzy-find any document in the folder

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
    const item: PaletteItem = { label: name, detail: dir, run: () => openPath(path, { preview: true }) };
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
  if (isPlain(doc)) return false;
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

/** Markdown paste: screenshots to ./assets, a URL over text as a link, rich text as markdown. */
function onPaste(e: ClipboardEvent) {
  const data = e.clipboardData;
  if (isPlain(doc) || !data) return false;
  if (pasteImage(e)) return true;
  if (pasteLink(view, data)) {
    e.preventDefault();
    return true;
  }
  const markdown = richPaste(view, data);
  if (!markdown) return false;
  e.preventDefault();
  const destination = doc;
  const { state } = view;
  markdown.then((text) => {
    if (doc !== destination || view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) {
      toast("Paste canceled because the document changed. Paste again.");
      return;
    }
    insertText(text);
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
  if (previewStale || shownMode() === "edit") await render(true);
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
    { label: "Edit selection with Claude", shortcut: "Ctrl+J", action: () => aiEdit.open() },
    { label: "Ask Claude about this document", shortcut: "Ctrl+Shift+J", action: () => showAsk() },
    { label: "Design a page with Claude…", action: () => design.open() },
    { label: "AI settings…", action: () => openSettings() },
    "-",
    { label: "Save", shortcut: "Ctrl+S", action: () => saveDocument() },
    { label: "Save as…", shortcut: "Ctrl+Shift+S", action: () => saveDocument(true) },
    "-",
    { label: "Close tab", shortcut: "Ctrl+W", action: () => closeDoc(doc) },
    { label: "Reopen closed tab", shortcut: "Ctrl+Shift+T", disabled: closedPaths.length === 0, action: reopenClosed },
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
    { label: "Check for updates", action: checkForUpdates },
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
  } else if (doc.path && /\.(md|markdown|mdown|mkd|txt|log)(#.*)?$/i.test(href)) {
    const rel = decodeURI(href.replace(/#.*$/, "")).replace(/\//g, "\\");
    void openPath(/^[a-z]:\\/i.test(rel) ? rel : `${dirName(doc.path)}\\${rel.replace(/^\.\\/, "")}`, { preview: true });
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts

window.addEventListener(
  "keydown",
  (e) => {
    const k = e.key.toLowerCase();
    const handle = (fn: () => unknown) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    // Alt+1…8 jump to a tab, Alt+9 to the last (Ctrl+1/2/3 are the view modes).
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      const d = n === 9 ? docs[docs.length - 1] : docs[n - 1];
      if (d) handle(() => activate(d));
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey) {
      if (k === "n") handle(newFileInFolder);
      return;
    }
    // In the editor, Ctrl+B is bold (see format.ts); elsewhere it toggles the sidebar.
    const inEditor = !!(e.target as HTMLElement | null)?.closest?.(".cm-editor");
    if (k === "tab") handle(() => cycleTabs(e.shiftKey));
    else if (k === "pagedown") handle(() => stepTab(1));
    else if (k === "pageup") handle(() => stepTab(-1));
    else if (k === "w" && !e.shiftKey) handle(() => closeDoc(doc));
    else if (k === "t" && e.shiftKey) handle(reopenClosed);
    else if (k === "j" && e.shiftKey) handle(() => showAsk());
    else if (k === "j") handle(() => aiEdit.open());
    else if (k === "o" && e.shiftKey) handle(showOutline);
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

/**
 * Before quitting: keep unsaved work for next time (hot exit), or if that
 * fails, offer to save it. False when the user cancels.
 */
async function readyToQuit(): Promise<boolean> {
  savePosition();
  refreshDirty(view.state.doc.toString()); // typing since the last render counts
  saveSession();
  try {
    await keepUnsaved();
    return true;
  } catch (err) {
    reportError(err);
  }
  const dirty = docs.filter((d) => d.dirty);
  if (dirty.length === 0) return true;
  const names = dirty.map((d) => `• ${fileName(d.path)}`).join("\n");
  const choice = await message(
    dirty.length === 1 ? `Save changes to ${fileName(dirty[0].path)}?` : `Save changes to ${dirty.length} files?\n\n${names}`,
    { title: "Inkwell", kind: "warning", buttons: { yes: dirty.length === 1 ? "Save" : "Save all", no: "Don't save", cancel: "Cancel" } },
  );
  if (choice === "Don't save" || choice === "No") return true;
  if (choice === "Cancel") return false;
  for (const d of dirty) {
    if (!(await saveDoc(d))) return false;
  }
  return true;
}

void appWindow.onCloseRequested(async (e) => {
  if (!(await readyToQuit())) e.preventDefault();
});

const checkForUpdates = startUpdates(readyToQuit);

void getCurrentWebview().onDragDropEvent((e) => {
  if (e.payload.type === "over") workspace.classList.add("drop-target");
  else workspace.classList.remove("drop-target");
  if (e.payload.type !== "drop" || e.payload.paths.length === 0) return;
  const images = e.payload.paths.filter((p) => IMAGE_FILE.test(p));
  if (images.length === e.payload.paths.length) linkImages(images);
  else for (const p of e.payload.paths.filter((p) => !IMAGE_FILE.test(p))) void openPath(p);
});

// A second launch (double-clicking another file) forwards its file here.
void listen<string>("open-file", (e) => void openPath(e.payload));

// ---------------------------------------------------------------------------
// Startup

applyTheme();
setZoom(zoom);
setMode(mode);
showPanel(panel);
void refreshMaxGlyph();
void loadEditors();

// Restore the last session's tabs, with their unsaved edits. They load when
// first shown, so only the active one is read now. (Older versions saved just
// the last file.)
const legacyFile = prefs.get<string | null>("lastFile", null);
const session = prefs.get<Session | null>("session", legacyFile ? { tabs: [legacyFile], active: legacyFile } : null);
let unsaved: Record<string, string> = {};
try {
  unsaved = JSON.parse((await invoke<string | null>("read_unsaved")) ?? "{}");
} catch {
  /* nothing kept */
}
const restored = (session?.tabs ?? []).map((t): Doc | null => {
  if (typeof t === "string") return makeDoc(t);
  const text = unsaved[t.key];
  if (text === undefined) return t.path ? makeDoc(t.path) : null; // kept text lost: fall back to the file
  const d = makeDoc(t.path);
  d.key = t.key;
  d.backup = text;
  d.dirty = true;
  return d;
});
const active = session?.active;
const preferred = typeof active === "number" ? restored[active] : restored.find((d) => d && samePath(d.path, active ?? null));
docs = restored.filter((d): d is Doc => d !== null);
mru = preferred ? [preferred, ...docs.filter((d) => d !== preferred)] : [...docs];

const initial = await invoke<string | null>("initial_file");
let shown = initial ? await openPath(initial) : false;
// A restored file that has gone missing closes its tab; try the next.
while (!shown && mru.length) shown = await activate(mru[0]);
if (!shown) {
  const welcome = makeDoc(null);
  docs = [welcome];
  loadText(welcome, { text: WELCOME, exact: true });
  await activate(welcome);
}
view.focus();
