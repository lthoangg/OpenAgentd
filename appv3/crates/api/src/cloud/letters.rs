//! Done / Needs you / Failed on the person's phone (spec section 6): each
//! notification this server raises is sealed to every phone of the account
//! (the signers, in v1) and left in its mailbox. The cloud forwards it as a
//! push it cannot read; the phone's Notification Service Extension opens it.
//!
//! Only the text a local notification shows is sent: the status, the
//! workspace name and the session title, clamped to one line.

use std::sync::{Arc, RwLock};

use openagentd_cloud::api::Cloud;
use openagentd_cloud::letter::{self, Context, Kind, Text};
use openagentd_cloud::roster::Roster;
use serde_json::Value;

/// The kind of a `desktop_notification` payload, or `None` to skip it.
pub fn kind_of(payload: &Value) -> Option<Kind> {
    match payload["kind"].as_str()? {
        "input_needed" => Some(Kind::NeedsYou),
        "assistant_done" if payload["title"].as_str().is_some_and(|t| t.starts_with("Failed")) => Some(Kind::Failed),
        "assistant_done" => Some(Kind::Done),
        _ => None,
    }
}

fn clamp(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// `J` for a notification payload; long text is cut so it fits a letter.
pub fn text_of(payload: &Value, now_ms: u64) -> Text {
    let session = payload["session_id"].as_str().filter(|s| collapse_ok(s)).map(str::to_string);
    let mut t = Text { v: 1, title: clamp(payload["title"].as_str().unwrap_or("OpenAgentd"), 120), body: clamp(payload["body"].as_str().unwrap_or(""), 600), session, at: now_ms };
    // The largest letter holds 1,998 bytes of `J`; wide characters can
    // need more than the character limits allow.
    while serde_json::to_vec(&t).map_or(0, |j| j.len()) > letter::SIZES[3] - 50 {
        let n = t.body.chars().count();
        if n > 1 {
            t.body = clamp(&t.body, n * 3 / 4);
        } else if t.title.chars().count() > 1 {
            t.title = clamp(&t.title, t.title.chars().count() * 3 / 4);
        } else {
            break;
        }
    }
    t
}

/// The `collapse` key the cloud sees: one per session, so a newer
/// notification replaces the older one, without telling the cloud the
/// session id (which stays inside the sealed letter).
pub fn collapse_key(sender: &str, session: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("agentd-collapse-v1\n{sender}\n{session}").as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn collapse_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The phones to tell: the account's signers other than this server.
fn recipients(roster: &Roster, me: &str) -> Vec<(String, [u8; 32])> {
    roster.body.devices.iter().filter(|d| d.signer && d.id != me).map(|d| (d.id.clone(), d.box_key())).collect()
}

/// Runs while the host is connected: forwards each notification.
pub async fn run(cloud: Arc<Cloud>, roster: Arc<RwLock<Roster>>) {
    let mut tap = appv3_agent::broadcaster::broadcaster().tap("desktop_notification");
    while let Some(payload) = tap.recv().await {
        let Some(kind) = kind_of(&payload) else { continue };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let text = text_of(&payload, now);
        let (account, to) = {
            let Ok(r) = roster.read() else { continue };
            (r.account_id().to_string(), recipients(&r, &cloud.device_id()))
        };
        let me = cloud.device_id();
        for (id, box_key) in to {
            let ctx = Context { account_id: &account, sender_id: &me, recipient_id: &id, kind };
            let sealed = match letter::seal(&cloud.keys.r#box, &box_key, &ctx, &text) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("cloud_letter_seal_failed error={e}");
                    continue;
                }
            };
            let collapse = text.session.as_deref().map(|s| collapse_key(&me, s));
            if let Err(e) = cloud.send_letter(&id, kind, &sealed, collapse.as_deref()).await {
                tracing::info!("cloud_letter_not_sent status={} code={}", e.status, e.code);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notifications_map_to_letter_kinds() {
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Done · api"})), Some(Kind::Done));
        assert_eq!(kind_of(&json!({"kind": "assistant_done", "title": "Failed · api"})), Some(Kind::Failed));
        assert_eq!(kind_of(&json!({"kind": "input_needed", "title": "Needs you · api"})), Some(Kind::NeedsYou));
        assert_eq!(kind_of(&json!({"kind": "something_else"})), None);
    }

    #[test]
    fn text_fits_the_largest_letter() {
        for long in ["x".repeat(5000), "😀".repeat(5000), "\"".repeat(5000)] {
            let t = text_of(&json!({"title": long, "body": long, "session_id": "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"}), 1);
            let j = serde_json::to_vec(&t).unwrap();
            assert!(j.len() + 2 <= 2048 - 48, "{}", j.len());
            assert_eq!(t.session.as_deref(), Some("0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
            let keys = openagentd_cloud::keys::DeviceKeys::generate();
            let to = openagentd_cloud::keys::DeviceKeys::generate();
            let ctx = Context { account_id: "a", sender_id: "s", recipient_id: "r", kind: Kind::Done };
            assert!(letter::seal(&keys.r#box, &to.r#box.public(), &ctx, &t).is_ok());
        }
        let t = text_of(&json!({"title": "Done", "session_id": "not a collapse key!"}), 1);
        assert_eq!(t.session, None);
    }

    #[test]
    fn the_collapse_key_hides_the_session_id() {
        let k = collapse_key("D1", "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10");
        assert_eq!(k.len(), 32);
        assert!(collapse_ok(&k) && !k.contains("0e6c5a0c"));
        assert_eq!(k, collapse_key("D1", "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
        assert_ne!(k, collapse_key("D2", "0e6c5a0c-1f7e-4a3c-9a55-3b7a2c1d9e10"));
    }
}
