// Plain text and log files: no markdown parsing and no preview. Logs also
// get line numbers, no wrapping, and colored levels and timestamps.

import { Decoration, EditorView, MatchDecorator, ViewPlugin, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export type Kind = "markdown" | "text" | "log";

export function kindOf(path: string | null): Kind {
  if (!path) return "markdown";
  if (/\.log$/i.test(path)) return "log";
  if (/\.txt$/i.test(path)) return "text";
  return "markdown";
}

// Levels as whole words, plus ISO-like dates and clock times (2026-11-02T09:14:03.120Z, 09:14:03,120).
const LOG_TOKENS =
  /\b(?:(FATAL|CRITICAL|CRIT|ERROR|ERR|EXCEPTION|PANIC)|(WARNING|WARN)|(INFO|NOTICE)|(DEBUG|TRACE|VERBOSE))\b|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g;

const marks = {
  error: Decoration.mark({ class: "log-error" }),
  warn: Decoration.mark({ class: "log-warn" }),
  info: Decoration.mark({ class: "log-info" }),
  debug: Decoration.mark({ class: "log-debug" }),
  time: Decoration.mark({ class: "log-time" }),
};

// MatchDecorator only scans the visible lines, so huge logs stay fast.
const logTokens = new MatchDecorator({
  regexp: LOG_TOKENS,
  decoration: (m) => (m[1] ? marks.error : m[2] ? marks.warn : m[3] ? marks.info : m[4] ? marks.debug : marks.time),
});

const logHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = logTokens.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = logTokens.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// Full width: long log lines scroll sideways instead of sitting in the reading column.
export const logExtensions = [lineNumbers(), logHighlight, EditorView.editorAttributes.of({ class: "cm-log" })];
