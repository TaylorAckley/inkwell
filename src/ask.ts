// The sidebar's Ask panel: a conversation with Claude about the open
// document. Each request carries the current text of the document, so
// answers follow edits and tab switches.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AiError, ensureKey, modelName, stream, type SystemBlock, type Turn } from "./ai";
import { copy } from "./actions";

export type AskHost = {
  docText(): string;
  docName(): string;
  selection(): string;
  insert(text: string): void;
};

const SYSTEM = `You are a writing and research assistant inside Inkwell, a markdown editor. The user's open document is below. Answer questions about it, review it, and help improve it. Be direct and specific, and quote the document where it helps. Use markdown in your answers. When you suggest replacement text, give it ready to paste.`;

const SUGGESTIONS = ["Summarize this document", "What's unclear or missing?", "Suggest a better structure", "Proofread it and list the fixes"];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createAsk(host: AskHost) {
  const log = $("ask-log");
  const input = $<HTMLTextAreaElement>("ask-input");
  const send = $<HTMLButtonElement>("ask-send");
  const model = $("ask-model");

  let turns: Turn[] = [];
  let running: AbortController | null = null;
  let starting = false;

  function showEmpty() {
    const empty = document.createElement("div");
    empty.className = "ask-empty";
    empty.append(Object.assign(document.createElement("p"), { textContent: "Ask Claude about the open document." }));
    for (const s of SUGGESTIONS) {
      const chip = Object.assign(document.createElement("button"), { className: "ask-chip", textContent: s });
      chip.addEventListener("click", () => void ask(s));
      empty.append(chip);
    }
    log.replaceChildren(empty);
  }

  function bubble(role: "user" | "assistant") {
    log.querySelector(".ask-empty")?.remove();
    const el = document.createElement("div");
    el.className = `ask-msg ${role}`;
    log.append(el);
    return el;
  }

  async function renderMarkdown(el: HTMLElement, text: string) {
    const html = await invoke<string>("render_markdown", { source: text });
    el.innerHTML = html; // sanitized by the renderer
  }

  function answerTools(el: HTMLElement, text: string) {
    const bar = document.createElement("div");
    bar.className = "ask-tools";
    const button = (label: string, title: string, run: () => void) => {
      const b = Object.assign(document.createElement("button"), { textContent: label, title });
      b.addEventListener("click", run);
      bar.append(b);
    };
    button("Copy", "Copy the answer as markdown", () => copy(text, "answer"));
    button("Insert", "Insert at the cursor", () => host.insert(text));
    el.append(bar);
  }

  function setRunning(on: boolean) {
    send.textContent = on ? "Stop" : "Send";
    send.classList.toggle("primary", !on);
  }

  async function ask(question: string) {
    question = question.trim();
    if (!question || running || starting) return;
    starting = true; // a second Enter while the key check is pending must not send twice
    const hasKey = await ensureKey().finally(() => (starting = false));
    if (!hasKey) return;
    input.value = "";
    // "New" swaps in a fresh array; this exchange belongs to the one it started in.
    const convo = turns;

    const selection = host.selection().trim();
    const content = selection && !question.includes(selection) ? `${question}\n\n<selection>\n${selection}\n</selection>` : question;
    const user = bubble("user");
    user.textContent = question;
    const answer = bubble("assistant");
    answer.classList.add("working");
    log.scrollTop = log.scrollHeight;

    const system: SystemBlock[] = [
      { type: "text", text: SYSTEM },
      { type: "text", text: `<document name="${host.docName()}">\n${host.docText()}\n</document>`, cache_control: { type: "ephemeral" } },
    ];
    const abort = (running = new AbortController());
    setRunning(true);

    // Re-render the markdown at most a few times a second while streaming.
    let latest = "";
    let pending = false;
    let done = false;
    const paint = () => {
      if (pending) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        if (done) return; // the final render (with its buttons) already ran
        const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        const html = await invoke<string>("render_markdown", { source: latest });
        if (done) return;
        answer.innerHTML = html; // sanitized by the renderer
        if (stick) log.scrollTop = log.scrollHeight;
      }, 120);
    };

    try {
      const text = await stream({
        system,
        messages: [...convo, { role: "user", content }],
        maxTokens: 16000,
        effort: "medium",
        signal: abort.signal,
        onText: (all) => {
          latest = all;
          paint();
        },
      });
      done = true;
      answer.classList.remove("working");
      if (text) {
        convo.push({ role: "user", content }, { role: "assistant", content: text });
        await renderMarkdown(answer, text);
        answerTools(answer, text);
      } else {
        answer.remove();
        user.remove();
      }
    } catch (err) {
      done = true;
      answer.classList.remove("working");
      answer.classList.add("error");
      answer.textContent = err instanceof AiError ? err.message : String(err);
    } finally {
      running = null;
      setRunning(false);
      log.scrollTop = log.scrollHeight;
    }
  }

  send.addEventListener("click", () => (running ? running.abort() : void ask(input.value)));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep sidebar shortcuts (F2, Delete) out of the text box
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(input.value);
    }
  });
  $("ask-new").addEventListener("click", () => {
    running?.abort();
    turns = [];
    showEmpty();
    input.focus();
  });
  // Links in answers open in the browser, never inside the app.
  log.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href")!;
    if (/^https?:/i.test(href)) void openUrl(href);
  });

  showEmpty();

  return {
    /** Focus the box, optionally sending a question straight away. */
    focus(question?: string) {
      model.textContent = modelName();
      if (question) void ask(question);
      else input.focus();
    },
  };
}
