// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod markdown;
mod pdf;
mod shell;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// The open document and the modification time we last saw for it.
/// A background thread polls it; polling (rather than OS notifications)
/// copes with editors that save by writing a temp file and renaming it.
#[derive(Default)]
struct Watched(Mutex<Option<(PathBuf, Option<SystemTime>)>>);

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".markdown", ".mdown", ".mkd"].iter().any(|ext| lower.ends_with(ext))
}

/// Render markdown to sanitized HTML. Runs off the main thread (async command)
/// so large documents never stall window events.
#[tauri::command]
async fn render_markdown(source: String) -> String {
    markdown::render(&source)
}

#[tauri::command]
async fn read_file(path: PathBuf) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// Write via a temp file + rename so a crash mid-save never truncates the document.
#[tauri::command]
async fn write_file(path: PathBuf, contents: String, watched: State<'_, Watched>) -> Result<(), String> {
    let mut tmp = path.clone().into_os_string();
    tmp.push(".inkwell-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("Could not save {}: {e}", path.display())
        })?;

    // Record our own write so the watcher doesn't report it as an external change.
    if let Some((p, seen)) = watched.0.lock().unwrap().as_mut() {
        if *p == path {
            *seen = mtime(&path);
        }
    }
    Ok(())
}

/// Start watching `path` for external changes (or stop, with `None`).
#[tauri::command]
fn watch_file(path: Option<PathBuf>, watched: State<'_, Watched>) {
    *watched.0.lock().unwrap() = path.map(|p| {
        let seen = mtime(&p);
        (p, seen)
    });
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    dir: bool,
}

/// Subfolders and markdown files in `path`, folders first, skipping dotfiles
/// and build/dependency folders.
#[tauri::command]
async fn list_dir(path: PathBuf) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("Could not list {}: {e}", path.display()))?;
    let mut out: Vec<DirEntry> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target") {
                return None;
            }
            let dir = e.file_type().ok()?.is_dir();
            if !dir && !is_markdown(&name) {
                return None;
            }
            Some(DirEntry { path: e.path().display().to_string(), name, dir })
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// The file passed on the command line (e.g. "Open with Inkwell" from Explorer).
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-'))
}

fn main() {
    tauri::Builder::default()
        // Must be registered first. A second launch (e.g. double-clicking
        // another .md file) hands its file to this window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(path) = argv.iter().skip(1).find(|a| !a.starts_with('-')) {
                let _ = app.emit("open-file", path.clone());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watched::default())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(700));
                let changed = {
                    let state = handle.state::<Watched>();
                    let mut guard = state.0.lock().unwrap();
                    match guard.as_mut() {
                        Some((path, seen)) => {
                            let now = mtime(path);
                            // A missing file (mid-rename, or deleted) isn't a change we can act on.
                            if now.is_some() && now != *seen {
                                *seen = now;
                                Some(path.display().to_string())
                            } else {
                                None
                            }
                        }
                        None => None,
                    }
                };
                if let Some(path) = changed {
                    let _ = handle.emit("file-changed", path);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            render_markdown,
            read_file,
            write_file,
            watch_file,
            list_dir,
            initial_file,
            shell::create_file,
            shell::create_dir,
            shell::rename_path,
            shell::trash_path,
            shell::reveal_path,
            shell::open_terminal,
            shell::find_editors,
            shell::open_in_editor,
            pdf::export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inkwell");
}
