// A small Fluent-style context menu, used for right-click menus and the
// title bar's overflow button. Keyboard: arrows to move, Enter to run, Esc to close.

export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; danger?: boolean; action: () => unknown }
  | "-";

let current: { el: HTMLElement; restoreFocus: Element | null } | null = null;

export function closeMenu() {
  if (!current) return;
  current.el.remove();
  const focus = current.restoreFocus;
  current = null;
  if (focus instanceof HTMLElement) focus.focus({ preventScroll: true });
}

export function showMenu(items: MenuItem[], x: number, y: number) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.setAttribute("role", "menu");

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === "-") {
      if (el.lastElementChild && !el.lastElementChild.classList.contains("ctx-sep")) {
        el.append(Object.assign(document.createElement("div"), { className: "ctx-sep" }));
      }
      continue;
    }
    const b = document.createElement("button");
    b.className = "ctx-item";
    b.setAttribute("role", "menuitem");
    b.disabled = !!item.disabled;
    b.classList.toggle("danger", !!item.danger);
    const label = Object.assign(document.createElement("span"), { textContent: item.label });
    b.append(label);
    if (item.shortcut) {
      b.append(Object.assign(document.createElement("span"), { className: "ctx-key", textContent: item.shortcut }));
    }
    b.addEventListener("click", () => {
      closeMenu();
      void item.action();
    });
    b.addEventListener("pointerenter", () => b.focus({ preventScroll: true }));
    el.append(b);
    buttons.push(b);
  }
  if (el.lastElementChild?.classList.contains("ctx-sep")) el.lastElementChild.remove();

  el.addEventListener("keydown", (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      enabled[(i + step + enabled.length) % enabled.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  });

  document.body.append(el);
  // Keep the menu on screen.
  const r = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 6);
  const top = y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y;
  el.style.left = `${Math.max(6, left)}px`;
  el.style.top = `${top}px`;

  current = { el, restoreFocus: document.activeElement };
  el.focus();
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
}

/** Open a menu anchored below an element (for toolbar buttons). */
export function showMenuAt(items: MenuItem[], anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  showMenu(items, r.right - 240, r.bottom + 4);
}

window.addEventListener("pointerdown", (e) => {
  if (current && !current.el.contains(e.target as Node)) closeMenu();
}, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", closeMenu, true);
