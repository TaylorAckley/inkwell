export const WELCOME = `# Welcome to Inkwell

A fast markdown editor and viewer. Edit on the left, preview on the right, and the two panes **stay scrolled together**.

## Keyboard

| Shortcut | Action |
| --- | --- |
| \`Ctrl+O\` | Open a file |
| \`Ctrl+S\` / \`Ctrl+Shift+S\` | Save / Save as |
| \`Ctrl+N\` | New document |
| \`Ctrl+B\` | Toggle the sidebar |
| \`Ctrl+1\` \`Ctrl+2\` \`Ctrl+3\` | Edit · Split · Preview |
| \`Ctrl+F\` | Find and replace |
| \`Ctrl+Shift+L\` | Light / dark theme |
| \`Ctrl+=\` \`Ctrl+-\` \`Ctrl+0\` | Zoom |

You can also **drop a .md file** anywhere on the window. If the open file changes on disk, Inkwell reloads it.

## What renders

- [x] GitHub-flavoured tables, task lists, ~~strikethrough~~, footnotes[^1]
- [x] Syntax-highlighted code blocks
- [x] Relative images and links to other \`.md\` files
- [ ] Your next idea

> Raw HTML is allowed, but sanitized, so a file can't run scripts.

\`\`\`rust
fn main() {
    let words = ["fast", "sharp", "simple"];
    for w in words {
        println!("Inkwell is {w}");
    }
}
\`\`\`

## Math and diagrams

Inline math like $e^{i\\pi} + 1 = 0$, or a display block:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

\`\`\`mermaid
flowchart LR
    A[Write] --> B{Happy?}
    B -- yes --> C[Save]
    B -- no --> A
\`\`\`

---

[^1]: Like this one.
`;
