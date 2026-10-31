// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod markdown;
mod pdf;
mod shell;
mod workspace;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// The open documents (one per tab) and the modification time last seen for
/// each. A background thread polls them; polling (rather than OS
/// notifications) copes with editors that save by writing a temp file and
/// renaming it, and costs one metadata call per tab.
#[derive(Default)]
struct Watched(Mutex<HashMap<PathBuf, Option<SystemTime>>>);

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".markdown", ".mdown", ".mkd"].iter().any(|ext| lower.ends_with(ext))
}

/// Dotfiles and build/dependency folders, which the sidebar and search ignore.
fn skipped(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target")
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
    if let Some(seen) = watched.0.lock().unwrap().get_mut(&path) {
        *seen = mtime(&path);
    }
    Ok(())
}

/// Watch exactly `paths` for external changes. Files already watched keep
/// their last-seen time, so a change made in the meantime is still reported.
#[tauri::command]
fn watch_files(paths: Vec<PathBuf>, watched: State<'_, Watched>) {
    let mut map = watched.0.lock().unwrap();
    let old = std::mem::take(&mut *map);
    for path in paths {
        let seen = old.get(&path).copied().unwrap_or_else(|| mtime(&path));
        map.insert(path, seen);
    }
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
            if skipped(&name) {
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

/// `inkwell --html-to-pdf <in.html> <out.pdf>`: print a page and exit, with
/// exit code 0 on success. Uses the same path as the in-app PDF export.
fn html_to_pdf_args() -> Option<(String, String)> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--html-to-pdf")?;
    Some((args.get(i + 1)?.clone(), args.get(i + 2)?.clone()))
}

fn main() {
    let print_job = html_to_pdf_args();
    let headless = print_job.is_some();
    let mut builder = tauri::Builder::default();
    if print_job.is_none() {
        // Must be registered first. A second launch (e.g. double-clicking
        // another .md file) hands its file to this window and exits.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(path) = argv.iter().skip(1).find(|a| !a.starts_with('-')) {
                let _ = app.emit("open-file", path.clone());
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watched::default())
        .manage(ai::Requests::default())
        .setup(move |app| {
            if let Some((input, output)) = print_job.clone() {
                // Headless: no editor window, so nothing touches the user's session.
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.destroy();
                }
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = match fs::read_to_string(&input) {
                        Ok(html) => {
                            let base = Path::new(&input).parent().map(|p| p.display().to_string());
                            pdf::print_html(&handle, &html, base.as_deref(), output).await
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    if let Err(e) = &result {
                        eprintln!("{e}");
                    }
                    handle.exit(if result.is_ok() { 0 } else { 1 });
                });
                return Ok(());
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(700));
                let mut changed = Vec::new();
                {
                    let state = handle.state::<Watched>();
                    let mut map = state.0.lock().unwrap();
                    for (path, seen) in map.iter_mut() {
                        let now = mtime(path);
                        // A missing file (mid-rename, or deleted) isn't a change we can act on.
                        if now.is_some() && now != *seen {
                            *seen = now;
                            changed.push(path.display().to_string());
                        }
                    }
                }
                for path in changed {
                    let _ = handle.emit("file-changed", path);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            render_markdown,
            read_file,
            write_file,
            watch_files,
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
            pdf::export_pdf,
            pdf::export_html_pdf,
            ai::ai_set_key,
            ai::ai_has_key,
            ai::ai_clear_key,
            ai::ai_stream,
            ai::ai_cancel,
            workspace::list_markdown,
            workspace::search_folder,
            workspace::save_image
        ])
        .build(tauri::generate_context!())
        .expect("error while running Inkwell")
        .run(move |_app, event| {
            // A print job closes the editor window at once; stay alive until
            // the job calls exit itself (which passes an exit code).
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                if headless {
                    api.prevent_exit();
                }
            }
        });
}
