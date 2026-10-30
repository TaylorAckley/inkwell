import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// All colors come from CSS variables in styles.css, so light/dark switching
// is a single attribute flip with no editor reconfiguration.
export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--fg)",
    backgroundColor: "transparent",
    fontSize: "calc(14px * var(--zoom))",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
  },
  ".cm-content": {
    flex: "1 1 auto",
    maxWidth: "900px",
    margin: "0 auto",
    padding: "28px 36px 45vh",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-searchMatch": { backgroundColor: "var(--match)", outline: "1px solid var(--accent-soft)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-matchingBracket": { backgroundColor: "var(--match)", outline: "none" },
  ".cm-placeholder": { color: "var(--muted)" },
});

export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.35em", color: "var(--heading)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.2em", color: "var(--heading)" },
  { tag: t.heading3, fontWeight: "700", fontSize: "1.08em", color: "var(--heading)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--heading)" },
  { tag: t.strong, fontWeight: "700", color: "var(--heading)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)", textDecoration: "underline", textDecorationColor: "var(--border-strong)" },
  { tag: t.monospace, color: "var(--code-fg)" },
  // Markdown syntax markers: #, **, `, >, list bullets, fences.
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.labelName], color: "var(--muted)" },
  { tag: t.quote, color: "var(--muted)" },

  // Fenced code blocks (via @codemirror/language-data).
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syn-keyword)" },
]);
