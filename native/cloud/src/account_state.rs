//! What the cloud's answers mean for a device's account (the API's
//! "Errors" and the relay's close codes).
//!
//! This is the only place that knows the wire names. Everything else uses
//! [`AccountProblem`], so a rename on the wire changes this file only.

use serde::{Deserialize, Serialize};

/// An answer that is about the account or this device, not the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AccountProblem {
    /// Delete account was chosen on the account pages; it can still be
    /// undone there until `deletes_at` (Unix ms). Keep every key.
    Closing { deletes_at: Option<u64> },
    /// The cloud cannot serve the account for now. Keep every key and
    /// retry now and then (every few minutes at most).
    Unavailable,
    /// The account is gone for good. Forget its keys and roster.
    Deleted,
    /// This device is no longer in the account. Forget its keys.
    Revoked,
}

impl AccountProblem {
    /// Whether the account's keys and roster must be erased.
    pub fn is_terminal(self) -> bool {
        matches!(self, AccountProblem::Deleted | AccountProblem::Revoked)
    }
}

/// Seconds to wait between retries while the account is unavailable.
pub const UNAVAILABLE_RETRY_SECS: u64 = 300;

/// The problem an API error names. `body` is the error's JSON object, for
/// fields such as `deletes_at`.
pub fn from_error(code: &str, body: Option<&serde_json::Value>) -> Option<AccountProblem> {
    match code {
        "account_closing" => Some(AccountProblem::Closing { deletes_at: body.and_then(|b| b.get("deletes_at")).and_then(|v| v.as_u64()) }),
        "account_unavailable" => Some(AccountProblem::Unavailable),
        "account_deleted" => Some(AccountProblem::Deleted),
        // `device_revoked` (403): a removed or departed device's correctly
        // signed request. `revoked` (401): the relay refusing its token.
        "device_revoked" | "revoked" => Some(AccountProblem::Revoked),
        _ => None,
    }
}

/// The problem a relay close code names.
pub fn from_close_code(code: u16) -> Option<AccountProblem> {
    match code {
        4001 => Some(AccountProblem::Revoked),
        4011 => Some(AccountProblem::Closing { deletes_at: None }),
        4012 => Some(AccountProblem::Unavailable),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_map_in_one_place() {
        let body = serde_json::json!({"error": "account_closing", "deletes_at": 1_800_000_000_000u64});
        assert_eq!(from_error("account_closing", Some(&body)), Some(AccountProblem::Closing { deletes_at: Some(1_800_000_000_000) }));
        assert_eq!(from_error("account_unavailable", None), Some(AccountProblem::Unavailable));
        assert_eq!(from_error("account_deleted", None), Some(AccountProblem::Deleted));
        assert_eq!(from_error("device_revoked", None), Some(AccountProblem::Revoked));
        assert_eq!(from_error("revoked", None), Some(AccountProblem::Revoked));
        assert_eq!(from_error("unauthorized", None), None);
        assert!(AccountProblem::Revoked.is_terminal());
        assert_eq!(from_error("rate_limited", None), None);
        assert_eq!(from_close_code(4012), Some(AccountProblem::Unavailable));
        assert_eq!(from_close_code(4011), Some(AccountProblem::Closing { deletes_at: None }));
        assert!(AccountProblem::Deleted.is_terminal() && !AccountProblem::Unavailable.is_terminal());
    }
}
