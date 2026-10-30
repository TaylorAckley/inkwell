// Per-machine conveniences (layout, theme, recent files). Storage can be
// unavailable, in which case preferences just don't persist.
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`inkwell.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`inkwell.${key}`, JSON.stringify(value));
    } catch {
      /* not persisted */
    }
  },
};

export function fileName(path: string | null) {
  return path ? path.split(/[\\/]/).pop()! : "Untitled";
}

export function dirName(path: string) {
  return path.replace(/[\\/][^\\/]*$/, "");
}

export function samePath(a: string | null, b: string | null) {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/** True when `path` is `dir` itself or somewhere beneath it. */
export function isInside(path: string, dir: string) {
  const p = path.toLowerCase();
  const d = dir.toLowerCase().replace(/[\\/]+$/, "");
  return p === d || p.startsWith(`${d}\\`) || p.startsWith(`${d}/`);
}

/** `to` relative to the folder `fromDir`, with forward slashes (as markdown links want). */
export function relativePath(fromDir: string, to: string) {
  const a = fromDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  const b = to.split(/[\\/]/);
  if (a[0].toLowerCase() !== b[0].toLowerCase()) return to.replace(/\\/g, "/"); // other drive
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...Array<string>(a.length - i).fill(".."), ...b.slice(i)].join("/") || ".";
}

export function joinPath(dir: string, name: string) {
  return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
}

/** Windows-invalid filename characters, or a reserved trailing dot/space. */
export function invalidName(name: string) {
  return !name.trim() || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name);
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}
