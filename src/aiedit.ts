// Ctrl+J: ask Claude to rewrite the selection (or the paragraph at the
// cursor). The suggestion streams into a card under the text; Enter accepts
// it, Esc discards it.

import type { EditorView } from "@codemirror/view";
import { AiError, ensureKey, modelName, stream, unfence, type SystemBlock } from "./ai";
import { showMenu, type MenuItem } from "./menu";
import { toast } from "./actions";

export type AiEditHost = {
  view(): EditorView;
  docName(): string;
  /** Hand a question about the text to the Ask panel. */
  ask(question: string): void;
};

const ACTIONS: { label: string; instruction: string }[] = [
  { label: "Improve writing", instruction: "Improve the writing: clearer, tighter and more natural, keeping the meaning and voice." },
  { label: "Fix spelling and grammar", instruction: "Fix spelling, grammar and punctuation only. Change nothing else." },
  { label: "Make shorter", instruction: "Make it more concise, keeping the key points." },
  { label: "Make longer", instruction: "Expand it with useful detail, in the same voice." },
  { label: "Simplify", instruction: "Rewrite it in plain, simple language." },
  { label: "More formal", instruction: "Rewrite it in a more formal, professional tone." },
  { label: "More casual", instruction: "Rewrite it in a more casual, friendly tone." },
  { label: "Turn into a list", instruction: "Turn it into a well-organized markdown list." },
  { label: "Turn into a table", instruction: "Turn it into a markdown table where that makes sense." },
];

const SYSTEM = `You are an editing assistant inside a markdown editor. You receive a document for context, a passage from it, and an instruction. Rewrite only the passage according to the instruction.

Reply with the replacement markdown and nothing else: no preamble, no explanation, no quotation marks, and no code fence around the reply. Keep markdown formatting, links and the passage's line structure unless the instruction asks for a change. Write in the passage's language unless the instruction says otherwise.`;

/** Context sent with each request; long documents are trimmed around the passage. */
const MAX_CONTEXT = 120_000;

function contextAround(doc: string, from: number, to: number) {
  if (doc.length <= MAX_CONTEXT) return doc;
  const half = Math.floor((MAX_CONTEXT - (to - from)) / 2);
  const start = Math.max(0, from - half);
  return `${start > 0 ? "…\n" : ""}${doc.slice(start, Math.min(doc.length, to + half))}\n…`;
}

/** The paragraph around the cursor: the lines between blank lines. */
function paragraphAt(view: EditorView, pos: number) {
  const doc = view.state.doc;
  let first = doc.lineAt(pos);
  let last = first;
  if (!first.text.trim()) return null;
  while (first.number > 1 && doc.line(first.number - 1).text.trim()) first = doc.line(first.number - 1);
  while (last.number < doc.lines && doc.line(last.number + 1).text.trim()) last = doc.line(last.number + 1);
  return { from: first.from, to: last.to };
}

export function createAiEdit(host: AiEditHost) {
  let card: { el: HTMLElement; abort: AbortController; cleanup: () => void } | null = null;

  function closeCard() {
    if (!card) return;
    card.abort.abort();
    card.cleanup();
    card.el.remove();
    card = null;
  }

  function place(el: HTMLElement, view: EditorView, to: number) {
    const coords = view.coordsAtPos(to) ?? view.coordsAtPos(view.state.selection.main.head);
    const editor = view.dom.getBoundingClientRect();
    const width = Math.min(620, editor.width - 24);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(editor.left + 12, Math.min((coords?.left ?? editor.left) - 24, editor.right - width - 12))}px`;
    const below = (coords?.bottom ?? editor.top) + 8;
    const room = window.innerHeight - below - 40;
    if (room >= 180) {
      el.style.top = `${below}px`;
      el.style.maxHeight = `${room}px`;
    } else {
      el.style.bottom = `${window.innerHeight - (coords?.top ?? editor.bottom) + 8}px`;
      el.style.maxHeight = `${(coords?.top ?? editor.bottom) - 60}px`;
    }
  }

  async function run(label: string, instruction: string, range: { from: number; to: number }) {
    if (!(await ensureKey())) return;
    closeCard();
    const view = host.view();
    const original = view.state.sliceDoc(range.from, range.to);
    const doc = view.state.doc.toString();

    const el = document.createElement("div");
    el.className = "ai-card";
    el.setAttribute("role", "dialog");
    const head = document.createElement("div");
    head.className = "ai-card-head";
    head.innerHTML = '<span class="glyph">&#xE945;</span>';
    head.append(Object.assign(document.createElement("span"), { textContent: label }), Object.assign(document.createElement("small"), { textContent: modelName() }));
    const body = Object.assign(document.createElement("div"), { className: "ai-card-body working", textContent: "" });
    const foot = document.createElement("div");
    foot.className = "ai-card-foot";
    const button = (text: string, cls: string, key?: string) => {
      const b = Object.assign(document.createElement("button"), { className: `btn ${cls}`, textContent: text });
      if (key) b.append(Object.assign(document.createElement("kbd"), { textContent: key }));
      foot.append(b);
      return b;
    };
    const accept = button("Accept", "primary", "Enter");
    const retry = button("Retry", "");
    const discard = button("Discard", "", "Esc");
    accept.disabled = true;
    retry.disabled = true;
    el.append(head, body, foot);
    document.body.append(el);
    place(el, view, range.to);

    const abort = new AbortController();
    let result = "";
    let finished = false;

    const apply = () => {
      if (!finished || !result) return;
      const v = host.view();
      let { from, to } = range;
      // The text may have moved if the user kept typing; find it again.
      if (v.state.sliceDoc(from, to) !== original) {
        const at = v.state.doc.toString().indexOf(original);
        if (at < 0) {
          toast("The text changed, so the suggestion wasn't applied");
          return closeCard();
        }
        from = at;
        to = at + original.length;
      }
      v.dispatch({ changes: { from, to, insert: result }, selection: { anchor: from, head: from + result.length }, scrollIntoView: true, userEvent: "input.ai" });
      closeCard();
      v.focus();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCard();
        host.view().focus();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && finished && result) {
        e.preventDefault();
        e.stopPropagation();
        apply();
      }
    };
    window.addEventListener("keydown", onKey, true);
    card = { el, abort, cleanup: () => window.removeEventListener("keydown", onKey, true) };

    accept.addEventListener("click", apply);
    discard.addEventListener("click", () => {
      closeCard();
      host.view().focus();
    });
    retry.addEventListener("click", () => void run(label, instruction, range));

    const system: SystemBlock[] = [
      { type: "text", text: SYSTEM },
      { type: "text", text: `<document name="${host.docName()}">\n${contextAround(doc, range.from, range.to)}\n</document>`, cache_control: { type: "ephemeral" } },
    ];
    try {
      const text = await stream({
        system,
        messages: [{ role: "user", content: `Instruction: ${instruction}\n\n<passage>\n${original}\n</passage>` }],
        maxTokens: 16000,
        effort: "low",
        signal: abort.signal,
        onText: (all) => (body.textContent = all),
      });
      if (abort.signal.aborted) return;
      // Keep the passage's own fence if it was a code block; drop one Claude added.
      result = original.trimStart().startsWith("```") ? text.trim() : unfence(text).trim();
      body.textContent = result;
      finished = true;
      body.classList.remove("working");
      accept.disabled = !result;
      retry.disabled = false;
      accept.focus();
    } catch (err) {
      if (abort.signal.aborted) return;
      body.classList.remove("working");
      body.classList.add("error");
      body.textContent = err instanceof AiError ? err.message : String(err);
      retry.disabled = false;
    }
  }

  /** Ctrl+J: pick an action for the selection, or for the paragraph at the cursor. */
  function open() {
    const view = host.view();
    const sel = view.state.selection.main;
    const range = sel.empty ? paragraphAt(view, sel.head) : { from: sel.from, to: sel.to };
    if (!range) return toast("Select some text, or put the cursor in a paragraph");
    if (sel.empty) view.dispatch({ selection: { anchor: range.from, head: range.to } });
    const passage = view.state.sliceDoc(range.from, range.to);
    const items: MenuItem[] = ACTIONS.map((a) => ({ label: a.label, action: () => run(a.label, a.instruction, range) }));
    items.push(
      "-",
      { label: "Custom instruction…", action: () => askInstruction(range) },
      { label: "Explain in the Ask panel", action: () => host.ask(`Explain this passage:\n\n${passage}`) },
    );
    const at = view.coordsAtPos(range.from) ?? { left: 200, bottom: 200 };
    showMenu(items, at.left, at.bottom + 4);
  }

  /** A one-line prompt for a free-form instruction, in the same card position. */
  function askInstruction(range: { from: number; to: number }) {
    closeCard();
    const view = host.view();
    const el = document.createElement("div");
    el.className = "ai-card";
    const input = Object.assign(document.createElement("input"), {
      className: "ai-card-input",
      placeholder: "Tell Claude what to do with the selection…  (Enter to run, Esc to cancel)",
      spellcheck: false,
    });
    el.append(input);
    document.body.append(el);
    place(el, view, range.to);
    const abort = new AbortController();
    card = { el, abort, cleanup: () => {} };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        closeCard();
        view.focus();
      } else if (e.key === "Enter" && input.value.trim()) {
        void run(input.value.trim(), input.value.trim(), range);
      }
    });
    input.focus();
  }

  return { open, close: closeCard };
}
