import { invoke } from "@tauri-apps/api/core";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { prefs, fileName, dirName, samePath, isInside, joinPath, invalidName } from "./prefs";
import { showMenu, type MenuItem } from "./menu";
import { pathItems, reportError } from "./actions";

type Entry = { name: string; path: string; dir: boolean };

export type SidebarHost = {
  /** Single click opens in the temporary tab; `keep` (double-click) opens a regular one. */
  open(path: string, keep?: boolean): void;
  currentPath(): string | null;
  /** A file or folder moved; `from` may be an ancestor of the open document. */
  renamed(from: string, to: string): void;
  /** A file or folder went to the Recycle Bin. */
  deleted(path: string): void;
};

const MAX_RECENT = 12;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Replace a leading `from` path prefix with `to` (for renamed folders). */
function rebase(path: string, from: string, to: string) {
  return isInside(path, from) ? to + path.slice(from.length) : path;
}

/**
 * Left sidebar: recent files plus a lazily-expanded tree of the current
 * folder, with VS Code-style inline create and rename. The folder follows
 * the open document unless the user picked one and the document is inside it.
 */
export function createSidebar(host: SidebarHost) {
  const body = $("body");
  const recentList = $("recent-list");
  const recentSection = $("recent-section");
  const tree = $("tree");
  const folderLabel = $("folder-name");

  let recent = prefs.get<string[]>("recent", []);
  let root: string | null = prefs.get<string | null>("folder", null);
  let active: string | null = null;
  let expanded = new Set<string>();
  let editing = false; // suppress refreshes while an inline input is open

  function setVisible(on: boolean) {
    body.classList.toggle("sidebar-hidden", !on);
    prefs.set("sidebar", on);
  }
  setVisible(prefs.get("sidebar", true));

  // ---- Recent -------------------------------------------------------------

  function renderRecent() {
    recentList.replaceChildren(
      ...recent.map((path) => {
        const li = document.createElement("li");
        li.className = "sb-item";
        li.classList.toggle("active", samePath(path, active));
        li.title = path;
        li.dataset.path = path;
        const name = document.createElement("span");
        name.className = "sb-name";
        name.textContent = fileName(path);
        const where = document.createElement("span");
        where.className = "sb-meta";
        where.textContent = fileName(dirName(path));
        li.append(name, where);
        li.addEventListener("click", () => host.open(path));
        li.addEventListener("dblclick", () => host.open(path, true));
        return li;
      }),
    );
    recentSection.hidden = recent.length === 0;
  }

  function setRecent(next: string[]) {
    recent = next.slice(0, MAX_RECENT);
    prefs.set("recent", recent);
    renderRecent();
  }

  const addRecent = (path: string) => setRecent([path, ...recent.filter((p) => !samePath(p, path))]);
  const removeRecent = (path: string) => setRecent(recent.filter((p) => !isInside(p, path)));

  recentList.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".sb-item");
    if (!li) return;
    e.preventDefault();
    const path = li.dataset.path!;
    showMenu(
      [
        { label: "Open", action: () => host.open(path, true) },
        { label: "Remove from recent", action: () => removeRecent(path) },
        "-",
        ...pathItems(path, { dir: false, root, doc: host.currentPath() }),
      ],
      e.clientX,
      e.clientY,
    );
  });

  // ---- Folder tree --------------------------------------------------------

  function makeRow(depth: number, dir: boolean, glyph: string) {
    const row = document.createElement("div");
    row.className = `sb-item ${dir ? "is-dir" : "is-file"}`;
    row.setAttribute("role", "treeitem");
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.dataset.depth = String(depth);
    const icon = document.createElement("span");
    icon.className = "glyph sb-icon";
    icon.innerHTML = glyph;
    row.append(icon);
    return row;
  }

  async function renderDir(dir: string, depth: number): Promise<HTMLElement[]> {
    let entries: Entry[];
    try {
      entries = await invoke<Entry[]>("list_dir", { path: dir });
    } catch {
      return [];
    }
    const rows: HTMLElement[] = [];
    for (const e of entries) {
      const isOpen = e.dir && expanded.has(e.path);
      const row = makeRow(depth, e.dir, e.dir ? (isOpen ? "&#xE70D;" : "&#xE76C;") : "&#xE8A5;");
      row.title = e.path;
      row.dataset.path = e.path;
      row.dataset.dir = String(e.dir);
      const name = document.createElement("span");
      name.className = "sb-name";
      name.textContent = e.name;
      row.append(name);
      rows.push(row);

      if (e.dir) {
        row.setAttribute("aria-expanded", String(isOpen));
        row.addEventListener("click", () => {
          if (expanded.has(e.path)) expanded.delete(e.path);
          else expanded.add(e.path);
          void refresh();
        });
        if (isOpen) rows.push(...(await renderDir(e.path, depth + 1)));
      } else {
        row.classList.toggle("active", samePath(e.path, active));
        row.addEventListener("click", () => host.open(e.path));
        row.addEventListener("dblclick", () => host.open(e.path, true));
      }
    }
    return rows;
  }

  let refreshSeq = 0;
  async function refresh() {
    if (editing) return;
    const seq = ++refreshSeq;
    $<HTMLButtonElement>("btn-new-file").disabled = !root;
    if (!root) {
      folderLabel.textContent = "No folder";
      tree.replaceChildren();
      return;
    }
    folderLabel.textContent = fileName(root);
    folderLabel.title = root;
    const rows = await renderDir(root, 0);
    if (seq !== refreshSeq || editing) return;
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sb-empty";
      empty.textContent = "No documents here";
      tree.replaceChildren(empty);
    } else {
      tree.replaceChildren(...rows);
    }
  }

  function setRoot(dir: string, explicit: boolean) {
    root = dir;
    if (explicit) prefs.set("folder", dir);
    void refresh();
  }

  // ---- Inline create / rename --------------------------------------------

  /**
   * Show an editable row. Enter commits, Esc cancels, clicking away commits.
   * `commit` returns false to keep the input open (e.g. invalid name).
   */
  function inlineInput(opts: {
    place: (row: HTMLElement) => void;
    depth: number;
    dir: boolean;
    initial: string;
    commit: (name: string) => Promise<boolean>;
    cleanup?: () => void;
  }) {
    editing = true;
    const row = makeRow(opts.depth, opts.dir, opts.dir ? "&#xE8B7;" : "&#xE8A5;");
    row.classList.add("sb-editing");
    const input = document.createElement("input");
    input.className = "sb-input";
    input.value = opts.initial;
    input.spellcheck = false;
    row.append(input);
    opts.place(row);
    input.focus();
    const dot = opts.dir ? -1 : opts.initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : opts.initial.length);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      editing = false;
      row.remove();
      opts.cleanup?.();
      void refresh();
    };
    const tryCommit = async () => {
      const name = input.value.trim();
      if (!name || name === opts.initial) return finish();
      if (invalidName(name)) {
        input.classList.add("invalid");
        input.title = 'Names can\'t contain \\ / : * ? " < > | or end with a dot or space';
        return;
      }
      if (await opts.commit(name)) finish();
    };
    input.addEventListener("input", () => input.classList.remove("invalid"));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void tryCommit();
      else if (e.key === "Escape") finish();
    });
    input.addEventListener("blur", () => void tryCommit().then(() => finished || finish()));
  }

  /** Where new items go: the folder itself, or the parent of a file. */
  async function createIn(dir: string, kind: "file" | "folder") {
    if (!samePath(dir, root)) expanded.add(dir);
    await refresh();
    const parentRow = tree.querySelector<HTMLElement>(`.sb-item[data-path="${CSS.escape(dir)}"]`);
    const depth = parentRow ? Number(parentRow.dataset.depth) + 1 : 0;
    inlineInput({
      depth,
      dir: kind === "folder",
      initial: kind === "folder" ? "New folder" : "untitled.md",
      place: (row) => (parentRow ? parentRow.after(row) : tree.prepend(row)),
      commit: async (name) => {
        const finalName = kind === "file" && !/\.[a-z0-9]+$/i.test(name) ? `${name}.md` : name;
        const path = joinPath(dir, finalName);
        try {
          await invoke(kind === "file" ? "create_file" : "create_dir", { path });
        } catch (err) {
          reportError(err);
          return false;
        }
        if (kind === "folder") expanded.add(path);
        else queueMicrotask(() => host.open(path, true));
        return true;
      },
    });
  }

  function startRename(path: string) {
    const row = tree.querySelector<HTMLElement>(`.sb-item[data-path="${CSS.escape(path)}"]`);
    if (!row) return;
    row.hidden = true;
    inlineInput({
      depth: Number(row.dataset.depth),
      dir: row.dataset.dir === "true",
      initial: fileName(path),
      place: (r) => row.after(r),
      cleanup: () => (row.hidden = false),
      commit: async (name) => {
        const to = joinPath(dirName(path), name);
        try {
          await invoke("rename_path", { from: path, to });
        } catch (err) {
          reportError(err);
          return false;
        }
        expanded = new Set([...expanded].map((p) => rebase(p, path, to)));
        setRecent(recent.map((p) => rebase(p, path, to)));
        if (active) active = rebase(active, path, to);
        host.renamed(path, to);
        return true;
      },
    });
  }

  async function remove(path: string, dir: boolean) {
    const ok = await ask(`Move ${dir ? "the folder " : ""}"${fileName(path)}" to the Recycle Bin?`, {
      title: "Inkwell",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    try {
      await invoke("trash_path", { path });
    } catch (err) {
      return reportError(err);
    }
    removeRecent(path);
    host.deleted(path);
    void refresh();
  }

  tree.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!root || editing) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".sb-item[data-path]");
    const doc = host.currentPath();
    let items: MenuItem[];
    if (!row) {
      items = [
        { label: "New file", action: () => createIn(root!, "file") },
        { label: "New folder", action: () => createIn(root!, "folder") },
        { label: "Refresh", action: refresh },
        "-",
        ...pathItems(root, { dir: true, root, doc }),
      ];
    } else {
      const path = row.dataset.path!;
      const dir = row.dataset.dir === "true";
      const target = dir ? path : dirName(path);
      items = [
        ...(dir ? [] : [{ label: "Open", action: () => host.open(path, true) }, "-" as const]),
        { label: "New file", action: () => createIn(target, "file") },
        { label: "New folder", action: () => createIn(target, "folder") },
        "-",
        { label: "Rename", shortcut: "F2", action: () => startRename(path) },
        { label: "Delete", shortcut: "Del", danger: true, action: () => remove(path, dir) },
        "-",
        ...pathItems(path, { dir, root, doc }),
      ];
    }
    showMenu(items, e.clientX, e.clientY);
  });

  // F2 / Delete act on the hovered row, like a lightweight file explorer.
  let hovered: HTMLElement | null = null;
  tree.addEventListener("pointerover", (e) => (hovered = (e.target as HTMLElement).closest(".sb-item[data-path]")));
  tree.addEventListener("pointerleave", () => (hovered = null));
  window.addEventListener("keydown", (e) => {
    if (!hovered || editing || e.ctrlKey || e.altKey) return;
    if (e.key === "F2") {
      e.preventDefault();
      startRename(hovered.dataset.path!);
    } else if (e.key === "Delete" && !(document.activeElement instanceof HTMLElement && document.activeElement.closest(".cm-editor"))) {
      e.preventDefault();
      void remove(hovered.dataset.path!, hovered.dataset.dir === "true");
    }
  });

  /** Called whenever the open document changes. */
  function setActive(path: string | null) {
    active = path;
    if (path) {
      addRecent(path);
      if (!root || !isInside(path, root)) setRoot(dirName(path), false);
      else {
        // Reveal the file by expanding every folder between root and it.
        let dir = dirName(path);
        while (isInside(dir, root) && dir.length > root.length) {
          expanded.add(dir);
          dir = dirName(dir);
        }
        void refresh();
      }
    } else {
      renderRecent();
      void refresh();
    }
  }

  $("btn-open-folder").addEventListener("click", async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: root ?? undefined });
    if (typeof dir === "string") {
      expanded.clear();
      setRoot(dir, true);
    }
  });
  $("btn-new-file").addEventListener("click", () => root && void createIn(root, "file"));

  // Pick up files created or renamed elsewhere when the window regains focus.
  window.addEventListener("focus", () => void refresh());

  renderRecent();
  void refresh();

  return {
    setActive,
    removeRecent,
    refresh,
    root: () => root,
    recent: () => recent,
    visible: () => !body.classList.contains("sidebar-hidden"),
    show: () => setVisible(true),
    /** New file in the sidebar folder (or the open file's folder). */
    newFileHere: () => {
      const dir = root ?? (host.currentPath() ? dirName(host.currentPath()!) : null);
      if (!dir) return false;
      if (!root) setRoot(dir, false);
      setVisible(true);
      void createIn(dir, "file");
      return true;
    },
    toggle: () => setVisible(body.classList.contains("sidebar-hidden")),
  };
}
