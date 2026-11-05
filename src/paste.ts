// Smarter paste in markdown: a URL pasted over selected text makes a link,
// and rich text (from a web page, Word or Google Docs) arrives as markdown.
// Ctrl+Shift+V pastes plain text, since the clipboard then offers no HTML.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type TurndownService from "turndown";
import { splitRow, tableFromCells } from "./table";

const URL_TEXT = /^(https?:\/\/|mailto:)\S+$/i;

/** Inside a code block or code span, where pasted text should stay exactly as copied. */
function inCode(state: EditorState, pos: number) {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode)$/.test(node.name)) return true;
  }
  return false;
}

/** `[selection](url)` when a URL is pasted over text on one line. */
export function pasteLink(view: EditorView, data: DataTransfer): boolean {
  const url = data.getData("text/plain").trim();
  if (!URL_TEXT.test(url)) return false;
  const { state } = view;
  const ranges = state.selection.ranges;
  if (ranges.some((r) => r.empty || inCode(state, r.from))) return false;
  const texts = ranges.map((r) => state.sliceDoc(r.from, r.to));
  if (texts.some((t) => t.includes("\n") || URL_TEXT.test(t.trim()))) return false;
  const target = /[()\s]/.test(url) ? `<${url}>` : url;
  const tr = state.changeByRange((r) => {
    const insert = `[${state.sliceDoc(r.from, r.to)}](${target})`;
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.paste" }));
  return true;
}

/** HTML worth converting: plain styled text (or code from an IDE) pastes as text instead. */
const STRUCTURE = /<(a\s|strong|b[\s>]|em[\s>]|i[\s>]|h[1-6][\s>]|ul[\s>]|ol[\s>]|table|blockquote|del[\s>]|s[\s>]|strike|span[^>]*font-(weight|style))/i;

/** Pasted HTML as markdown, or null to paste the plain text instead. */
export function richPaste(view: EditorView, data: DataTransfer): Promise<string> | null {
  const html = data.getData("text/html");
  const plain = data.getData("text/plain");
  // VS Code and other editors copy code as styled HTML; keep it plain.
  if (!html || !STRUCTURE.test(html) || data.types.includes("vscode-editor-data")) return null;
  if (inCode(view.state, view.state.selection.main.from)) return null;
  return htmlToMarkdown(html).then((md) => {
    // Nothing gained over the plain text (only escapes added): use the plain text.
    if (md.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1") === plain.trim()) return plain;
    return md;
  });
}

let service: Promise<TurndownService> | undefined;

export async function htmlToMarkdown(html: string): Promise<string> {
  const td = await (service ??= import("turndown").then((m) => makeService(m.default)));
  return td.turndown(html).trim();
}

/** Bold or italic around content, keeping its outer spaces outside the markers. */
function wrap(content: string, marker: string) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : content;
}

function makeService(Turndown: typeof TurndownService) {
  const td = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    hr: "---",
  });
  td.remove(["style", "script", "meta", "title", "head", "noscript", "template"]);

  // Google Docs wraps the whole paste in <b style="font-weight:normal">, and
  // marks bold and italic with styled spans instead of <b> and <i>.
  td.addRule("notBold", {
    filter: (node) => node.nodeName === "B" && /font-weight:\s*(normal|400)/.test(node.getAttribute("style") ?? ""),
    replacement: (content) => content,
  });
  td.addRule("styledSpan", {
    filter: (node) => node.nodeName === "SPAN" && /font-(weight:\s*(bold|[6-9]00)|style:\s*italic)/.test(node.getAttribute("style") ?? ""),
    replacement: (content, node) => {
      const style = (node as HTMLElement).getAttribute("style") ?? "";
      let out = content;
      if (/font-style:\s*italic/.test(style)) out = wrap(out, "_");
      if (/font-weight:\s*(bold|[6-9]00)/.test(style)) out = wrap(out, "**");
      return out;
    },
  });

  // "- item" rather than turndown's "-   item", with continuation lines indented to match.
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1);
        prefix = `${start + [...parent.children].indexOf(node as HTMLElement)}. `;
      }
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n(?=.)/g, `\n${" ".repeat(prefix.length)}`);
      return prefix + body + (node.nextSibling && !body.endsWith("\n") ? "\n" : "");
    },
  });

  td.addRule("strikethrough", {
    filter: ["del", "s", "strike" as keyof HTMLElementTagNameMap],
    replacement: (content) => wrap(content, "~~"),
  });
  td.addRule("taskItem", {
    filter: (node) => node.nodeName === "INPUT" && node.getAttribute("type") === "checkbox" && node.parentNode?.nodeName === "LI",
    replacement: (_content, node) => ((node as HTMLInputElement).checked ? "[x] " : "[ ] "),
  });

  // Only web images: Word's file:// clip images and data: URIs would be dead or huge.
  td.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const src = (node as HTMLElement).getAttribute("src") ?? "";
      if (!/^https?:\/\//i.test(src)) return "";
      const alt = ((node as HTMLElement).getAttribute("alt") ?? "").replace(/[[\]\n]/g, "");
      return `![${alt}](${src})`;
    },
  });

  // Code blocks without a <code> inside (GitHub, many docs sites) still fence.
  td.addRule("bareCodeBlock", {
    filter: (node) => node.nodeName === "PRE" && !node.querySelector("code"),
    replacement: (_content, node) => {
      const text = (node.textContent ?? "").replace(/\n$/, "");
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `\n\n${fence}\n${text}\n${fence}\n\n`;
    },
  });

  // Every table, with or without header cells, as a GFM table. Cells hold one line each.
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = [...(node as HTMLTableElement).rows].map((tr) =>
        [...tr.cells].map((cell) =>
          td
            .turndown(cell.innerHTML)
            .replace(/\s*\n+\s*/g, " ")
            .replace(/(?<!\\)\|/g, "\\|")
            .trim(),
        ),
      );
      const filled = rows.filter((r) => r.length > 0);
      if (filled.length === 0) return "";
      // Re-split so escaped pipes are counted the way the editor will read them.
      const table = tableFromCells(filled.map((r) => splitRow(`| ${r.join(" | ")} |`)));
      return `\n\n${table}\n\n`;
    },
  });

  return td;
}
