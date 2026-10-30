//! Folder-wide features: the file list behind quick open, text search across
//! the folder, and saving pasted images next to the document.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

const MAX_FILES: usize = 20_000;
const MAX_HITS: usize = 1_000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Lines longer than this are sent as a window around the match.
const MAX_LINE: usize = 600;

/// Every markdown file under `root`, skipping the same folders as the sidebar.
/// Symlinked folders aren't followed, so link cycles can't trap the walk.
fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if crate::skipped(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() && crate::is_markdown(&name) {
                out.push(entry.path());
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out.sort_by_cached_key(|p| p.to_string_lossy().to_lowercase());
    out
}

#[tauri::command]
pub async fn list_markdown(root: PathBuf) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || walk(&root).into_iter().map(|p| p.display().to_string()).collect())
        .await
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct Hit {
    path: String,
    line: usize,
    /// UTF-16 offsets into `text`, matching JavaScript string indexing.
    col: usize,
    len: usize,
    text: String,
    /// UTF-16 offset of `text` within the full line (non-zero for long lines).
    offset: usize,
}

#[derive(Serialize)]
pub struct SearchResult {
    hits: Vec<Hit>,
    files: usize,
    truncated: bool,
}

/// Lowercase without changing any character's UTF-8 length, so byte offsets
/// found in the folded text are valid in the original.
fn fold(s: &str) -> String {
    s.chars()
        .map(|c| {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(l), None) if l.len_utf8() == c.len_utf8() => l,
                _ => c,
            }
        })
        .collect()
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Bumped by every search, so a superseded search stops early.
static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

fn search(root: &Path, query: &str, match_case: bool, generation: u64) -> SearchResult {
    let needle = if match_case { query.to_string() } else { fold(query) };
    let mut hits = Vec::new();
    let mut files = 0;
    for path in walk(root) {
        if SEARCH_GEN.load(Ordering::Relaxed) != generation || hits.len() >= MAX_HITS {
            return SearchResult { hits, files, truncated: true };
        }
        if fs::metadata(&path).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        files += 1;
        let path_str = path.display().to_string();
        for (i, line) in text.lines().enumerate() {
            let hay = if match_case { line.to_string() } else { fold(line) };
            let Some(at) = hay.find(&needle) else { continue };
            let end = at + needle.len();
            let (start, stop) = if line.len() > MAX_LINE {
                (floor_char(line, at.saturating_sub(120)), ceil_char(line, (end + 360).min(line.len())))
            } else {
                (0, line.len())
            };
            hits.push(Hit {
                path: path_str.clone(),
                line: i + 1,
                col: utf16_len(&line[start..at]),
                len: utf16_len(&line[at..end]),
                text: line[start..stop].to_string(),
                offset: utf16_len(&line[..start]),
            });
            if hits.len() >= MAX_HITS {
                break;
            }
        }
    }
    let truncated = hits.len() >= MAX_HITS;
    SearchResult { hits, files, truncated }
}

/// Find `query` in every markdown file under `root` (first match per line).
#[tauri::command]
pub async fn search_folder(root: PathBuf, query: String, match_case: bool) -> SearchResult {
    let generation = SEARCH_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || search(&root, &query, match_case, generation))
        .await
        .unwrap_or(SearchResult { hits: Vec::new(), files: 0, truncated: false })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Save image bytes (the raw request body) as `<x-dir>/assets/<x-name>`,
/// adding a numeric suffix rather than overwriting. Returns the final file name.
#[tauri::command]
pub fn save_image(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected image data".into());
    };
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .ok_or_else(|| format!("Missing {key}"))
    };
    let dir = PathBuf::from(header("x-dir")?);
    let name = header("x-name")?;
    if name.is_empty() || name.contains(['\\', '/', ':']) || name.starts_with('.') {
        return Err(format!("Invalid image name: {name}"));
    }

    let assets = dir.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("Could not create {}: {e}", assets.display()))?;
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name.as_str(), "png"));
    for n in 0..1000 {
        let candidate = if n == 0 { format!("{stem}.{ext}") } else { format!("{stem}-{n}.{ext}") };
        let path = assets.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                return file
                    .write_all(bytes)
                    .map(|_| candidate)
                    .map_err(|e| format!("Could not save {}: {e}", path.display()));
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not save {}: {e}", path.display())),
        }
    }
    Err("Too many images with the same name".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_keeps_byte_offsets() {
        let s = "Straße İstanbul ÅNGSTRÖM";
        assert_eq!(fold(s).len(), s.len());
        assert!(fold(s).contains("ångström"));
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cme%20too"), "C:\\Users\\me too");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn searches_folder() {
        let dir = std::env::temp_dir().join(format!("inkwell-search-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("a.md"), "# Title\nfind the Needle here\n").unwrap();
        fs::write(dir.join("sub").join("b.md"), "no match\nneedle again\n").unwrap();
        fs::write(dir.join("node_modules").join("c.md"), "needle\n").unwrap();
        fs::write(dir.join("d.txt"), "needle\n").unwrap();

        let gen = SEARCH_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        let r = search(&dir, "needle", false, gen);
        assert_eq!(r.hits.len(), 2);
        assert_eq!((r.hits[0].line, r.hits[0].col, r.hits[0].len), (2, 9, 6));
        assert_eq!(r.hits[1].line, 2);
        let r = search(&dir, "needle", true, gen);
        assert_eq!(r.hits.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
