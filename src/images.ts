import { invoke } from "@tauri-apps/api/core";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/**
 * The image in a paste, if any. Apps like Word and Excel also put a picture
 * of copied text on the clipboard; when there's text, the text wins.
 */
export function pastedImage(data: DataTransfer | null): File | null {
  if (!data || data.getData("text/plain")) return null;
  for (const item of data.items) {
    if (item.kind === "file" && item.type in EXTENSIONS) return item.getAsFile();
  }
  return null;
}

function timestamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Save an image into `<docDir>/assets/` and return its path relative to the
 * document. Screenshots get a timestamped name; copied files keep theirs.
 */
export async function saveImage(file: File, docDir: string): Promise<string> {
  const original = file.name.replace(/[\\/:*?"<>|]/g, "-").replace(/^\.+/, "");
  const name =
    original && original.toLowerCase() !== "image.png" && /\.[a-z0-9]+$/i.test(original)
      ? original
      : `image-${timestamp()}.${EXTENSIONS[file.type] ?? "png"}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const saved = await invoke<string>("save_image", bytes, {
    headers: { "x-dir": encodeURIComponent(docDir), "x-name": encodeURIComponent(name) },
  });
  return `assets/${saved}`;
}

/** A relative path made safe for a markdown link target. */
export function linkTarget(path: string) {
  return path.replace(/\\/g, "/").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Alt text from a file name: "my-chart.png" → "my chart". */
export function altText(path: string) {
  return (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/[[\]]/g, "");
}
