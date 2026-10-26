//! Home-screen widget snapshot (iOS WidgetKit, Android AppWidget).
//!
//! The web UI sends what the widgets show; this module checks its shape and
//! hands it to the platform store the widgets read: the App Group container
//! on iOS (through the Swift bridge in `mobile/ios-widget/`), SharedPreferences
//! on Android (through the `android-plugin/`). Unknown fields are refused, so
//! nothing else (a server address, an access key) can ride along into storage
//! another process reads.

use serde::{Deserialize, Serialize};

/// Rows the medium inbox widget shows.
pub const INBOX_LIMIT: usize = 3;
/// Longest text a widget renders; anything longer is cut, not refused.
const MAX_TEXT_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WidgetSessionState {
    NeedsInput,
    Running,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetSession {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub state: WidgetSessionState,
    pub last_message_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetTask {
    pub id: String,
    pub name: String,
    pub next_fire_at: String,
    pub last_run_at: Option<String>,
    pub last_run_ok: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetSnapshot {
    pub updated_at: String,
    pub last_session: Option<WidgetSession>,
    pub inbox: Vec<WidgetSession>,
    pub next_task: Option<WidgetTask>,
}

fn clip(text: &mut String) {
    if let Some((cut, _)) = text.char_indices().nth(MAX_TEXT_CHARS) {
        text.truncate(cut);
    }
}

fn clip_opt(text: &mut Option<String>) {
    if let Some(text) = text {
        clip(text);
    }
}

fn clip_session(session: &mut WidgetSession) {
    clip(&mut session.id);
    clip(&mut session.title);
    clip_opt(&mut session.workspace);
    clip_opt(&mut session.last_message_at);
}

impl WidgetSnapshot {
    /// Bound what reaches widget storage: at most [`INBOX_LIMIT`] rows and
    /// [`MAX_TEXT_CHARS`] per field.
    pub fn normalized(mut self) -> Self {
        self.inbox.truncate(INBOX_LIMIT);
        clip(&mut self.updated_at);
        self.last_session.iter_mut().for_each(clip_session);
        self.inbox.iter_mut().for_each(clip_session);
        if let Some(task) = &mut self.next_task {
            clip(&mut task.id);
            clip(&mut task.name);
            clip(&mut task.next_fire_at);
            clip_opt(&mut task.last_run_at);
        }
        self
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("Encode widget snapshot: {e}"))
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use std::ffi::{c_char, CString};

    extern "C" {
        /// `mobile/ios-widget/App/WidgetBridge.swift`, compiled into the app
        /// target by `scripts/patch-ios-widget.sh`.
        fn openagentd_widget_write(json: *const c_char) -> bool;
    }

    pub fn write(json: &str) -> Result<(), String> {
        let json =
            CString::new(json).map_err(|_| "Widget snapshot contains a NUL byte".to_string())?;
        // SAFETY: the bridge only reads the NUL-terminated string for the
        // duration of the call.
        if unsafe { openagentd_widget_write(json.as_ptr()) } {
            Ok(())
        } else {
            Err("Widget storage is unavailable (no App Group)".to_string())
        }
    }
}

/// Store `snapshot` where this platform's widgets read it and ask them to
/// redraw. A no-op on platforms without widgets. Blocks on the platform call
/// (JNI on Android); call it off the async workers.
pub fn publish<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    snapshot: WidgetSnapshot,
) -> Result<(), String> {
    store(app, &snapshot.normalized().to_json()?)
}

#[cfg(target_os = "ios")]
fn store<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, json: &str) -> Result<(), String> {
    ios::write(json)
}

#[cfg(target_os = "android")]
fn store<R: tauri::Runtime>(app: &tauri::AppHandle<R>, json: &str) -> Result<(), String> {
    use tauri_plugin_openagentd_android::AndroidShellExt;
    app.android_shell().update_widgets(json)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn store<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _json: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "title": format!("Session {id}"),
            "workspace": "repo",
            "state": "needs_input",
            "lastMessageAt": "2026-10-25T12:00:00Z",
        })
    }

    fn snapshot(inbox: Vec<serde_json::Value>) -> serde_json::Value {
        json!({
            "updatedAt": "2026-10-25T12:00:00Z",
            "lastSession": row("a"),
            "inbox": inbox,
            "nextTask": {
                "id": "t1",
                "name": "Nightly",
                "nextFireAt": "2026-10-26T00:00:00Z",
                "lastRunAt": null,
                "lastRunOk": null,
            },
        })
    }

    #[test]
    fn accepts_the_snapshot_the_web_ui_sends() {
        let parsed: WidgetSnapshot = serde_json::from_value(snapshot(vec![row("a")])).unwrap();
        assert_eq!(parsed.inbox[0].state, WidgetSessionState::NeedsInput);
        assert_eq!(parsed.next_task.unwrap().name, "Nightly");
    }

    /// Widget storage is readable by another process (the widget extension);
    /// nothing but the widget fields may reach it.
    #[test]
    fn refuses_fields_the_widgets_do_not_use() {
        let mut value = snapshot(vec![]);
        value["accessKey"] = json!("secret");
        assert!(serde_json::from_value::<WidgetSnapshot>(value).is_err());

        let mut value = snapshot(vec![]);
        value["lastSession"]["serverUrl"] = json!("http://10.0.0.2:4082");
        assert!(serde_json::from_value::<WidgetSnapshot>(value).is_err());
    }

    #[test]
    fn refuses_an_unknown_session_state() {
        let mut value = snapshot(vec![row("a")]);
        value["inbox"][0]["state"] = json!("exploding");
        assert!(serde_json::from_value::<WidgetSnapshot>(value).is_err());
    }

    #[test]
    fn keeps_at_most_three_inbox_rows_and_cuts_long_text() {
        let mut long = row("d");
        long["title"] = json!("é".repeat(500));
        let parsed: WidgetSnapshot =
            serde_json::from_value(snapshot(vec![long, row("b"), row("c"), row("e")])).unwrap();
        let normalized = parsed.normalized();

        assert_eq!(normalized.inbox.len(), INBOX_LIMIT);
        assert_eq!(normalized.inbox[0].title.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(normalized.inbox[2].id, "c");
    }

    #[test]
    fn round_trips_in_the_shape_the_widgets_read() {
        let parsed: WidgetSnapshot = serde_json::from_value(snapshot(vec![row("a")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&parsed.normalized().to_json().unwrap()).unwrap();
        assert_eq!(written, snapshot(vec![row("a")]));
    }
}
