# Inkwell

A fast markdown editor and viewer for Windows, built with Rust and Tauri 2.

- **Editor:** CodeMirror 6 with markdown highlighting, including highlighting inside fenced code blocks.
- **Rendering:** [comrak](https://github.com/kivikakk/comrak) in Rust, giving GitHub-flavoured markdown (tables, task lists, footnotes, strikethrough). Raw HTML is sanitized with ammonia.
- **Scroll sync:** the editor and preview stay aligned using comrak's `data-sourcepos` line anchors.
- **Math and diagrams:** `$inline$`, `$$display$$` and ```` ```math ```` blocks render with KaTeX, and ```` ```mermaid ```` blocks render with Mermaid. Both load only when a document uses them.
- **Tabs:** IDE-style tabs with temporary preview tabs, Ctrl+Tab switching, drag to reorder and session restore. Background tabs load only when first shown.
- **Sidebar (Ctrl+\\):** files (recent plus a folder tree), an outline of the document (Ctrl+Shift+O), folder search (Ctrl+Shift+F) and the Ask panel.
- **Quick open (Ctrl+P):** fuzzy-find any document in the folder.
- **Writing:** GitHub's formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+E, Ctrl+K, Ctrl+Shift+7/8/.), and pasted screenshots saved to `./assets`.
- **Text and logs:** `.txt` and `.log` files open editor-only, without the preview or markdown formatting. Logs get line numbers, colored levels (ERROR, WARN, INFO, DEBUG) and timestamps, no wrapping, and follow new lines while scrolled to the end, like `tail -f`. Files that aren't UTF-8 (UTF-16, Windows-1252) open read-only so saving can't change their bytes. Files over 64 MB are refused.
- **Export:** PDF (Ctrl+Shift+E), standalone HTML, and rich-text copy.
- **External changes:** open files are polled for changes. A tab with no unsaved edits reloads quietly, keeping scroll position and undo history; otherwise you're asked first.
- **Window:** Windows 11 Mica, a custom title bar, light and dark themes, and drag-and-drop to open files.

## Claude

Inkwell can use Claude with your own API key from [console.anthropic.com](https://console.anthropic.com/settings/keys) (billed by Anthropic, separately from a Claude subscription). The key is stored in Windows Credential Manager and only the Rust side reads it; text leaves your machine only when you use one of these:

- **Ctrl+J:** rewrite the selection, or the paragraph at the cursor: improve, fix grammar, shorten, change tone, turn into a list or table, or a custom instruction. The suggestion appears under the text; Enter accepts, Esc discards.
- **Ask panel (Ctrl+Shift+J):** chat about the open document. Answers can be copied or inserted at the cursor.
- **Design a page:** turn the document into a styled, self-contained HTML page (report, one-pager, article, slides, docs), previewed in a sandbox and saved as HTML or PDF. Generated pages can't run scripts or load anything from the network.

Pick Claude Opus 5.5 (default) or Claude Haiku 5.5 in **⋯ → AI settings**.

`inkwell --html-to-pdf page.html out.pdf` prints an HTML file to PDF without opening the editor.

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

## Release

Bump the version in all three manifests and their lockfiles (CI builds with `--locked`, so a stale `Cargo.lock` fails):

1. `npm version 0.2.0 --no-git-tag-version` (updates `package.json` and `package-lock.json`)
2. Set `version` in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
3. `cargo update --workspace --manifest-path src-tauri/Cargo.toml` (updates only inkwell's own entry in `Cargo.lock`)

Commit all five files, merge to main, then push a matching tag (the workflow refuses a tag that differs from `tauri.conf.json`):

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow builds the installer and attaches it to a draft release on GitHub; publish it from there.

## Layout

| Path | What it is |
| --- | --- |
| `src-tauri/src/main.rs` | Tauri commands: render, read, write (atomic), folder listing, file watcher, CLI args |
| `src-tauri/src/markdown.rs` | comrak options and the ammonia sanitizer |
| `src-tauri/src/workspace.rs` | Quick-open file list, folder search, pasted-image saving |
| `src-tauri/src/shell.rs` | Create, rename, delete, reveal, terminal and editor launching |
| `src-tauri/src/pdf.rs` | WebView2 PrintToPdf, and printing generated pages in a locked-down hidden window |
| `src-tauri/src/ai.rs` | Claude API client: key storage, streaming, cancellation |
| `src/main.ts` | Tabs and documents, editor, preview pipeline, scroll sync, file ops, menus, shortcuts |
| `src/tabs.ts` | Tab strip |
| `src/sidebar.ts`, `src/outline.ts`, `src/search.ts` | Sidebar panels |
| `src/palette.ts` | Quick-open palette and fuzzy matching |
| `src/format.ts`, `src/images.ts` | Formatting shortcuts, image paste |
| `src/ai.ts`, `src/aiedit.ts`, `src/ask.ts`, `src/design.ts` | Claude: client and settings, Ctrl+J edits, Ask panel, page designer |
| `src/rich.ts` | Lazy KaTeX and Mermaid rendering with caches |
| `src/editor-theme.ts` | CodeMirror theme and highlight style |
| `src/styles.css` | Design tokens (light/dark), chrome, preview typography |

## License

MIT. See [LICENSE](LICENSE).
