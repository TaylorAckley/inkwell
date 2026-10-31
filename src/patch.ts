// Update the preview by top-level block instead of replacing it wholesale.
// Typing changes one or two blocks; everything else (highlighted code,
// rendered math and diagrams, loaded images) stays as it is, which saves
// the re-render, the image reloads and most of the layout work.
//
// Blocks are compared by their markup with the data-sourcepos attributes
// removed, since line numbers shift for every block after an edit. A block
// only counts as reusable once it has been fully rendered (`settle`), so a
// render that was cut short never leaves a half-enhanced block behind.

const SOURCEPOS = / data-sourcepos="[^"]*"/g;
const keys = new WeakMap<Element, string>();

/** Mark a block as fully rendered from markup with this key. */
export function settle(el: Element, key: string) {
  keys.set(el, key);
}

function positioned(el: Element): Element[] {
  const inner = [...el.querySelectorAll("[data-sourcepos]")];
  return el.hasAttribute("data-sourcepos") ? [el, ...inner] : inner;
}

/** Copy line numbers from a freshly parsed block onto the kept one. False if they don't line up. */
function syncPositions(kept: Element, fresh: Element) {
  const a = positioned(kept);
  const b = positioned(fresh);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pos = b[i].getAttribute("data-sourcepos")!;
    if (a[i].getAttribute("data-sourcepos") !== pos) a[i].setAttribute("data-sourcepos", pos);
  }
  return true;
}

export type Patched = {
  /** Index in `container.children` of the first new block. */
  start: number;
  /** The new blocks, in order, still to be enhanced and settled. */
  inserted: HTMLElement[];
  keys: string[];
};

/**
 * Make `container`'s children match `html`, keeping the unchanged blocks at
 * the start and end and replacing only the run between them.
 */
export function patchBlocks(container: HTMLElement, html: string): Patched {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const next = [...tpl.content.children] as HTMLElement[];
  const nextKeys = next.map((el) => el.outerHTML.replace(SOURCEPOS, ""));
  const old = [...container.children] as HTMLElement[];

  const same = (o: number, n: number) => keys.get(old[o]) === nextKeys[n] && syncPositions(old[o], next[n]);
  let start = 0;
  while (start < old.length && start < next.length && same(start, start)) start++;
  let endOld = old.length;
  let endNew = next.length;
  while (endOld > start && endNew > start && same(endOld - 1, endNew - 1)) {
    endOld--;
    endNew--;
  }

  // Stray text nodes (from an earlier full replace) would otherwise pile up.
  for (const node of [...container.childNodes]) if (node.nodeType !== Node.ELEMENT_NODE) node.remove();
  for (let i = start; i < endOld; i++) old[i].remove();
  const inserted = next.slice(start, endNew);
  const frag = document.createDocumentFragment();
  frag.append(...inserted);
  container.insertBefore(frag, old[endOld] ?? null);
  return { start, inserted, keys: nextKeys.slice(start, endNew) };
}
