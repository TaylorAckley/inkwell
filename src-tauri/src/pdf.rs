//! PDF export through WebView2's native PrintToPdf. The page's print
//! stylesheet decides what ends up on paper (just the rendered document).

use std::sync::mpsc;
use std::time::Duration;

type Outcome = Result<(), String>;

#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Outcome {
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
