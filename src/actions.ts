import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import type { MenuItem } from "./menu";
import { copyText, dirName, fileName, isInside, relativePath, samePath } from "./prefs";

type Editor = { name: string; exe: string };
let editors: Editor[] = [];

/** Detect installed editors once at startup for the "Open in…" items. */
export async function loadEditors() {
  try {
    editors = await invoke<Editor[]>("find_editors");
  } catch {
    editors = [];
  }
}

export function reportError(err: unknown) {
  void message(String(err), { title: "Inkwell", kind: "error" });
}

let toastTimer = 0;
/** Brief confirmation pill at the bottom of the window. */
export function toast(text: string) {
  let el = document.getElementById("toast");
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "toast" });
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 1600);
}

/** Copy text and confirm with a toast naming what was copied. */
export function copy(text: string, what: string) {
  copyText(text).then(() => toast(`Copied ${what}`), reportError);
}

/** Fire-and-forget a backend command, surfacing failures in a dialog. */
export function run(cmd: string, args: Record<string, unknown>) {
  invoke(cmd, args).catch(reportError);
}

/** Installed editors, for menus that build their own "Open in…" items. */
export function editorItems(path: string): MenuItem[] {
  return editors.map((e) => ({ label: `Open in ${e.name}`, action: () => run("open_in_editor", { name: e.name, path }) }));
}

/**
 * The "copy / reveal / open in" items shared by every menu that refers to a
 * path: sidebar rows, recent files and the title bar.
 */
export function pathItems(path: string, opts: { dir: boolean; root: string | null; doc: string | null }): MenuItem[] {
  const name = fileName(path);
  const items: MenuItem[] = [{ label: "Copy path", action: () => copy(path, "path") }];
  if (opts.root && isInside(path, opts.root) && !samePath(path, opts.root)) {
    items.push({ label: "Copy relative path", action: () => copy(relativePath(opts.root!, path), "relative path") });
  }
  items.push({
    label: opts.dir ? "Copy folder name" : "Copy filename",
    action: () => copy(name, opts.dir ? "folder name" : "filename"),
  });
  if (!opts.dir && opts.doc && !samePath(path, opts.doc)) {
    const link = relativePath(dirName(opts.doc), path).replace(/ /g, "%20");
    const title = name.replace(/\.[^.]+$/, "");
    items.push({ label: "Copy markdown link", action: () => copy(`[${title}](${link})`, "markdown link") });
  }
  items.push(
    "-",
    { label: "Reveal in File Explorer", action: () => run("reveal_path", { path }) },
    { label: "Open terminal here", action: () => run("open_terminal", { dir: opts.dir ? path : dirName(path) }) },
  );
  for (const e of editors) {
    if (opts.dir && e.name === "Notepad++") continue; // no folder support
    items.push({ label: `Open in ${e.name}`, action: () => run("open_in_editor", { name: e.name, path }) });
  }
  return items;
}
