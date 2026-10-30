# Inkwell

A fast markdown editor and viewer for Windows, built with Rust and Tauri 2.

- **Editor:** CodeMirror 6 with markdown highlighting, including highlighting inside fenced code blocks.
- **Rendering:** [comrak](https://github.com/kivikakk/comrak) in Rust, giving GitHub-flavoured markdown (tables, task lists, footnotes, strikethrough). Raw HTML is sanitized with ammonia.
- **Scroll sync:** the editor and preview stay aligned using comrak's `data-sourcepos` line anchors.
- **Math and diagrams:** `$inline$`, `$$display$$` and ```` ```math ```` blocks render with KaTeX, and ```` ```mermaid ```` blocks render with Mermaid. Both load only when a document uses them.
- **Sidebar (Ctrl+B):** recent files plus a folder tree that follows the open file, or a folder you pick.
- **External changes:** the open file is polled for changes. If it has no unsaved edits it reloads quietly, keeping scroll position and undo history; otherwise you're asked first.
- **Window:** Windows 11 Mica, a custom title bar, light and dark themes, and drag-and-drop to open files.

## Develop

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

This produces `target/release/inkwell.exe` and an NSIS installer that registers `.md` file associations.

> **Long paths:** if the project sits in a deeply nested folder, MSVC's linker can hit the 260-character path limit (`LNK1104`). Fix it by setting `CARGO_TARGET_DIR` to a short path, or by enabling Windows long-path support.

## Layout

| Path | What it is |
| --- | --- |
| `src-tauri/src/main.rs` | Tauri commands: render, read, write (atomic), folder listing, file watcher, CLI file arg |
| `src-tauri/src/markdown.rs` | comrak options and the ammonia sanitizer |
| `src/main.ts` | Editor, preview pipeline, scroll sync, file ops, external reload, window chrome |
| `src/sidebar.ts` | Recent files and folder tree |
| `src/rich.ts` | Lazy KaTeX and Mermaid rendering with caches |
| `src/editor-theme.ts` | CodeMirror theme and highlight style |
| `src/styles.css` | Design tokens (light/dark), chrome, preview typography |
