// "Design a page": Claude turns the markdown into a self-contained, styled
// HTML page, previewed in a sandbox and saved as HTML or PDF.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { AiError, ensureKey, modal, modelName, stream } from "./ai";
import { copy, reportError, toast } from "./actions";
import { fileName, prefs } from "./prefs";

export type DesignHost = {
  docText(): string;
  docPath(): string | null;
};

const STYLES: { id: string; label: string; brief: string }[] = [
  { id: "report", label: "Report", brief: "a polished professional report with a title block, clear section hierarchy and refined typography" },
  { id: "onepager", label: "One-pager", brief: "a dense, scannable one-page brief with a strong headline, key points emphasized and a compact layout" },
  { id: "article", label: "Article", brief: "a long-form editorial article with a comfortable reading measure and magazine-quality typography" },
  { id: "slides", label: "Slides", brief: "a slide deck: one full-viewport section per slide (split at headings), large type, one idea per slide, and print rules that put one slide on each landscape page" },
  { id: "docs", label: "Docs page", brief: "a technical documentation page with a table of contents, well-styled code blocks, tables and callouts" },
];

const SYSTEM = `You are an expert web designer. Turn the user's markdown document into one beautifully designed, self-contained HTML page.

Requirements:
- Reply with only the HTML document, starting with <!doctype html>. No commentary and no code fence.
- Put all CSS in a <style> element. Do not use JavaScript.
- Use no external resources: no web fonts, CDNs or remote images. Use system font stacks (for example "Segoe UI Variable", "Segoe UI", system-ui, sans-serif and Georgia or Cambria for serif).
- Keep all of the document's content, in order. Don't summarize or drop sections unless the instructions ask for it.
- Keep every image src exactly as written in the markdown.
- Render tables, code blocks, task lists, footnotes and blockquotes properly. Redraw mermaid diagrams as inline SVG or clean HTML and CSS; write math as MathML or tidy HTML.
- Make it look intentional and distinctive rather than generic: a considered type scale, spacing and a restrained color palette.
- Make it responsive, and include @media print rules with an @page margin and sensible page breaks (no breaks inside figures, tables or code blocks; headings kept with what follows).`;

/** The HTML document in a reply, without anything Claude wrapped around it. */
export function extractHtml(reply: string) {
  const text = reply.replace(/^\s*```(?:html)?\s*\n/i, "").replace(/\n```\s*$/, "");
  const start = text.search(/<!doctype html|<html[\s>]/i);
  return (start >= 0 ? text.slice(start) : text).trim();
}

/** The page as previewed: scripts and network blocked, local images via the asset protocol. */
function previewDoc(html: string, baseDir: string | null) {
  // The app's own CSP already stops the frame loading other sites; drop refresh tags anyway.
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  let head = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: asset: http://asset.localhost; font-src data:">`;
  if (baseDir) head += `<base href="${convertFileSrc(`${baseDir}\\`)}">`;
  const m = /<head(?:\s[^>]*)?>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + head + html.slice(m.index + m[0].length) : `<!doctype html><head>${head}</head>${html}`;
}

export function createDesign(host: DesignHost) {
  async function open() {
    if (!host.docText().trim()) return toast("The document is empty");
    if (!(await ensureKey())) return;

    let style = prefs.get("designStyle", "report");
    let theme = prefs.get<"light" | "dark">("designTheme", "light");
    let extra = prefs.get("designNotes", "");
    let html = "";
    let abort: AbortController | null = null;

    await modal(
      (close) => {
        const root = document.createElement("div");
        root.className = "modal-body design";
        const dir = host.docPath() ? host.docPath()!.replace(/[\\/][^\\/]*$/, "") : null;
        const baseName = fileName(host.docPath()).replace(/\.[^.]+$/, "");

        const showOptions = () => {
          root.replaceChildren();
          root.append(Object.assign(document.createElement("h2"), { textContent: "Design a page with Claude" }));
          root.append(
            Object.assign(document.createElement("p"), {
              className: "modal-note",
              textContent: `${modelName()} turns this document into a styled, self-contained page you can save as HTML or PDF. A long document can take a minute or two.`,
            }),
          );
          const chips = document.createElement("div");
          chips.className = "chip-row";
          for (const s of STYLES) {
            const chip = Object.assign(document.createElement("button"), { className: `chip${s.id === style ? " on" : ""}`, textContent: s.label });
            chip.addEventListener("click", () => {
              style = s.id;
              for (const c of chips.children) c.classList.toggle("on", c === chip);
            });
            chips.append(chip);
          }
          const themes = document.createElement("div");
          themes.className = "chip-row";
          for (const t of ["light", "dark"] as const) {
            const chip = Object.assign(document.createElement("button"), { className: `chip${t === theme ? " on" : ""}`, textContent: t === "light" ? "Light" : "Dark" });
            chip.addEventListener("click", () => {
              theme = t;
              for (const c of themes.children) c.classList.toggle("on", c === chip);
            });
            themes.append(chip);
          }
          const notes = Object.assign(document.createElement("textarea"), {
            rows: 3,
            value: extra,
            placeholder: "Optional: brand colors, audience, things to emphasize…",
          });
          const go = Object.assign(document.createElement("button"), { className: "btn primary", textContent: "Generate" });
          const cancel = Object.assign(document.createElement("button"), { className: "btn", textContent: "Cancel" });
          cancel.addEventListener("click", () => close());
          go.addEventListener("click", () => {
            extra = notes.value.trim();
            prefs.set("designStyle", style);
            prefs.set("designTheme", theme);
            prefs.set("designNotes", extra);
            void generate();
          });
          const field = (label: string, control: HTMLElement) => {
            const f = document.createElement("div");
            f.className = "field";
            f.append(Object.assign(document.createElement("span"), { textContent: label }), control);
            return f;
          };
          const actions = document.createElement("div");
          actions.className = "modal-actions";
          actions.append(Object.assign(document.createElement("span"), { className: "spacer" }), cancel, go);
          root.append(field("Style", chips), field("Theme", themes), field("Instructions", notes), actions);
          go.focus();
        };

        const generate = async () => {
          root.replaceChildren();
          root.append(Object.assign(document.createElement("h2"), { textContent: "Designing…" }));
          const status = Object.assign(document.createElement("p"), { className: "modal-note", textContent: `${modelName()} is working on it.` });
          const stop = Object.assign(document.createElement("button"), { className: "btn", textContent: "Stop" });
          const actions = document.createElement("div");
          actions.className = "modal-actions";
          actions.append(Object.assign(document.createElement("span"), { className: "spacer" }), stop);
          root.append(status, Object.assign(document.createElement("div"), { className: "progress-bar" }), actions);
          abort = new AbortController();
          stop.addEventListener("click", () => {
            abort?.abort();
            showOptions();
          });

          const brief = STYLES.find((s) => s.id === style)?.brief ?? STYLES[0].brief;
          const instructions = [`Design it as ${brief}.`, `Use a ${theme} color scheme.`, extra && `Additional instructions: ${extra}`].filter(Boolean).join("\n");
          try {
            const reply = await stream({
              system: SYSTEM,
              messages: [{ role: "user", content: `${instructions}\n\n<document>\n${host.docText()}\n</document>` }],
              maxTokens: 64000,
              effort: "medium",
              signal: abort.signal,
              onText: (all) => (status.textContent = `Writing the page… ${(all.length / 1024).toFixed(1)} KB`),
            });
            if (abort.signal.aborted) return;
            html = extractHtml(reply);
            if (!/<\/(html|body)>/i.test(html)) throw new AiError("The page came back incomplete. Try again, or choose a shorter style.");
            showPreview();
          } catch (err) {
            if (abort?.signal.aborted) return;
            showOptions();
            const error = Object.assign(document.createElement("div"), { className: "modal-error", textContent: err instanceof AiError ? err.message : String(err) });
            root.insertBefore(error, root.querySelector(".modal-actions"));
          }
        };

        const showPreview = () => {
          root.replaceChildren();
          root.classList.add("previewing");
          const frame = document.createElement("iframe");
          frame.className = "design-frame";
          frame.setAttribute("sandbox", ""); // no scripts, no forms, opaque origin
          frame.srcdoc = previewDoc(html, dir);
          const button = (label: string, cls = "") => {
            const b = Object.assign(document.createElement("button"), { className: `btn ${cls}`, textContent: label });
            actions.append(b);
            return b;
          };
          const actions = document.createElement("div");
          actions.className = "modal-actions";
          const back = button("Change options");
          const again = button("Regenerate");
          actions.append(Object.assign(document.createElement("span"), { className: "spacer" }));
          const copyBtn = button("Copy HTML");
          const saveHtml = button("Save HTML…");
          const savePdf = button("Save PDF…", "primary");
          const done = button("Close");
          back.addEventListener("click", () => {
            root.classList.remove("previewing");
            showOptions();
          });
          again.addEventListener("click", () => {
            root.classList.remove("previewing");
            void generate();
          });
          copyBtn.addEventListener("click", () => copy(html, "HTML"));
          saveHtml.addEventListener("click", async () => {
            const path = await save({ defaultPath: `${dir ? `${dir}\\` : ""}${baseName}.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
            if (!path) return;
            try {
              await invoke("write_file", { path, contents: html });
              toast(`Saved ${fileName(path)}`);
            } catch (err) {
              reportError(err);
            }
          });
          savePdf.addEventListener("click", async () => {
            const path = await save({ defaultPath: `${dir ? `${dir}\\` : ""}${baseName}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
            if (!path) return;
            savePdf.disabled = true;
            try {
              await invoke("export_html_pdf", { html, base: dir, path });
              toast(`Saved ${fileName(path)}`);
            } catch (err) {
              reportError(err);
            } finally {
              savePdf.disabled = false;
            }
          });
          done.addEventListener("click", () => close());
          root.append(frame, actions);
          savePdf.focus();
        };

        showOptions();
        return root;
      },
      { wide: true },
    );
    (abort as AbortController | null)?.abort(); // the dialog closed mid-generation
  }

  return { open };
}
