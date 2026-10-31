//! PDF export through WebView2's native PrintToPdf. The page's print
//! stylesheet decides what ends up on paper (just the rendered document).

use std::fs;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

type Outcome = Result<(), String>;

#[tauri::command]
pub async fn export_pdf(window: WebviewWindow, path: String) -> Outcome {
    print_window(window, path).await
}

/// Print a standalone HTML page (such as a generated design) to PDF. `base`
/// is the folder relative image paths resolve against.
#[tauri::command]
pub async fn export_html_pdf(app: AppHandle, html: String, base: Option<String>, path: String) -> Outcome {
    print_html(&app, &html, base.as_deref(), path).await
}

/// Lock a generated page down before showing or printing it: no scripts,
/// no network, only inline styles and local or embedded images.
pub fn harden(html: &str, base: Option<&str>) -> String {
    let html = &strip_refresh(html);
    let mut head = String::from(
        r#"<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: file:; font-src data:">"#,
    );
    if let Some(dir) = base.and_then(|b| Url::from_directory_path(b).ok()) {
        head.push_str(&format!(r#"<base href="{dir}">"#));
    }
    // Insert first thing inside <head>, so the policy covers everything after it.
    // (ASCII lowercasing keeps byte offsets; "<header" must not count.)
    let lower = html.to_ascii_lowercase();
    let tag = lower
        .match_indices("<head")
        .map(|(i, _)| i)
        .find(|&i| matches!(lower.as_bytes().get(i + 5), Some(b'>' | b' ' | b'\t' | b'\r' | b'\n')));
    match tag.and_then(|i| lower[i..].find('>').map(|j| i + j + 1)) {
        Some(at) => format!("{}{head}{}", &html[..at], &html[at..]),
        None => format!("<!doctype html><head>{head}</head>{html}"),
    }
}

/// Remove `<meta http-equiv="refresh">` tags, which would navigate the page away.
fn strip_refresh(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut last = 0;
    let mut from = 0;
    while let Some(i) = lower[from..].find("<meta").map(|i| i + from) {
        let Some(end) = lower[i..].find('>').map(|j| i + j + 1) else { break };
        let tag = &lower[i..end];
        if tag.contains("http-equiv") && tag.contains("refresh") {
            out.push_str(&html[last..i]);
            last = end;
        }
        from = end;
    }
    out.push_str(&html[last..]);
    out
}

static PRINT_SEQ: AtomicU32 = AtomicU32::new(1);

pub async fn print_html(app: &AppHandle, html: &str, base: Option<&str>, path: String) -> Outcome {
    let n = PRINT_SEQ.fetch_add(1, Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("inkwell-print-{}-{n}.html", std::process::id()));
    fs::write(&file, harden(html, base)).map_err(|e| format!("Could not prepare the page: {e}"))?;
    let url = Url::from_file_path(&file).map_err(|_| "Could not prepare the page".to_string())?;

    // A hidden window that has no capabilities, so the page can't reach the app.
    let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
    let loaded_tx = Mutex::new(Some(loaded_tx));
    let built = WebviewWindowBuilder::new(app, format!("print-{n}"), WebviewUrl::External(url))
        .visible(false)
        // CSP doesn't govern navigation; never let the page leave its local file.
        .on_navigation(|url| url.scheme() == "file")
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            let _ = fs::remove_file(&file);
            return Err(format!("Could not open the page for printing: {e}"));
        }
    };

    let loaded = tauri::async_runtime::spawn_blocking(move || loaded_rx.recv_timeout(Duration::from_secs(30)).is_ok())
        .await
        .unwrap_or(false);
    let outcome = if loaded { print_window(window.clone(), path).await } else { Err("The page did not finish loading".into()) };
    let _ = window.destroy();
    let _ = fs::remove_file(&file);
    outcome
}

async fn print_window(window: WebviewWindow, path: String) -> Outcome {
    let (tx, rx) = mpsc::channel::<Outcome>();
    window
        .with_webview(move |webview| print_to_pdf(webview, path, tx))
        .map_err(|e| e.to_string())?;

    // with_webview runs on the UI thread and PrintToPdf completes there too,
    // so wait for the result on a blocking worker, never the UI thread.
    tauri::async_runtime::spawn_blocking(move || match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(outcome) => outcome,
        Err(_) => Err("PDF export did not finish".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn print_to_pdf(webview: tauri::webview::PlatformWebview, path: String, tx: mpsc::Sender<Outcome>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let done = tx.clone();
    let started = (|| -> windows_core::Result<()> {
        unsafe {
            let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
            let env: ICoreWebView2Environment6 = webview.environment().cast()?;
            let settings = env.CreatePrintSettings()?;
            settings.SetShouldPrintBackgrounds(true.into())?;
            settings.SetShouldPrintHeaderAndFooter(false.into())?;
            // Inches.
            settings.SetMarginTop(0.6)?;
            settings.SetMarginBottom(0.6)?;
            settings.SetMarginLeft(0.7)?;
            settings.SetMarginRight(0.7)?;

            let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                let outcome = match result {
                    Err(e) => Err(e.message()),
                    Ok(()) if ok => Ok(()),
                    Ok(()) => Err("WebView2 could not write the PDF".into()),
                };
                let _ = done.send(outcome);
                Ok(())
            }));
            core.PrintToPdf(&HSTRING::from(path), &settings, &handler)
        }
    })();
    if let Err(e) = started {
        let _ = tx.send(Err(e.message()));
    }
}

#[cfg(not(windows))]
fn print_to_pdf(_webview: tauri::webview::PlatformWebview, _path: String, tx: mpsc::Sender<Outcome>) {
    let _ = tx.send(Err("PDF export is only implemented on Windows".into()));
}

#[cfg(test)]
mod tests {
    use super::harden;

    #[test]
    fn policy_goes_first_in_head() {
        let out = harden("<!DOCTYPE html><html><HEAD lang=x><title>t</title><script>x()</script></HEAD></html>", None);
        let policy = out.find("Content-Security-Policy").unwrap();
        assert!(policy < out.find("<title>").unwrap());
        assert!(out.contains("default-src 'none'"));
    }

    #[test]
    fn adds_head_and_base_when_missing() {
        let out = harden("<p>hi</p>", Some(r"C:\docs\notes"));
        assert!(out.starts_with("<!doctype html><head>"));
        assert!(out.contains(r#"<base href="file:///C:/docs/notes/">"#));
        assert!(out.ends_with("<p>hi</p>"));
    }

    #[test]
    fn strips_meta_refresh() {
        let out = harden(r#"<html><head><META HTTP-EQUIV="refresh" content="0;url=https://x.test"><meta charset="utf-8"></head></html>"#, None);
        assert!(!out.to_ascii_lowercase().contains("refresh"));
        assert!(out.contains(r#"<meta charset="utf-8">"#));
    }

    #[test]
    fn header_is_not_head() {
        let out = harden("<header>x</header>", None);
        assert!(out.starts_with("<!doctype html><head>"));
    }
}
