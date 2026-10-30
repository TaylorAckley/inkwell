// Standalone HTML export and rich-text clipboard copies of the preview.

import { katexVersion } from "./rich";

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The app's CSS, minus KaTeX's (its fonts are relative URLs that won't resolve outside the app). */
function collectCss() {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    if ((sheet.href ?? "").includes("katex")) continue;
    try {
      for (const rule of sheet.cssRules) rules.push(rule.cssText);
    } catch {
      /* cross-origin sheet; none expected */
    }
  }
  return rules.join("\n");
}

async function toDataUrl(src: string): Promise<string | null> {
  try {
    const blob = await (await fetch(src)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Copy of the preview with UI-only bits removed and local images inlined. */
async function portableClone(preview: HTMLElement) {
  const clone = preview.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".code-copy").forEach((b) => b.remove());
  clone.querySelectorAll("[data-sourcepos]").forEach((el) => el.removeAttribute("data-sourcepos"));
  await Promise.all(
    [...clone.querySelectorAll<HTMLImageElement>("img[src]")].map(async (img) => {
      const src = img.getAttribute("src")!;
      if (/^(https?:\/\/(?!asset\.localhost)|data:)/i.test(src)) return; // already portable
      const data = await toDataUrl(src);
      if (data) img.setAttribute("src", data);
    }),
  );
  return clone;
}

/** A single self-contained HTML file: styles, local images and content inlined. */
export async function standaloneHtml(preview: HTMLElement, title: string) {
  const clone = await portableClone(preview);
  const hasMath = clone.querySelector(".katex") !== null;
  const katexLink = hasMath
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${await katexVersion()}/dist/katex.min.css">\n`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${katexLink}<style>
${collectCss()}
html, body { height: auto; overflow: auto; background: #fff; user-select: text; }
.markdown-body { padding-bottom: 64px; }
</style>
</head>
<body>
<article class="markdown-body">
${clone.innerHTML}
</article>
</body>
</html>
`;
}

/** The current selection inside `root` as HTML and text, or null if nothing is selected there. */
export function selectionIn(root: HTMLElement): { html: string; text: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const div = document.createElement("div");
  div.append(range.cloneContents());
  div.querySelectorAll(".code-copy").forEach((b) => b.remove());
  return { html: div.innerHTML, text: sel.toString() };
}

/** Rich text for pasting into email, Teams, Confluence, Jira… with a plain-text fallback. */
export async function copyRich(html: string, text: string) {
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    }),
  ]);
}

export async function previewHtml(preview: HTMLElement) {
  return (await portableClone(preview)).innerHTML;
}
