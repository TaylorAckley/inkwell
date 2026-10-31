// The tab strip above the editor. It only draws tabs and reports clicks,
// drags and menus; main.ts owns the documents behind them.

export type TabInfo = {
  id: number;
  name: string;
  /** Parent folder, shown when two open files share a name. */
  hint: string;
  /** Tooltip: the full path. */
  title: string;
  dirty: boolean;
  /** A temporary tab, replaced by the next file opened with a single click. */
  preview: boolean;
  active: boolean;
};

export type TabHost = {
  activate(id: number): void;
  close(id: number): void;
  /** Turn a preview tab into a regular one. */
  keep(id: number): void;
  move(id: number, toIndex: number): void;
  menu(id: number, e: MouseEvent): void;
};

const DRAG_THRESHOLD = 5;

export function createTabStrip(bar: HTMLElement, host: TabHost) {
  function tabAt(target: EventTarget | null) {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>(".tab");
    return el ? Number(el.dataset.id) : null;
  }

  function render(tabs: TabInfo[]) {
    // One tab needs no strip: it would only repeat the title bar.
    bar.hidden = tabs.length <= 1;
    bar.replaceChildren(
      ...tabs.map((t) => {
        const el = document.createElement("div");
        el.className = "tab";
        el.classList.toggle("active", t.active);
        el.classList.toggle("dirty", t.dirty);
        el.classList.toggle("preview", t.preview);
        el.dataset.id = String(t.id);
        el.title = t.title;
        el.setAttribute("role", "tab");
        el.setAttribute("aria-selected", String(t.active));
        el.append(Object.assign(document.createElement("span"), { className: "tab-name", textContent: t.name }));
        if (t.hint) el.append(Object.assign(document.createElement("span"), { className: "tab-hint", textContent: t.hint }));
        const close = document.createElement("button");
        close.className = "tab-close";
        close.title = t.dirty ? "Unsaved changes — close (Ctrl+W)" : "Close (Ctrl+W)";
        close.innerHTML = '<span class="glyph">&#xE8BB;</span>';
        el.append(close);
        return el;
      }),
    );
    bar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Activate on press (like an IDE), then a horizontal drag reorders.
  let drag: { id: number; startX: number; moving: boolean } | null = null;

  bar.addEventListener("pointerdown", (e) => {
    const id = tabAt(e.target);
    if (id === null) return;
    if (e.button === 1) {
      e.preventDefault(); // no autoscroll; auxclick closes
      return;
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    host.activate(id);
    drag = { id, startX: e.clientX, moving: false };
    bar.setPointerCapture(e.pointerId);
  });

  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moving && Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD) return;
    drag.moving = true;
    const tabs = [...bar.querySelectorAll<HTMLElement>(".tab")];
    const others = tabs.filter((el) => Number(el.dataset.id) !== drag!.id);
    const to = others.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 < e.clientX;
    }).length;
    const from = tabs.findIndex((el) => Number(el.dataset.id) === drag!.id);
    if (to !== from) host.move(drag.id, to);
    bar.querySelector(`.tab[data-id="${drag.id}"]`)?.classList.add("dragging");
  });

  const endDrag = () => {
    drag = null;
    bar.querySelector(".tab.dragging")?.classList.remove("dragging");
  };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);

  bar.addEventListener("click", (e) => {
    const id = tabAt(e.target);
    if (id !== null && (e.target as HTMLElement).closest(".tab-close")) host.close(id);
  });
  bar.addEventListener("auxclick", (e) => {
    const id = tabAt(e.target);
    if (id !== null && e.button === 1) host.close(id);
  });
  // Pressing a tab redraws the strip and captures the pointer, so the
  // double-click lands on the strip itself: find the tab by position.
  bar.addEventListener("dblclick", (e) => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const id = tabAt(hit);
    if (id !== null && !hit?.closest(".tab-close")) host.keep(id);
  });
  bar.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const id = tabAt(e.target);
    if (id !== null) host.menu(id, e);
  });
  // A vertical wheel scrolls the strip sideways when tabs overflow.
  bar.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      bar.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );

  return { render };
}
