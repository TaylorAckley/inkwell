//! Claude API access with the user's own API key. The key is kept in Windows
//! Credential Manager and never reaches the web layer: the page asks for a
//! completion, this module makes the HTTPS request and streams the text back
//! as `ai` events.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
/// Server-side fallback: a request declined by a model's safety classifiers
/// is retried on the model Anthropic recommends for that category.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const KEY_SERVICE: &str = "Inkwell";
const KEY_USER: &str = "anthropic-api-key";

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| format!("Credential Manager is unavailable: {e}"))
}

fn api_key() -> Result<String, String> {
    key_entry()?
        .get_password()
        .map_err(|_| "No Claude API key is set. Add one in AI settings.".to_string())
}

#[tauri::command]
pub fn ai_set_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return Err("That doesn't look like an API key.".into());
    }
    key_entry()?.set_password(key).map_err(|e| format!("Could not store the key: {e}"))
}

#[tauri::command]
pub fn ai_has_key() -> bool {
    api_key().is_ok()
}

#[tauri::command]
pub fn ai_clear_key() -> Result<(), String> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the key: {e}")),
    }
}

/// Cancellation flags for streams in flight, by request id.
#[derive(Default)]
pub struct Requests(Mutex<HashMap<u64, Arc<AtomicBool>>>);

#[derive(Deserialize)]
pub struct AiRequest {
    id: u64,
    model: String,
    /// A string or an array of system content blocks (for cache_control).
    system: Value,
    messages: Value,
    max_tokens: u32,
    effort: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AiEvent {
    Text { id: u64, text: String },
    Done { id: u64, stop_reason: Option<String> },
    Error { id: u64, message: String },
}

/// Models that accept `fallbacks: "default"` on the Claude API. Haiku has
/// no server-side fallback, so the parameter is left off its requests.
fn supports_fallback(model: &str) -> bool {
    model.starts_with("claude-opus-5") || model.starts_with("claude-fable-5") || model == "claude-sonnet-5-5"
}

fn request_body(req: &AiRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "system": req.system,
        "messages": req.messages,
    });
    if let Some(effort) = &req.effort {
        body["output_config"] = json!({ "effort": effort });
    }
    if supports_fallback(&req.model) {
        body["fallbacks"] = json!("default");
    }
    body
}

/// A readable message from an API error response.
fn api_error(status: u16, response: ureq::Response) -> String {
    let detail = response
        .into_string()
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["error"]["message"].as_str().map(String::from));
    let hint = match status {
        401 => "The API key was rejected. Check it in AI settings.",
        403 => "This API key isn't allowed to use that model.",
        429 => "Rate limited, or out of credits. Try again shortly, or check billing in the Claude Console.",
        529 => "The Claude API is overloaded. Try again shortly.",
        _ => "",
    };
    match (detail, hint.is_empty()) {
        (Some(d), true) => format!("Claude API error {status}: {d}"),
        (Some(d), false) => format!("{hint}\n\n{d}"),
        (None, true) => format!("Claude API error {status}"),
        (None, false) => hint.to_string(),
    }
}

fn run(app: &AppHandle, key: &str, req: &AiRequest, cancel: &AtomicBool) -> Result<AiEvent, String> {
    let id = req.id;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        // Long thinking pauses are covered by the API's keep-alive pings.
        .timeout_read(Duration::from_secs(120))
        .build();
    let mut call = agent
        .post(API_URL)
        .set("x-api-key", key)
        .set("anthropic-version", API_VERSION)
        .set("content-type", "application/json");
    if supports_fallback(&req.model) {
        call = call.set("anthropic-beta", FALLBACK_BETA);
    }
    let response = match call.send_string(&request_body(req).to_string()) {
        Ok(r) => r,
        Err(ureq::Error::Status(status, r)) => return Err(api_error(status, r)),
        Err(e) => return Err(format!("Could not reach the Claude API: {e}")),
    };

    let stop_reason = read_stream(BufReader::new(response.into_reader()), cancel, |text| {
        let _ = app.emit("ai", AiEvent::Text { id, text });
    })?;
    Ok(AiEvent::Done { id, stop_reason })
}

/// Read a Messages API event stream, passing each piece of text to `on_text`.
/// Returns the stop reason ("cancelled" if `cancel` was set).
fn read_stream(reader: impl BufRead, cancel: &AtomicBool, mut on_text: impl FnMut(String)) -> Result<Option<String>, String> {
    let mut stop_reason = None;
    let mut complete = false;
    for line in reader.lines() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(Some("cancelled".into()));
        }
        let line = line.map_err(|e| format!("The connection to the Claude API was lost: {e}"))?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(event) = serde_json::from_str::<Value>(data.trim_start()) else { continue };
        match event["type"].as_str() {
            // Only text is shown. Thinking deltas are skipped, and a
            // server-side fallback continues on the same stream.
            Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                if let Some(text) = event["delta"]["text"].as_str() {
                    on_text(text.to_string());
                }
            }
            Some("message_delta") => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    stop_reason = Some(reason.to_string());
                }
            }
            Some("message_stop") => complete = true,
            Some("error") => {
                let message = event["error"]["message"].as_str().unwrap_or("The Claude API reported an error");
                return Err(message.to_string());
            }
            _ => {}
        }
    }
    // A connection closed mid-reply would otherwise pass for a short answer.
    if complete {
        Ok(stop_reason)
    } else {
        Err("The connection closed before Claude finished. Try again.".into())
    }
}

/// Start a streamed completion. Text arrives as `ai` events with this id,
/// ending with one `done` or `error` event.
#[tauri::command]
pub fn ai_stream(app: AppHandle, req: AiRequest, requests: State<'_, Requests>) -> Result<(), String> {
    let key = api_key()?;
    let cancel = Arc::new(AtomicBool::new(false));
    requests.0.lock().unwrap().insert(req.id, cancel.clone());
    std::thread::spawn(move || {
        let id = req.id;
        let last = run(&app, &key, &req, &cancel).unwrap_or_else(|message| AiEvent::Error { id, message });
        app.state::<Requests>().0.lock().unwrap().remove(&id);
        let _ = app.emit("ai", last);
    });
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(id: u64, requests: State<'_, Requests>) {
    if let Some(flag) = requests.0.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(model: &str, effort: Option<&str>) -> AiRequest {
        AiRequest {
            id: 1,
            model: model.into(),
            system: json!("sys"),
            messages: json!([{ "role": "user", "content": "hi" }]),
            max_tokens: 1000,
            effort: effort.map(String::from),
        }
    }

    #[test]
    fn opus_gets_fallbacks_and_effort() {
        let body = request_body(&req("claude-opus-5-5", Some("low")));
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["output_config"]["effort"], "low");
        assert_eq!(body["stream"], true);
        // Sampling parameters are rejected on API version 2026-10-21.
        assert!(body.get("temperature").is_none());
    }

    const STREAM: &str = r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5-5"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}

event: ping
data: {"type": "ping"}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":", \"world\"\n"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}

event: message_stop
data: {"type":"message_stop"}
"#;

    #[test]
    fn reads_text_and_stop_reason() {
        let mut text = String::new();
        let stop = read_stream(STREAM.as_bytes(), &AtomicBool::new(false), |t| text.push_str(&t)).unwrap();
        assert_eq!(text, "Hello, \"world\"\n");
        assert_eq!(stop.as_deref(), Some("end_turn"));
    }

    #[test]
    fn reports_stream_errors_and_cancellation() {
        let err = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n";
        assert_eq!(read_stream(err.as_bytes(), &AtomicBool::new(false), |_| {}), Err("Overloaded".into()));
        let stop = read_stream(STREAM.as_bytes(), &AtomicBool::new(true), |_| panic!("no text after cancel")).unwrap();
        assert_eq!(stop.as_deref(), Some("cancelled"));
    }

    #[test]
    fn a_cut_off_stream_is_an_error() {
        let cut = &STREAM[..STREAM.find("event: message_delta").unwrap()];
        assert!(read_stream(cut.as_bytes(), &AtomicBool::new(false), |_| {}).is_err());
    }

    #[test]
    fn haiku_has_no_fallbacks() {
        let body = request_body(&req("claude-haiku-5-5", None));
        assert!(body.get("fallbacks").is_none());
        assert!(body.get("output_config").is_none());
    }
}
