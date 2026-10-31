// Claude, through the user's own API key. Requests go through the Rust side
// (ai.rs), which holds the key; this module streams the text back and owns
// the settings dialog.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { prefs } from "./prefs";

export type Model = "claude-opus-5-5" | "claude-haiku-5-5";

export const MODELS: { id: Model; name: string; note: string }[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "Most capable. $4 / $20 per million tokens in / out." },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "Fast and inexpensive. $0.10 / $0.50 per million tokens." },
];

export const currentModel = () => prefs.get<Model>("aiModel", "claude-opus-5-5");
export const modelName = (id: Model = currentModel()) => MODELS.find((m) => m.id === id)?.name ?? id;

export type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
export type Turn = { role: "user" | "assistant"; content: string };

type AiEvent =
  | { kind: "text"; id: number; text: string }
  | { kind: "done"; id: number; stop_reason: string | null }
  | { kind: "error"; id: number; message: string };

const handlers = new Map<number, (e: AiEvent) => void>();
const ready = listen<AiEvent>("ai", (e) => handlers.get(e.payload.id)?.(e.payload));
let nextId = 1;

export class AiError extends Error {}

export type StreamOptions = {
  system: string | SystemBlock[];
  messages: Turn[];
  maxTokens: number;
  effort?: "low" | "medium" | "high";
  onText?: (all: string) => void;
  signal?: AbortSignal;
};

/**
 * Stream a completion. Resolves with the full text, or with whatever had
 * arrived when `signal` aborted. Rejects with an AiError when the request
 * fails or Claude declines it.
 */
export async function stream(opts: StreamOptions): Promise<string> {
  await ready;
  const id = nextId++;
  let text = "";
  return new Promise<string>((resolve, reject) => {
    const finish = () => handlers.delete(id);
    handlers.set(id, (e) => {
      if (e.kind === "text") {
        text += e.text;
        if (!opts.signal?.aborted) opts.onText?.(text);
        return;
      }
      finish();
      if (e.kind === "error") reject(new AiError(e.message));
      // A refusal can arrive after partial output; the partial isn't usable.
      else if (e.stop_reason === "refusal") reject(new AiError("Claude declined this request."));
      else resolve(text);
    });
    opts.signal?.addEventListener("abort", () => {
      void invoke("ai_cancel", { id });
      finish();
      resolve(text);
    });
    invoke("ai_stream", {
      req: {
        id,
        model: currentModel(),
        system: opts.system,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        effort: opts.effort ?? null,
      },
    }).catch((err) => {
      finish();
      reject(new AiError(String(err)));
    });
  });
}

/** Strip a code fence wrapped around the whole reply, which models sometimes add. */
export function unfence(text: string) {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

// ---------------------------------------------------------------------------
// Settings dialog

/** True when a key is set, asking for one first if needed. */
export async function ensureKey(): Promise<boolean> {
  if (await invoke<boolean>("ai_has_key")) return true;
  return openSettings(true);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** A centered dialog over a dimmed window. Resolves when it closes. */
export function modal(build: (close: (value?: unknown) => void) => HTMLElement, opts: { wide?: boolean } = {}) {
  return new Promise<unknown>((resolve) => {
    const restore = document.activeElement;
    const backdrop = el("div", { className: "modal-backdrop" });
    const box = el("div", { className: `modal${opts.wide ? " modal-wide" : ""}` });
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    let closed = false;
    const close = (value?: unknown) => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
      resolve(value);
    };
    box.append(build(close));
    backdrop.append(box);
    // A stray click outside a wide dialog (the page designer) shouldn't throw away its work.
    if (!opts.wide) backdrop.addEventListener("pointerdown", (e) => e.target === backdrop && close());
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
    });
    document.body.append(backdrop);
    box.querySelector<HTMLElement>("[autofocus], input, textarea, button")?.focus();
  });
}

/** Key and model settings. With `needKey`, resolves true only once a key is saved. */
export async function openSettings(needKey = false): Promise<boolean> {
  const hasKey = await invoke<boolean>("ai_has_key");
  const result = await modal((close) => {
    const input = el("input", {
      type: "password",
      placeholder: hasKey ? "A key is saved. Paste a new one to replace it" : "sk-ant-…",
      spellcheck: false,
      autocomplete: "off",
    });
    input.autofocus = true;
    const error = el("div", { className: "modal-error" });
    const link = el("a", { href: "#", textContent: "console.anthropic.com" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      void openUrl("https://console.anthropic.com/settings/keys");
    });

    const models = el("div", { className: "model-list" });
    for (const m of MODELS) {
      const radio = el("input", { type: "radio", name: "ai-model", value: m.id, checked: m.id === currentModel() });
      models.append(el("label", { className: "model-option" }, radio, el("span", {}, el("strong", { textContent: m.name }), el("small", { textContent: m.note }))));
    }

    const save = el("button", { className: "btn primary", textContent: "Save" });
    const cancel = el("button", { className: "btn", textContent: "Cancel" });
    const remove = el("button", { className: "btn danger", textContent: "Remove key" });
    remove.hidden = !hasKey;

    const commit = async () => {
      const picked = models.querySelector<HTMLInputElement>("input:checked")?.value as Model | undefined;
      if (picked) prefs.set("aiModel", picked);
      const key = input.value.trim();
      if (key) {
        try {
          await invoke("ai_set_key", { key });
        } catch (err) {
          error.textContent = String(err);
          return;
        }
      } else if (!hasKey && needKey) {
        error.textContent = "Paste an API key to continue.";
        return;
      }
      close(true);
    };
    save.addEventListener("click", () => void commit());
    input.addEventListener("keydown", (e) => e.key === "Enter" && void commit());
    cancel.addEventListener("click", () => close(false));
    remove.addEventListener("click", async () => {
      await invoke("ai_clear_key").catch(() => {});
      close(false);
    });

    return el(
      "div",
      { className: "modal-body" },
      el("h2", { textContent: "Claude AI" }),
      el(
        "p",
        { className: "modal-note" },
        "Inkwell uses your own Claude API key, stored in Windows Credential Manager. Text is sent to Anthropic only when you use an AI action. API usage is billed separately from a Claude subscription. Create a key at ",
        link,
        ".",
      ),
      el("label", { className: "field" }, el("span", { textContent: "API key" }), input),
      error,
      el("div", { className: "field" }, el("span", { textContent: "Model" }), models),
      el("div", { className: "modal-actions" }, remove, el("span", { className: "spacer" }), cancel, save),
    );
  });
  return result === true && (!needKey || (await invoke<boolean>("ai_has_key")));
}
