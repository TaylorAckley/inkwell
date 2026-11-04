// Self-update from GitHub Releases. Updates download quietly in the
// background; installing waits until the user picks Restart.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { reportError, toast } from "./actions";

const CHECK_EVERY = 6 * 60 * 60 * 1000;

let ready: Update | null = null;
let busy = false;

/**
 * Check for a newer release and download it. `quiet` skips the "up to date"
 * and error messages, for the automatic checks.
 */
async function update(beforeInstall: () => Promise<boolean>, quiet: boolean) {
  if (ready) return showNotice(ready, beforeInstall);
  if (busy) return;
  busy = true;
  try {
    const found = await check();
    if (!found) {
      if (!quiet) toast("Inkwell is up to date");
      return;
    }
    if (!quiet) toast(`Downloading Inkwell ${found.version}…`);
    await found.download();
    ready = found;
    showNotice(found, beforeInstall);
  } catch (err) {
    if (!quiet) reportError(`Couldn't check for updates: ${err}`);
  } finally {
    busy = false;
  }
}

function showNotice(found: Update, beforeInstall: () => Promise<boolean>) {
  document.getElementById("update-notice")?.remove();
  const el = Object.assign(document.createElement("div"), { id: "update-notice" });
  el.setAttribute("role", "status");
  const text = Object.assign(document.createElement("span"), { textContent: `Inkwell ${found.version} is ready` });
  const later = Object.assign(document.createElement("button"), { className: "btn", textContent: "Later" });
  const restart = Object.assign(document.createElement("button"), { className: "btn primary", textContent: "Restart" });
  later.addEventListener("click", () => el.remove());
  restart.addEventListener("click", async () => {
    if (!(await beforeInstall())) return;
    // The installer closes Inkwell, updates it and starts it again.
    found.install().catch(reportError);
  });
  el.append(text, later, restart);
  document.body.append(el);
}

/**
 * Start checking in the background. `beforeInstall` saves or discards unsaved
 * work and returns false if the user cancels. Returns a manual check for the
 * command palette.
 */
export function startUpdates(beforeInstall: () => Promise<boolean>) {
  if (import.meta.env.DEV) return () => toast("Updates are off in development builds");
  const auto = () => void update(beforeInstall, true);
  setTimeout(auto, 10_000);
  setInterval(auto, CHECK_EVERY);
  return () => void update(beforeInstall, false);
}
