//! File operations and hand-offs to other programs: Explorer, terminals, editors.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

fn err(action: &str, path: &Path, e: impl std::fmt::Display) -> String {
    format!("Could not {action} {}: {e}", path.display())
}

#[tauri::command]
pub async fn create_file(path: PathBuf) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| err("create", &path, e))
}

#[tauri::command]
pub async fn create_dir(path: PathBuf) -> Result<(), String> {
    fs::create_dir(&path).map_err(|e| err("create", &path, e))
}

#[tauri::command]
pub async fn rename_path(from: PathBuf, to: PathBuf) -> Result<(), String> {
    // Allow case-only renames (same file on Windows); refuse to clobber anything else.
    let case_only = from.to_string_lossy().eq_ignore_ascii_case(&to.to_string_lossy());
    if to.exists() && !case_only {
        return Err(format!("{} already exists", to.display()));
    }
    fs::rename(&from, &to).map_err(|e| err("rename", &from, e))
}

/// Move to the Recycle Bin rather than deleting outright.
#[tauri::command]
pub async fn trash_path(path: PathBuf) -> Result<(), String> {
    trash::delete(&path).map_err(|e| err("delete", &path, e))
}

#[tauri::command]
pub fn reveal_path(path: PathBuf) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer needs `/select,"C:\path"` verbatim; normal argument quoting breaks it.
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| err("reveal", &path, e))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Not supported on this platform".into())
    }
}

/// Open a terminal in `dir`: Windows Terminal if present, otherwise PowerShell.
#[tauri::command]
pub fn open_terminal(dir: PathBuf) -> Result<(), String> {
    let wt = Command::new("wt.exe").arg("-d").arg(&dir).spawn();
    if wt.is_ok() {
        return Ok(());
    }
    let mut ps = Command::new("powershell.exe");
    ps.arg("-NoExit").current_dir(&dir);
    #[cfg(windows)]
    ps.creation_flags(CREATE_NEW_CONSOLE);
    ps.spawn().map(|_| ()).map_err(|e| err("open a terminal in", &dir, e))
}

#[derive(Serialize, Clone)]
pub struct Editor {
    pub name: &'static str,
    pub exe: PathBuf,
}

fn known_editors() -> Vec<Editor> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let programs = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| "C:\\Program Files".into());
    [
        ("VS Code", local.join("Programs\\Microsoft VS Code\\Code.exe")),
        ("VS Code", programs.join("Microsoft VS Code\\Code.exe")),
        ("Cursor", local.join("Programs\\cursor\\Cursor.exe")),
        ("Zed", local.join("Programs\\Zed\\Zed.exe")),
        ("Notepad++", programs.join("Notepad++\\notepad++.exe")),
    ]
    .into_iter()
    .filter(|(_, exe)| exe.is_file())
    .fold(Vec::new(), |mut out, (name, exe)| {
        if !out.iter().any(|e: &Editor| e.name == name) {
            out.push(Editor { name, exe });
        }
        out
    })
}

#[tauri::command]
pub fn find_editors() -> Vec<Editor> {
    known_editors()
}

/// Launch one of the detected editors by name. Only detected executables can
/// be started, so this can't be used to run arbitrary programs.
#[tauri::command]
pub fn open_in_editor(name: String, path: PathBuf) -> Result<(), String> {
    let editor = known_editors()
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("{name} is not installed"))?;
    Command::new(&editor.exe)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| err(&format!("open in {name}"), &path, e))
}
