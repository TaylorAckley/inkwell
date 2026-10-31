// Math (KaTeX) and diagrams (Mermaid) in the preview. Both libraries are
// loaded on first use, so documents without them pay nothing at startup.
//
// Only newly inserted preview blocks are enhanced (see patch.ts). Results
// are also cached by source text, so a block that is re-created (an edit
// inside it, a theme switch) gets its equations and diagrams back
// synchronously, before paint, without flicker.

type Katex = typeof import("katex").default;
type Mermaid = typeof import("mermaid").default;

let katexLoad: Promise<Katex> | null = null;
let mermaidLoad: Promise<Mermaid> | null = null;
let mermaidTheme = "";
let diagramId = 0;

const mathCache = new Map<string, string>();
const diagramCache = new Map<string, string>();

function loadKatex() {
  return (katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default));
}

export async function katexVersion() {
  return (await loadKatex()).version;
}

function loadMermaid() {
  return (mermaidLoad ??= import("mermaid").then((m) => m.default));
}

/** Elements matching `selector` in or under any of `roots`. */
export function within<T extends Element = HTMLElement>(roots: Element[], selector: string): T[] {
  return roots.flatMap((r) => [...(r.matches(selector) ? [r as T] : []), ...r.querySelectorAll<T & Element>(selector)]) as T[];
}

function remember(cache: Map<string, string>, key: string, value: string) {
  if (cache.size > 300) cache.clear();
  cache.set(key, value);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Replace a fenced block's <pre> with a div, keeping its scroll-sync anchor. */
function replacePre(code: HTMLElement, className: string, html: string) {
  const pre = code.parentElement!;
  const div = document.createElement("div");
  div.className = className;
  if (pre.dataset.sourcepos) div.dataset.sourcepos = pre.dataset.sourcepos;
  div.innerHTML = html;
  pre.replaceWith(div);
}

async function renderMath(roots: HTMLElement[], isCurrent: () => boolean) {
  const nodes = within(roots, "[data-math-style]");
  if (nodes.length === 0) return;
  const katex = await loadKatex();
  if (!isCurrent()) return;
  for (const node of nodes) {
    const display = node.dataset.mathStyle === "display";
    const src = node.textContent ?? "";
    const key = `${display ? "D" : "I"}\0${src}`;
    let html = mathCache.get(key);
    if (html === undefined) {
      html = katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html" });
      remember(mathCache, key, html);
    }
    // ```math blocks arrive as <pre><code data-math-style>; $..$ as <span>.
    if (node.tagName === "CODE" && node.parentElement?.tagName === "PRE") replacePre(node, "math-block", html);
    else {
      node.innerHTML = html;
      node.classList.add(display ? "math-block" : "math-inline");
    }
  }
}

async function renderDiagrams(roots: HTMLElement[], theme: "light" | "dark", isCurrent: () => boolean) {
  const blocks = within(roots, "pre > code.language-mermaid");
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  if (mermaidTheme !== theme) {
    mermaidTheme = theme;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
    });
  }
  for (const code of blocks) {
    const src = code.textContent ?? "";
    const key = `${theme}\0${src}`;
    let svg = diagramCache.get(key);
    if (svg === undefined) {
      try {
        svg = (await mermaid.render(`mmd-${++diagramId}`, src)).svg;
      } catch (err) {
        svg = `<div class="diagram-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
      }
      remember(diagramCache, key, svg);
    }
    if (!isCurrent()) return;
    if (code.isConnected) replacePre(code, "diagram", svg);
  }
}

/** Upgrade math and mermaid in these blocks, in place. Resolves once the layout is final. */
export async function enhance(roots: HTMLElement[], theme: "light" | "dark", isCurrent: () => boolean) {
  await Promise.all([renderMath(roots, isCurrent), renderDiagrams(roots, theme, isCurrent)]);
}

/** Languages handled here rather than by the syntax highlighter. */
export const RICH_LANGUAGES = new Set(["math", "mermaid"]);
